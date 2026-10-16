const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret, defineString } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
const { Webhook } = require('svix');

initializeApp();

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
// Resend's own "Signing Secret" for the webhook endpoint below (resendWebhook)
// - from the Resend dashboard once that webhook is added there, not something
// we choose ourselves. Lets us verify a request claiming to be Resend
// actually is, via the Svix library Resend signs webhooks with.
const RESEND_WEBHOOK_SECRET = defineSecret('RESEND_WEBHOOK_SECRET');
// Must be an address on a domain you've verified in Resend, e.g.
// "Vehicle Manager <notifications@yourdealership.com>". Until a domain is
// verified, Resend only lets onboarding@resend.dev deliver, and only to the
// email address on your Resend account - fine for testing, not for real use.
const FROM_EMAIL = defineString('RESEND_FROM_EMAIL', { default: 'onboarding@resend.dev' });

// Stay well clear of Resend's ~40MB request cap once the file is inflated
// ~33% by base64 encoding.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

// The app's own Hosting URL - used to build the "View Deal" button in Get
// Ready emails (see renderTemplate's getReady branch and ?gr= handling in
// index.html's startApp/getready listener).
const APP_URL = 'https://lot-queue.web.app';

function esc(val) {
  return String(val ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Turns a stored "YYYY-MM-DD" + "HH:MM" pair into one plain-text line like
// "September 9, 2026 at 12:20pm" for the getReady email rows below - mashed
// together and spelled out, instead of the raw ISO date/24h time sitting in
// two separate rows. dateStr alone (no timeStr) still formats, just without
// the "at ..." suffix.
function fmtEmailDateTime(dateStr, timeStr) {
  if (!dateStr) return '';
  const [yr, mo, dy] = dateStr.split('-').map(Number);
  let out = new Date(yr, mo - 1, dy).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  if (timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    const t = new Date(2000, 0, 1, h, m);
    const time = t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(' ', '').toLowerCase();
    out += ` at ${time}`;
  }
  return out;
}

// headerColor/headerLabel let a caller (see the getReady status map below)
// turn the header into a quick-glance status strip instead of just the
// subject repeated - with hundreds of deals a month, "what actually
// happened" needs to read in under a second from the inbox/preview pane,
// not require opening the email and reading the first sentence of the body.
function wrap(title, bodyHtml, headerColor, headerLabel) {
  const labelLine = headerLabel
    ? `<div style="font-size:18px;font-weight:800;letter-spacing:.03em;margin-bottom:4px">${esc(headerLabel)}</div><div style="font-size:13px;font-weight:500;opacity:.85">${esc(title)}</div>`
    : esc(title);
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1a1a1a">
    <div style="max-width:600px;margin:0 auto;padding:24px">
      <div style="background:#fff;border:1px solid #e4e4e7;border-radius:8px;overflow:hidden">
        <div style="background:${headerColor||'#00095b'};color:#fff;padding:16px 24px;${headerLabel?'':'font-size:16px;font-weight:700'}">${labelLine}</div>
        <div style="padding:24px">${bodyHtml}</div>
      </div>
      <div style="text-align:center;color:#a1a1aa;font-size:11px;margin-top:16px">Sent automatically by Vehicle Manager</div>
    </div>
  </body></html>`;
}

// Each field is [label, value] or [label, value, key] - key lets a caller
// (the getReady "updated" email) mark specific rows as changed via
// changedFields, so the exact detail that's different stands out instead of
// making the reader compare the whole table against what they remember.
function fieldRows(fields, changedFields) {
  const changed = new Set(changedFields || []);
  const rows = fields
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value, key]) => {
      const isChanged = key && changed.has(key);
      const rowStyle = isChanged ? 'background:#fef9c3' : '';
      const cellStyle = isChanged ? 'font-weight:700;color:#854d0e' : 'color:#71717a';
      return `<tr style="${rowStyle}"><td style="padding:6px 10px 6px 0;${cellStyle};width:150px;vertical-align:top;white-space:nowrap">${isChanged?'\u{1f536} ':''}${esc(label)}</td><td style="padding:6px 0;white-space:pre-wrap;${isChanged?'font-weight:700;color:#854d0e':''}">${esc(value)}</td></tr>`;
    })
    .join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>`;
}

function renderTemplate(emailType, data) {
  if (emailType === 'getReady') {
    // The header itself now tells the whole story in one glance (color +
    // a plain status word) - with hundreds of these going out a month,
    // nobody should have to open the email and read a sentence of body
    // text just to know whether this is a new deal, an edit, a cancellation
    // or a ready-for-delivery. Checked in this order because a send only
    // ever sets one of these three flags (see sendGetReadyUpdateEmail/
    // sendGRReadyEmail/cancelGR in index.html), but cancelled wins if
    // somehow more than one were ever true.
    const status = data.cancelled ? { color: '#dc2626', label: '❌ DEAL CANCELLED' }
      : data.delivered ? { color: '#0891b2', label: '🥳 VEHICLE DELIVERED' }
      : data.deliveryOverdue ? { color: '#d97706', label: '⏰ DELIVERY OVERDUE' }
      : data.celebrate ? { color: '#7c3aed', label: '🎉 READY FOR DELIVERY' }
      : data.deliveryAssigned ? { color: '#0891b2', label: '🚚 YOU’RE THE DELIVERY PERSON' }
      : data.updateNotice ? { color: '#d97706', label: '🔶 CHANGES MADE TO DEAL' }
      : data.noteAdded ? { color: '#d97706', label: '📝 NOTE ADDED' }
      : { color: '#15803d', label: '🆕 NEW GET READY DEAL' };
    // Note-added email: "X added a note" stands out bold/colored on its own
    // line, with the actual note text below it in a quoted callout - rather
    // than one plain sentence where the note text and the "who did this"
    // part read with equal weight.
    const intro = data.noteAdded
      ? `<p style="margin:0 0 10px;font-size:14px;font-weight:700;color:#92400e">${esc(data.intro)}</p>${data.noteText?`<div style="margin:0 0 16px;padding:12px 14px;background:#fffbeb;border-left:3px solid #d97706;border-radius:4px;font-size:14px;font-style:italic">"${esc(data.noteText)}"</div>`:''}`
      : data.intro ? `<p style="margin:0 0 16px;font-size:14px">${esc(data.intro)}</p>` : '';
    // Jumps straight back to this deal in the app (see openGRDealLink in
    // index.html) - every Get Ready email gets this except cancelled ones,
    // where there's nothing left to go act on. dealId is only ever missing
    // for a grDiffFields() call (diffing only, never actually sent) or an
    // older/odd send path that didn't thread it through.
    const viewDealButton = (data.dealId && !data.cancelled)
      ? `<div style="margin:0 0 20px"><a href="${APP_URL}/?gr=${encodeURIComponent(data.dealId)}" style="display:inline-block;padding:10px 20px;background:#00095b;color:#fff;font-size:13px;font-weight:700;text-decoration:none;border-radius:8px">View Deal →</a></div>`
      : '';
    // Wholesale and Dealer Trade only ever collect a handful of fields (see
    // the app's own type-specific intake form) - each gets its own minimal
    // row list rather than reusing the full Retail list, which would either
    // show a wall of blank/placeholder rows or need every row individually
    // guarded. fieldRows() already drops any row whose value is empty, so
    // whichever of these was actually left blank (e.g. no Deal #) just
    // doesn't appear. The third item in each row is its diff key (see
    // fieldRows/changedFields) - purely for the "updated" email's highlight,
    // harmless on every other send since changedFields is only ever set there.
    // Mashed into one plain-text line ("September 9, 2026 at 12:20pm")
    // instead of the raw ISO date + 24h time sitting in two separate rows -
    // changedFields still only ever carries the 'deliveryDate' key (see
    // grDiffFields in index.html), so a change to either the date or the
    // time alone still highlights this one combined row.
    const deliveryText = fmtEmailDateTime(data.deliveryDate, data.deliveryTime);
    let rows;
    if (data.type === 'WHOLESALE') {
      rows = fieldRows([
        ['Stock #', data.stock, 'stock'], ['Deal #', data.dealNum, 'dealNum'], ['Type', data.type, 'type'],
        ['Auction Company', data.customer, 'customer'], ['Entered By', data.salesperson, 'salesperson'],
        ['Pickup', deliveryText, 'deliveryDate'],
      ], data.changedFields);
    } else if (data.type === 'DEALER TRADE') {
      rows = fieldRows([
        ['Stock #', data.stock, 'stock'], ['Deal #', data.dealNum, 'dealNum'], ['Type', data.type, 'type'],
        ['Purchasing Dealership', data.customer, 'customer'], ['Entered By', data.salesperson, 'salesperson'],
        ['Pickup', deliveryText, 'deliveryDate'],
        ['Trade-In', data.trades, 'trades'],
      ], data.changedFields);
    } else {
      rows = fieldRows([
        ['Stock #', data.stock, 'stock'], ['Deal #', data.dealNum, 'dealNum'], ['Vehicle', data.vehicle, 'vehicle'], ['VIN', data.vin, 'vin'],
        ['Customer', data.customer, 'customer'], ['Salesperson', data.salesperson, 'salesperson'],
        ['Desk Manager', data.deskManager, 'deskManager'], ['F&I Manager', data.fniManager, 'fniManager'],
        ['Delivery Person', data.deliveryPerson, 'deliveryPerson'], ['Type', data.type, 'type'],
        ['Financing', data.financing, 'financing'], ['Delivery', deliveryText, 'deliveryDate'],
        ['Gas/Charge', data.gasStatus, 'gasStatus'], ['Notes', data.notes, 'notes'], ['Services', data.steps, 'steps'],
        ['Trades', data.trades, 'trades'],
      ], data.changedFields);
    }
    // Ready for Delivery only - who actually finished each prep stage and
    // when (see grCompletionSummaryText), so the "it's ready" email doubles
    // as a record of who did the work, not just that it's done.
    const completionRows = (data.celebrate && data.completionSummary)
      ? String(data.completionSummary).split('\n').filter(Boolean).map(line => {
          const [label, ...rest] = line.split(': ');
          return [label, rest.join(': ')];
        })
      : [];
    const completionSection = completionRows.length
      ? `<div style="margin-top:20px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#71717a;margin-bottom:6px">Completed by</div>
          ${fieldRows(completionRows)}
        </div>`
      : '';
    // Only the "deal updated" email - points whoever gets it back to where
    // they actually clear the highlight, since replying to the email itself
    // doesn't do anything.
    const acknowledgeBanner = data.updateNotice
      ? `<div style="margin-top:20px;padding:14px 16px;border-radius:10px;background:#eff6ff;border:1px solid #bfdbfe;text-align:center;font-size:13px;font-weight:600;color:#1d4ed8">The highlighted detail(s) above are what changed - this deal's card is flagged in Vehicle Manager until someone dismisses it.</div>`
      : '';
    return wrap(data.subject || 'Get Ready Deal', intro + viewDealButton + rows + completionSection + acknowledgeBanner, status.color, status.label);
  }
  if (emailType === 'incomingDigest') {
    const lines = String(data.lines || '')
      .split('\n')
      .filter(Boolean)
      .map(line => `<div style="padding:5px 0;border-bottom:1px solid #f4f4f5;font-size:13px">${esc(line)}</div>`)
      .join('');
    return wrap(data.subject || 'Incoming Vehicles', lines || '<p style="font-size:14px">No units.</p>');
  }
  if (emailType === 'dropBatch') {
    return renderDropBatchTable(data.subject || 'Incoming Vehicle Batch', data.units || []);
  }
  if (emailType === 'incomingHistoryClear') {
    // Same table layout as the daily drop batch - it's already built to show
    // exactly this unit shape, and keeping it visually the same means
    // management doesn't have to learn a second report format just for this.
    return renderDropBatchTable(data.subject || 'Incoming History Cleared', data.units || []);
  }
  if (emailType === 'salesArrival') {
    const body = `<p style="margin:0 0 18px;font-size:17px;font-weight:700;color:#00095b">Your vehicle ${esc(data.vehicleDesc || data.stock)} has arrived!</p>
      <p style="margin:0 0 18px;font-size:14px">Put a <strong>Sold</strong> sign in it and park it in <strong>Sold Row</strong>.</p>
      ${fieldRows([['Stock #', data.stock], ['Vehicle', data.vehicleDesc]])}`;
    return wrap(data.subject || 'Vehicle Arrived', body);
  }
  return null;
}

// Mirrors the look of the app's own "Today's Drops" print report (same
// navy-header table, striped rows, status pill, check icons) so the email
// management gets is visually the same document they'd print, not a
// generic bullet list.
function renderDropBatchTable(subject, units) {
  const ck = val => val
    ? `<span style="display:inline-block;width:14px;height:14px;background:#dcfce7;border:1px solid #86efac;border-radius:3px;text-align:center;font-size:9px;line-height:14px;color:#15803d">&#10003;</span>`
    : `<span style="display:inline-block;width:14px;height:14px;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:3px"></span>`;
  const td = 'padding:7px 8px;border-bottom:1px solid #e2e2df';
  const th = 'padding:7px 8px;text-align:left;color:#fff;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap';

  const rows = units.map((u, i) => {
    const statusBg = u.status === 'SOLD' ? '#dcfce7' : u.status === 'TURNOVER' ? '#fef3c7' : '#dbeafe';
    const statusColor = u.status === 'SOLD' ? '#15803d' : u.status === 'TURNOVER' ? '#92400e' : '#1d4ed8';
    return `<tr style="background:${i % 2 === 0 ? '#fff' : '#f8fafc'}">
      <td style="${td}">${esc(u.arrived || '-')}</td>
      <td style="${td};font-weight:700;color:#00095b">${esc(u.stock || '-')}</td>
      <td style="${td};font-size:10px;font-family:monospace;color:#71717a">${esc(u.vin || '-')}</td>
      <td style="${td};font-weight:500">${esc(u.vehicle || '-')}</td>
      <td style="${td};text-align:center">${esc(u.kms || '-')}</td>
      <td style="${td};text-align:center"><span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:20px;background:${statusBg};color:${statusColor}">${esc(u.status || '-')}</span></td>
      <td style="${td};font-family:monospace;font-size:10px;color:#71717a">${esc(u.workReq || '-')}</td>
      <td style="${td};text-align:center">${ck(u.accessories)}</td>
      <td style="${td};text-align:center">${ck(u.pdi)}</td>
      <td style="${td};max-width:160px;font-size:10px;color:#475569">${esc(u.notes || '')}</td>
    </tr>`;
  }).join('');

  const table = units.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:11px">
        <thead><tr style="background:#00095b">
          <th style="${th}">Arrived</th><th style="${th}">Stock #</th><th style="${th}">VIN</th>
          <th style="${th}">Vehicle</th><th style="${th};text-align:center">KMs</th>
          <th style="${th};text-align:center">Status</th><th style="${th}">Keypad Code</th>
          <th style="${th};text-align:center">Acc.</th><th style="${th};text-align:center">PDI</th>
          <th style="${th}">Notes</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : `<div style="text-align:center;padding:40px;color:#94a3b8;font-size:13px">No units in this batch.</div>`;

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1a1a1a">
    <div style="max-width:900px;margin:0 auto;padding:24px">
      <div style="background:#fff;border:1px solid #e4e4e7;border-radius:8px;padding:20px;overflow-x:auto">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;padding-bottom:10px;border-bottom:2px solid #00095b;flex-wrap:wrap;gap:10px">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:28px;height:28px;background:#00095b;border-radius:6px;flex-shrink:0"></div>
            <div>
              <div style="font-size:18px;font-weight:700;color:#00095b;letter-spacing:-.02em">Barrie Ford</div>
              <div style="font-size:11px;color:#64748b;margin-top:1px">Incoming Vehicle Tracker</div>
            </div>
          </div>
          <div style="text-align:right">
            <div style="font-size:13px;font-weight:600;color:#00095b">${esc(subject)} <span style="display:inline-block;background:#00095b;color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;margin-left:8px">${units.length} unit${units.length !== 1 ? 's' : ''}</span></div>
          </div>
        </div>
        ${table}
      </div>
      <div style="text-align:center;color:#a1a1aa;font-size:11px;margin-top:16px">Sent automatically by Vehicle Manager</div>
    </div>
  </body></html>`;
}

// pdfUrl is stored on the deal and normally only ever set by the app itself
// (Firebase Storage's own getDownloadURL() after a real PDF upload) - but
// the database rules don't specifically constrain that field's contents, so
// nothing stops it being set to an arbitrary URL through direct DB access.
// Restricting the fetch to Firebase Storage's own host closes off using this
// function as a blind SSRF proxy for internal-network requests.
function isTrustedPdfUrl(pdfUrl) {
  try {
    const u = new URL(pdfUrl);
    return u.protocol === 'https:' && u.hostname === 'firebasestorage.googleapis.com';
  } catch (e) { return false; }
}

async function buildPdfAttachment(pdfUrl, pdfFileName) {
  if (!isTrustedPdfUrl(pdfUrl)) { logger.warn('Rejected untrusted pdfUrl', pdfUrl); return null; }
  try {
    const res = await fetch(pdfUrl);
    if (!res.ok) { logger.warn('PDF fetch failed', res.status, pdfUrl); return null; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_ATTACHMENT_BYTES) { logger.warn('PDF too large to attach', buf.length); return null; }
    return { filename: pdfFileName || 'get-ready-sheet.pdf', content: buf.toString('base64') };
  } catch (e) {
    logger.warn('PDF fetch threw', e);
    return null;
  }
}

// Shared by every onCall below that needs to know "is this a real, approved
// staff account" - not just "is signed in". Anonymous sign-in is
// self-service with no approval step (it's how the TV/kiosk displays
// authenticate), so `request.auth` alone being truthy would let anyone who
// merely loaded the page as a kiosk call these. The Admin SDK reads straight
// from the Realtime Database, bypassing its rules (Cloud Functions run with
// full admin access), so this is the actual source of truth, not something
// a client could spoof.
async function requireApprovedCaller(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  if (request.auth.token.firebase.sign_in_provider === 'anonymous') {
    throw new HttpsError('permission-denied', 'Not available for kiosk/display sessions.');
  }
  const statusSnap = await getDatabase().ref('users/' + request.auth.uid + '/status').once('value');
  if (statusSnap.val() !== 'approved') {
    throw new HttpsError('permission-denied', 'Account not approved.');
  }
  return request.auth.uid;
}

// Single shared entry point for every email the app sends - see
// sendNotificationEmail() in index.html for the client-side caller.
//
// This holds the only credential (RESEND_API_KEY) that can send mail as the
// dealership's verified domain, so callers are checked against the same
// "real, approved staff account" bar the database rules use (see
// requireApprovedCaller above).
exports.sendNotificationEmail = onCall({ secrets: [RESEND_API_KEY], region: 'us-central1' }, async (request) => {
  await requireApprovedCaller(request);

  const { emailType, to, subject, pdfUrl, pdfFileName, dedupeKey, inReplyTo, references, threadPath, staffUids, ...data } = request.data || {};
  if (!subject) throw new HttpsError('invalid-argument', 'Missing subject.');

  const html = renderTemplate(emailType, { ...data, subject });
  if (!html) throw new HttpsError('invalid-argument', `Unknown email type: ${emailType}`);

  // Tagged Salesperson/Desk Manager/F&I Manager get looped into the thread
  // too - their emails are never sent to the client (see getSalesRoster), so
  // the caller only passes uids (see buildGREmailParams in index.html);
  // resolved here server-side the same way notifySalesArrival already does.
  // A missing account, role, or email just drops that one recipient rather
  // than failing the whole send - the shared inbox in `to` always goes out.
  // `to` can be omitted/empty when a caller wants ONLY resolved staffUids as
  // recipients (e.g. the delivery congrats email, which deliberately skips
  // the shared Get Ready inbox - see markGRDelivered in index.html) -
  // validated below once staffUids has had a chance to contribute.
  const toList = Array.isArray(to) ? to.slice() : (to ? [to] : []);
  if (Array.isArray(staffUids) && staffUids.length) {
    const staffSnaps = await Promise.all(staffUids.map(uid => getDatabase().ref('users/' + uid + '/email').once('value')));
    for (const snap of staffSnaps) {
      const email = snap.val();
      if (email && !toList.includes(email)) toList.push(email);
    }
  }
  if (!toList.length) throw new HttpsError('invalid-argument', 'No recipients resolved.');

  // Email threading: Resend assigns its own Message-ID per send and never
  // hands it back here (not in this call's response, not via a retrieve
  // endpoint) - the only place it actually shows up is the email.sent
  // webhook (see resendWebhook below). So this call can set In-Reply-To/
  // References from whatever real Message-ID a PREVIOUS send in the same
  // thread already resolved (passed in by the caller - see grThreadFields
  // in index.html), but can't set this send's own Message-ID. threadPath
  // registers where resendWebhook should write THIS send's resolved ID
  // once Resend reports it, so the NEXT email in the thread can reference it.
  const headers = {};
  if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
  if (references) headers['References'] = references;

  // Idempotency: if the response to this call gets lost between here and
  // the browser (network blip, not a real failure), the client can't tell
  // the difference from a genuine failure and will retry - which, without
  // this, looks like a brand-new send and goes out via Resend a second
  // time. Claiming the send BEFORE calling Resend (not after) means a
  // retry for the exact same logical event is recognized and skipped no
  // matter what the client ever found out about the first attempt. Only
  // callers that pass a dedupeKey opt into this - checkAndSendDropBatch
  // does (dropBatch-{date}-{batchNum}, stable across a retry since the
  // client only advances its own batch counter after a perceived success);
  // other email types don't have as natural a one-per-logical-event key
  // and are unaffected.
  let dedupeClaimed = false;
  if (dedupeKey) {
    let wonClaim = false;
    await getDatabase().ref('emailDedupe/' + dedupeKey).transaction(curr => {
      if (curr) return undefined; // already claimed by an earlier attempt - abort, don't touch it
      wonClaim = true;
      return { sentAt: Date.now(), by: request.auth.uid };
    });
    if (!wonClaim) {
      logger.info('Deduped - already sent', dedupeKey);
      return { ok: true, deduped: true };
    }
    dedupeClaimed = true;
  }

  try {
    const attachments = [];
    if (pdfUrl) {
      const attachment = await buildPdfAttachment(pdfUrl, pdfFileName);
      if (attachment) attachments.push(attachment);
    }

    const payload = {
      from: FROM_EMAIL.value(),
      to: toList,
      subject,
      html,
      ...(attachments.length ? { attachments } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    };

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY.value()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error('Resend send failed', res.status, text);
      throw new HttpsError('internal', `Resend ${res.status}: ${text || 'send failed'}`);
    }

    if (threadPath) {
      const resData = await res.json().catch(() => null);
      // Traceable by deal # in functions:log - threadPath alone is just a
      // database key (getready/{pushId}), not anything a person recognizes.
      const dealLabel = `${data.dealNum || '?'} / ${data.stock || '?'}`;
      if (resData?.id) {
        // resendWebhook looks this up by Resend's own email id (the one
        // thing both this call and that webhook event agree on) once it
        // hears back what this send's real Message-ID turned out to be.
        await getDatabase().ref('emailThreadMap/' + resData.id).set({ path: threadPath, field: 'emailMessageId', refField: 'emailReferences', at: Date.now() });
        logger.info(`Thread registered for ${dealLabel}: resendId=${resData.id} threadPath=${threadPath} hadInReplyTo=${!!inReplyTo}`);
      } else {
        logger.warn(`No Resend id in response for ${dealLabel} - thread will NOT advance (next send on this deal won't have In-Reply-To)`, resData);
      }
    }

    return { ok: true };
  } catch (e) {
    // A genuine failure (not just a dropped response) shouldn't leave the
    // dedupe key permanently blocking the next real retry.
    if (dedupeClaimed) {
      await getDatabase().ref('emailDedupe/' + dedupeKey).remove().catch(() => {});
    }
    throw e;
  }
});

