const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret, defineString } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

initializeApp();

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
// Must be an address on a domain you've verified in Resend, e.g.
// "Vehicle Manager <notifications@yourdealership.com>". Until a domain is
// verified, Resend only lets onboarding@resend.dev deliver, and only to the
// email address on your Resend account - fine for testing, not for real use.
const FROM_EMAIL = defineString('RESEND_FROM_EMAIL', { default: 'onboarding@resend.dev' });

// Stay well clear of Resend's ~40MB request cap once the file is inflated
// ~33% by base64 encoding.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

function esc(val) {
  return String(val ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function wrap(title, bodyHtml) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1a1a1a">
    <div style="max-width:600px;margin:0 auto;padding:24px">
      <div style="background:#fff;border:1px solid #e4e4e7;border-radius:8px;overflow:hidden">
        <div style="background:#00095b;color:#fff;padding:16px 24px;font-size:16px;font-weight:700">${esc(title)}</div>
        <div style="padding:24px">${bodyHtml}</div>
      </div>
      <div style="text-align:center;color:#a1a1aa;font-size:11px;margin-top:16px">Sent automatically by Vehicle Manager</div>
    </div>
  </body></html>`;
}

function fieldRows(fields) {
  const rows = fields
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value]) => `<tr><td style="padding:6px 10px 6px 0;color:#71717a;width:150px;vertical-align:top;white-space:nowrap">${esc(label)}</td><td style="padding:6px 0;white-space:pre-wrap">${esc(value)}</td></tr>`)
    .join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>`;
}

function renderTemplate(emailType, data) {
  if (emailType === 'getReady') {
    const intro = data.intro ? `<p style="margin:0 0 16px;font-size:14px">${esc(data.intro)}</p>` : '';
    // Wholesale and Dealer Trade only ever collect a handful of fields (see
    // the app's own type-specific intake form) - each gets its own minimal
    // row list rather than reusing the full Retail list, which would either
    // show a wall of blank/placeholder rows or need every row individually
    // guarded. fieldRows() already drops any row whose value is empty, so
    // whichever of these was actually left blank (e.g. no Deal #) just
    // doesn't appear.
    let rows;
    if (data.type === 'WHOLESALE') {
      rows = fieldRows([
        ['Stock #', data.stock], ['Deal #', data.dealNum], ['Type', data.type],
        ['Auction Company', data.customer], ['Entered By', data.salesperson],
        ['Pickup Date', data.deliveryDate], ['Pickup Time', data.deliveryTime],
      ]);
    } else if (data.type === 'DEALER TRADE') {
      rows = fieldRows([
        ['Stock #', data.stock], ['Deal #', data.dealNum], ['Type', data.type],
        ['Purchasing Dealership', data.customer], ['Entered By', data.salesperson],
        ['Pickup Date', data.deliveryDate], ['Pickup Time', data.deliveryTime],
        ['Trade-In', data.trades],
      ]);
    } else {
      rows = fieldRows([
        ['Stock #', data.stock], ['Deal #', data.dealNum], ['Vehicle', data.vehicle], ['VIN', data.vin],
        ['Customer', data.customer], ['Salesperson', data.salesperson], ['Type', data.type],
        ['Financing', data.financing], ['Delivery Date', data.deliveryDate], ['Delivery Time', data.deliveryTime],
        ['Gas/Charge', data.gasStatus], ['Notes', data.notes], ['Services', data.steps],
        ['Trades', data.trades],
      ]);
    }
    return wrap(data.subject || 'Get Ready Deal', intro + rows);
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

  const { emailType, to, subject, pdfUrl, pdfFileName, dedupeKey, ...data } = request.data || {};
  if (!to || !subject || (Array.isArray(to) && !to.length)) throw new HttpsError('invalid-argument', 'Missing to/subject.');

  const html = renderTemplate(emailType, { ...data, subject });
  if (!html) throw new HttpsError('invalid-argument', `Unknown email type: ${emailType}`);

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
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      ...(attachments.length ? { attachments } : {}),
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
exports.getSalesRoster = onCall({ region: 'us-central1' }, async (request) => {
  await requireApprovedCaller(request);
  const snap = await getDatabase().ref('users').once('value');
  const users = snap.val() || {};
  const roster = Object.entries(users)
    .filter(([, u]) => (u.role === 'sales' || u.role === 'management') && u.status === 'approved')
    .map(([uid, u]) => ({ uid, name: u.name || '(unnamed)' }))
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

  const { salesUid, stock, vehicleDesc } = request.data || {};
  if (!salesUid || !stock) throw new HttpsError('invalid-argument', 'Missing salesUid/stock.');

  const userSnap = await getDatabase().ref('users/' + salesUid).once('value');
  const salesUser = userSnap.val();
  if (!salesUser || !['sales', 'management'].includes(salesUser.role) || salesUser.status !== 'approved') {
    throw new HttpsError('failed-precondition', 'That salesperson account could not be found.');
  }
  if (!salesUser.email) {
    throw new HttpsError('failed-precondition', `${salesUser.name || 'This salesperson'} has no email on file.`);
  }

  const subject = `Put a Sold Sign In It & Park in Sold Row - ${stock} Has Arrived!`;
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
