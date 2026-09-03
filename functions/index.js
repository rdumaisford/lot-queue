const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');

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
      ['Instructions', data.instructions], ['Notes', data.notes], ['Steps', data.steps],
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
  return null;
}

async function buildPdfAttachment(pdfUrl, pdfFileName) {
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
// Callers already gate who can trigger this (signed-in staff/kiosk sessions
// only), matching the trust model the old EmailJS public key had.
exports.sendNotificationEmail = onCall({ secrets: [RESEND_API_KEY], region: 'us-central1' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }

  const { emailType, to, subject, pdfUrl, pdfFileName, ...data } = request.data || {};
  if (!to || !subject) throw new HttpsError('invalid-argument', 'Missing to/subject.');

  const html = renderTemplate(emailType, { ...data, subject });
  if (!html) throw new HttpsError('invalid-argument', `Unknown email type: ${emailType}`);

  const attachments = [];
  if (pdfUrl) {
    const attachment = await buildPdfAttachment(pdfUrl, pdfFileName);
    if (attachment) attachments.push(attachment);
  }

  const payload = {
    from: FROM_EMAIL.value(),
    to: [to],
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