// Public endpoint Resend calls directly (not through the app, no Firebase
// Auth involved) whenever something happens to an email we sent - set up as
// a webhook in the Resend dashboard, pointed at this function's URL, for the
// email.sent event. Verifies the request is genuinely from Resend (Svix-
// signed) before trusting anything in it. Only email.sent is actually
// needed: that's the one event carrying the real Message-ID Resend assigned
// (see sendNotificationEmail above for why we need it and can't get it any
// other way), which is all this uses it for - resolving sendNotificationEmail's
// emailThreadMap entry for that send into the real thing a later email's
// In-Reply-To/References can reference.
exports.resendWebhook = onRequest({ secrets: [RESEND_WEBHOOK_SECRET], region: 'us-central1' }, async (req, res) => {
  let event;
  try {
    const wh = new Webhook(RESEND_WEBHOOK_SECRET.value());
    // svix 2.x's verify() only checks the signature (throws on failure) and
    // always returns undefined - it no longer hands back the parsed payload
    // the way older versions did. Every delivery was "verifying" fine and
    // then crashing right after on event.type, since event was always
    // undefined - this parses the now-trusted body ourselves instead of
    // relying on verify()'s return value.
    wh.verify(req.rawBody, {
      'svix-id': req.header('svix-id'),
      'svix-timestamp': req.header('svix-timestamp'),
      'svix-signature': req.header('svix-signature'),
    });
    event = JSON.parse(req.rawBody.toString('utf8'));
  } catch (e) {
    logger.warn('Resend webhook signature check failed:', e.message);
    res.status(400).send('Invalid signature');
    return;
  }

  try {
    logger.info(`Resend webhook received: type=${event.type}`, event.data);
    if (event.type === 'email.sent') {
      const emailId = event.data?.email_id || event.data?.id;
      const resolvedMessageId = event.data?.message_id;
      if (!emailId || !resolvedMessageId) {
        // If this ever fires, event.data's actual key names (logged above)
        // don't match what this code assumes (email_id/message_id) - that
        // assumption was never confirmed against a real payload, only
        // against docs/research, same class of bug the svix return-value
        // one above turned out to be.
        logger.warn(`email.sent missing emailId or resolvedMessageId - emailId=${emailId} resolvedMessageId=${resolvedMessageId}`);
      }
      if (emailId && resolvedMessageId) {
        const mapRef = getDatabase().ref('emailThreadMap/' + emailId);
        const mapSnap = await mapRef.once('value');
        const mapping = mapSnap.val();
        if (mapping?.path && mapping?.field) {
          // The reply chain shifts forward: whatever was "latest" becomes a
          // reference, and this send's newly-resolved id becomes "latest" -
          // so the NEXT email in the thread replies to THIS one, while
          // References keeps the full chain for clients that use it to
          // reconstruct thread order.
          const txResult = await getDatabase().ref(mapping.path).transaction(current => {
            if (!current) return current;
            const prevMessageId = current[mapping.field] || null;
            const refField = mapping.refField || (mapping.field + 'References');
            const prevRefs = current[refField] || '';
            const nextRefs = [prevRefs, prevMessageId].filter(Boolean).join(' ').trim();
            return { ...current, [mapping.field]: resolvedMessageId, [refField]: nextRefs || null };
          });
          logger.info(`Thread resolved: emailId=${emailId} path=${mapping.path} resolvedMessageId=${resolvedMessageId} committed=${txResult.committed}`);
        } else {
          logger.warn(`No emailThreadMap entry for emailId=${emailId} (expired, already consumed, or never registered - see sendNotificationEmail's "Thread registered"/"No Resend id" logs)`);
        }
        await mapRef.remove();
      }
    }
  } catch (e) {
    logger.error('Resend webhook handling failed:', e);
  }
  res.status(200).send('ok');
});

