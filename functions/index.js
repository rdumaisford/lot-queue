const { onCall, HttpsError } = require('firebase-functions/v2/https');
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
    const rows = fieldRows([
      ['Stock #', data.stock], ['Deal #', data.dealNum], ['Vehicle', data.vehicle], ['VIN', data.vin],
      ['Customer', data.customer], ['Salesperson', data.salesperson], ['Type', data.type],
      ['Financing', data.financing], ['Delivery Date', data.deliveryDate], ['Delivery Time', data.deliveryTime],
      ['Plates', data.plateType], ['Licensing Notes', data.licensingNotes], ['Gas/Charge', data.gasStatus],
      ['Instructions', data.instructions], ['Notes', data.notes], ['Services', data.steps],
      ['Trades', data.trades],
    ]);
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

// Single shared entry point for every email the app sends - see
// sendNotificationEmail() in index.html for the client-side caller.
//
// This holds the only credential (RESEND_API_KEY) that can send mail as the
// dealership's verified domain, so callers are checked against the same
// "real, approved staff account" bar the database rules use - not just "is
// signed in". Anonymous sign-in is self-service with no approval step (it's
// how the TV/kiosk displays authenticate), so `request.auth` alone being
// truthy would let anyone who merely loaded the page as a kiosk trigger
// arbitrary sends - an open relay off a verified sending domain. The Admin
// SDK reads straight from the Realtime Database, bypassing its rules
// (Cloud Functions run with full admin access), so this is the actual
// source of truth, not something a client could spoof.
exports.sendNotificationEmail = onCall({ secrets: [RESEND_API_KEY], region: 'us-central1' }, async (request) => {
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

  const { emailType, to, subject, pdfUrl, pdfFileName, ...data } = request.data || {};
  if (!to || !subject || (Array.isArray(to) && !to.length)) throw new HttpsError('invalid-argument', 'Missing to/subject.');

  const html = renderTemplate(emailType, { ...data, subject });
  if (!html) throw new HttpsError('invalid-argument', `Unknown email type: ${emailType}`);

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
});