// Lets the Incoming unit form offer a "Salesperson" picker without needing
// broad read access to the users list - the database rules restrict that to
// management only (see database.rules.json), since it's the full staff
// roster including emails. This returns just {uid, name} for role==='sales'
// accounts, same "real, approved staff account" bar as every other call
// here, read straight from the Realtime Database via the Admin SDK
// (bypassing rules) rather than relying on the client having list access.
// Management is included too - both because managers sometimes work deals
// directly, and so a manager can pick themselves here to test the arrival
// email end-to-end without needing a real sales account to do it.
//
// `roles` optionally narrows/widens which roles come back (e.g. Get Ready's
// Salesperson/Desk Manager/F&I Manager pickers each need a different role,
// not just sales+management) - each entry also carries its role now so a
// caller fetching several roles at once can bucket the one response client
// side instead of making several round trips.
exports.getSalesRoster = onCall({ region: 'us-central1' }, async (request) => {
  await requireApprovedCaller(request);
  const roles = Array.isArray(request.data?.roles) && request.data.roles.length
    ? request.data.roles
    : ['sales', 'management'];
  const snap = await getDatabase().ref('users').once('value');
  const users = snap.val() || {};
  const roster = Object.entries(users)
    .filter(([, u]) => roles.includes(u.role) && u.status === 'approved')
    .map(([uid, u]) => ({ uid, name: u.name || '(unnamed)', role: u.role }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { roster };
});

// Sends the "your vehicle has arrived" email to one salesperson by uid - the
// uid comes from getSalesRoster above, but their email address is never
// sent to the client at all (same reasoning as getSalesRoster's own
// comment); this looks it up server-side via the Admin SDK right before
// sending.
exports.notifySalesArrival = onCall({ secrets: [RESEND_API_KEY], region: 'us-central1' }, async (request) => {
  await requireApprovedCaller(request);

  const { salesUid, stock, vehicleDesc, status } = request.data || {};
  if (!salesUid || !stock) throw new HttpsError('invalid-argument', 'Missing salesUid/stock.');

  const userSnap = await getDatabase().ref('users/' + salesUid).once('value');
  const salesUser = userSnap.val();
  if (!salesUser || !['sales', 'management'].includes(salesUser.role) || salesUser.status !== 'approved') {
    throw new HttpsError('failed-precondition', 'That salesperson account could not be found.');
  }
  if (!salesUser.email) {
    throw new HttpsError('failed-precondition', `${salesUser.name || 'This salesperson'} has no email on file.`);
  }

  const statusLabel = status === 'TURNOVER' ? 'Turnover' : 'Sold';
  const subject = `${stock} - Your ${statusLabel} vehicle has arrived!`;
  const html = renderTemplate('salesArrival', { subject, stock, vehicleDesc });

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY.value()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_EMAIL.value(), to: [salesUser.email], subject, html }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error('Resend send failed (notifySalesArrival)', res.status, text);
    throw new HttpsError('internal', `Resend ${res.status}: ${text || 'send failed'}`);
  }

  return { ok: true };
});

// Today's date and time-of-day in the dealership's own timezone, regardless
// of what timezone the function instance's clock is actually running in
// (Cloud Functions run in UTC) - built from Intl instead of the usual
// "re-parse a toLocaleString()" trick so it can't be misread as a UTC
// instant anywhere downstream.
function dealershipNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return { dateStr: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')) };
}

// Ported from formatUnitDigestLine() in index.html (that client-side copy
// was removed once this took over sending the digest) - one summary line
// per Incoming Unit added that day.
function formatUnitDigestLine(u) {
  const specLine = [u.year, u.type, u.trim, u.colour].filter(Boolean).join(' ');
  const condLabel = u.condition === 'used'
    ? `Used - ${({ TRADEIN: 'Trade-In', AUCTION: 'Auction Purchase' })[u.category] || u.category || ''}${u.subcategory ? ' / ' + ({ RETAIL: 'Retail', ASIS: 'As-Is', WHOLESALE: 'Wholesale', CPO: 'CPO' })[u.subcategory] : ''}`
    : `New - ${({ RETAIL: 'Retail', FLEET: 'Fleet' })[u.category] || u.category || ''}`;
  return `${u.stock || u.vin || '-'} - ${u.vehicle || specLine || 'no description'} - ${condLabel}${u.kms ? ' - ' + u.kms + ' km' : ''}`;
}

// Replaces the old client-side checkAndSendDailyDigest(), which only ever
// fired if someone happened to have the app open in a browser tab after the
// configured digest time - not reliable once the dealership's closed for
// the day. Runs every 15 minutes instead, self-gating exactly the same way
// that client-side version did: only sends once the configured time of day
// has passed, only once per day (the dailyDigestSent/{date} transaction
// guards against this firing twice, or racing a since-decommissioned
// client-side check), and only if anything actually arrived that day.
exports.sendDailyDigest = onSchedule({
  schedule: 'every 15 minutes',
  secrets: [RESEND_API_KEY],
  region: 'us-central1',
}, async () => {
  const db = getDatabase();
  const emailSettingsSnap = await db.ref('settings/email').once('value');
  const emailSettings = emailSettingsSnap.val() || {};
  const toEmails = (emailSettings.incAddress || '').split(',').map(a => a.trim()).filter(Boolean);
  if (!toEmails.length) return; // not configured

  const { dateStr: todayStr, hour, minute } = dealershipNow();
  const [digestH, digestM] = (emailSettings.digestTime || '18:00').split(':').map(Number);
  const digestTimePassed = hour > digestH || (hour === digestH && minute >= digestM);
  if (!digestTimePassed) return;

  const claim = await db.ref('dailyDigestSent/' + todayStr).transaction(curr => curr ? undefined : true);
  if (!claim.committed) return; // already sent today

  const trackerSnap = await db.ref('tracker').once('value');
  const allUnits = trackerSnap.val() || {};
  const todaysUnits = Object.values(allUnits).filter(u => u.arrivedDate === todayStr);
  if (!todaysUnits.length) return; // nothing arrived today - nothing to send

  const lines = todaysUnits.map(formatUnitDigestLine).join('\n');
  const subject = `Incoming Vehicles - Daily Summary (${todaysUnits.length} unit${todaysUnits.length !== 1 ? 's' : ''})`;
  const html = renderTemplate('incomingDigest', { subject, count: todaysUnits.length, lines });

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY.value()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_EMAIL.value(), to: toEmails, subject, html }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error('Resend send failed (sendDailyDigest)', res.status, text);
  }
});

// Reminds the Salesperson/F&I Manager to update a deal's status once its
// delivery date/time has passed and nobody's marked it delivered (or
// cancelled) yet - catches a deal that quietly slips past its delivery
// window with no record of what actually happened. deliveryReminderSent is
// claimed via a transaction (same one-sender-wins pattern as
// dailyDigestSent) so two overlapping runs of this schedule can't double-
// send, and it's a one-time flag, not reset, so this fires at most once per
// deal rather than every 30 minutes forever.
exports.checkGRDeliveryReminders = onSchedule({
  schedule: 'every 30 minutes',
  secrets: [RESEND_API_KEY],
  region: 'us-central1',
}, async () => {
  const db = getDatabase();
  const { dateStr: todayStr, hour, minute } = dealershipNow();

  const snap = await db.ref('getready').once('value');
  const deals = snap.val() || {};

  for (const [id, d] of Object.entries(deals)) {
    if (d.cancelled || d.delivered || d.deliveryReminderSent) continue;
    if (!d.deliveryDate || !d.deliveryTime) continue;
    const [dH, dM] = d.deliveryTime.split(':').map(Number);
    const isPast = d.deliveryDate < todayStr
      || (d.deliveryDate === todayStr && (hour > dH || (hour === dH && minute >= dM)));
    if (!isPast) continue;

    const claim = await db.ref('getready/' + id + '/deliveryReminderSent').transaction(curr => curr ? undefined : true);
    if (!claim.committed) continue;

    const staffUids = [d.salespersonUid, d.fniManagerUid].filter(Boolean);
    if (!staffUids.length) continue; // nobody to remind (Wholesale/Dealer Trade/Fleet don't tag these)
    const staffSnaps = await Promise.all(staffUids.map(uid => db.ref('users/' + uid + '/email').once('value')));
    const toList = [...new Set(staffSnaps.map(s => s.val()).filter(Boolean))];
    if (!toList.length) continue;

    const subject = `Delivery Overdue - ${d.stock || 'no stock #'} - ${d.customer || ''}`.trim();
    const html = renderTemplate('getReady', {
      subject,
      deliveryOverdue: true,
      dealId: id,
      intro: `This deal's delivery date/time has passed and it hasn't been marked delivered yet - please update its status (Mark Delivered once it's actually out the door, or Cancel if the deal fell through).`,
      stock: d.stock || '', dealNum: d.dealNum || '', vehicle: d.vehicle || '', vin: d.vin || '',
      customer: d.customer || '', salesperson: d.salesperson || '', deskManager: d.deskManager || '', fniManager: d.fniManager || '',
      type: d.type || '', deliveryDate: d.deliveryDate || '', deliveryTime: d.deliveryTime || '',
    });

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY.value()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_EMAIL.value(), to: toList, subject, html }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error('Resend send failed (checkGRDeliveryReminders)', d.stock, res.status, text);
    }
  }
});

// Permanently removes a staff account - both their Firebase Auth login
// (so the email address is actually freed up and old credentials stop
// working) and their users/{uid} database record. The client's own
// Realtime Database rules let management delete a users/{uid} record
// directly, but there's no client-side way to delete another person's
// Auth account at all (only your own) - that's the one part only the
// Admin SDK, server-side, can do, which is the whole reason this needs
// to be a Cloud Function rather than a plain database write.
//
// Self-enforces the management check (database.rules.json can't help
// here - the Admin SDK bypasses rules entirely), and refuses to delete
// the caller's own account so a management user can't accidentally lock
// themselves out.
exports.deleteStaffUser = onCall({ region: 'us-central1' }, async (request) => {
  try {
    const callerUid = await requireApprovedCaller(request);
    const callerRoleSnap = await getDatabase().ref('users/' + callerUid + '/role').once('value');
    if (callerRoleSnap.val() !== 'management') {
      throw new HttpsError('permission-denied', 'Only management can delete staff accounts.');
    }

    const { targetUid } = request.data || {};
    if (!targetUid) throw new HttpsError('invalid-argument', 'Missing targetUid.');
    if (targetUid === callerUid) {
      throw new HttpsError('failed-precondition', "You can't delete your own account from here.");
    }

    try {
      await getAuth().deleteUser(targetUid);
    } catch (e) {
      // Already gone (or some other non-fatal issue) - still clear the
      // database record below so the app's user list reflects reality
      // either way, rather than leaving a zombie entry because the Auth
      // side alone failed.
      logger.warn('Auth delete failed for ' + targetUid, e.message || e);
    }
    await getDatabase().ref('users/' + targetUid).remove();

    return { ok: true };
  } catch (e) {
    // onCall masks any non-HttpsError as a bare "internal" with no detail
    // reaching the client (by design, to avoid leaking stack traces) - but
    // that also means a real bug here is invisible to whoever clicked
    // Delete. Re-throwing an HttpsError with the actual message attached
    // surfaces it in the client's alert() instead.
    if (e instanceof HttpsError) throw e;
    logger.error('deleteStaffUser failed', e);
    throw new HttpsError('internal', `Delete failed: ${e?.message || e}`);
  }
});

// Permanently removes a Get Ready deal - management only. The app's own
// deal cancel (cancelGR) is what everyone else uses day to day, which keeps
// the record and just marks it Cancelled; this is the one true delete, for
// cleaning up test entries/duplicates, and it also clears out the deal's
// uploaded Get Ready sheet PDF and any gas/charge completion photos from
// Storage - those don't get removed just by deleting the database record
// (Storage rules refuse client-side deletes entirely - see storage.rules),
// so left alone they'd sit there accumulating Storage billing forever with
// nothing left in the app pointing at them.
// Gas/charge completion photo filenames carry a timestamp (see
// grHandleFuelPhotoSelected in index.html), so this lists by prefix rather
// than guessing the exact name - shared by deleteGetReadyDeal and
// deleteFuelPhoto below, the two places a photo actually needs to go away
// rather than just having its deal field cleared.
async function deleteFuelPhotoFiles(bucket, dealId) {
  try {
    const [files] = await bucket.getFiles({ prefix: `getready-fuel-photos/${dealId}-` });
    await Promise.all(files.map(f => f.delete().catch(e => logger.warn('Fuel photo delete failed for ' + f.name, e.message || e))));
  } catch (e) {
    logger.warn('Fuel photo list failed for ' + dealId, e.message || e);
  }
}

exports.deleteGetReadyDeal = onCall({ region: 'us-central1' }, async (request) => {
  try {
    const callerUid = await requireApprovedCaller(request);
    const callerRoleSnap = await getDatabase().ref('users/' + callerUid + '/role').once('value');
    if (callerRoleSnap.val() !== 'management') {
      throw new HttpsError('permission-denied', 'Only management can delete Get Ready deals.');
    }

    const { dealId } = request.data || {};
    if (!dealId) throw new HttpsError('invalid-argument', 'Missing dealId.');

    const dealSnap = await getDatabase().ref('getready/' + dealId).once('value');
    const deal = dealSnap.val();
    if (!deal) throw new HttpsError('not-found', 'That deal no longer exists.');

    const bucket = getStorage().bucket();
    const deletions = [];
    if (deal.pdfUrl) {
      deletions.push(bucket.file(`getready-pdfs/${dealId}.pdf`).delete().catch(e => {
        logger.warn('Get Ready PDF delete failed for ' + dealId, e.message || e);
      }));
    }
    if (deal.gasPhotoUrl) deletions.push(deleteFuelPhotoFiles(bucket, dealId));
    await Promise.all(deletions);

    await getDatabase().ref('getready/' + dealId).remove();

    return { ok: true };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.error('deleteGetReadyDeal failed', e);
    throw new HttpsError('internal', `Delete failed: ${e?.message || e}`);
  }
});

// Clears a gas/charge completion photo out of Storage when it's reset (see
// toggleGRField in index.html, which clears the deal's own gasPhotoUrl/By/
// At fields) - the client can't delete it directly (Storage rules refuse
// client-side deletes entirely, see storage.rules), so without this the
// file would just sit there unreferenced, accumulating Storage billing,
// every time someone undoes and redoes a gas/charge completion. Same "real
// approved staff account" bar as clearing the field itself (not management-
// only - anyone who can touch the gas/charge banner can reset it).
exports.deleteFuelPhoto = onCall({ region: 'us-central1' }, async (request) => {
  try {
    await requireApprovedCaller(request);
    const { dealId } = request.data || {};
    if (!dealId) throw new HttpsError('invalid-argument', 'Missing dealId.');
    await deleteFuelPhotoFiles(getStorage().bucket(), dealId);
    return { ok: true };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.error('deleteFuelPhoto failed', e);
    throw new HttpsError('internal', `Delete failed: ${e?.message || e}`);
  }
});
