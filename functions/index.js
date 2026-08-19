// Server-side replacement for the old client-side EmailJS notifications.
// Two flows, same as before:
//   1. New Get Ready deal -> instant email (RTDB trigger, fires once per deal).
//   2. Incoming units added today -> one daily digest (scheduled, checks the
//      configured send time every 15 minutes so it still respects whatever
//      time is set in Settings without needing a redeploy).
// Recipient addresses and the digest send time still live at settings/email
// in the Realtime Database, same as before - only the sending mechanism
// (SendGrid via a Cloud Function, instead of EmailJS in the browser) changed.

const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { onValueCreated } = require('firebase-functions/v2/database');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const sgMail = require('@sendgrid/mail');

initializeApp();

const SENDGRID_API_KEY = defineSecret('SENDGRID_API_KEY');
const FROM_EMAIL = '[REDACTED_EMAIL_ADDRESS_1]';
const FROM_NAME = 'Vehicle Manager';
const REGION = 'us-central1';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

async function sendMail(apiKey, { to, subject, html, text }) {
  sgMail.setApiKey(apiKey);
  await sgMail.send({
    to,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject,
    text,
    html,
  });
}

// ── Get Ready "new deal" email ──────────────────────────────────────
const FINANCING_LABELS = { CASH: 'Cash', COMMERCIAL_LEASE: 'Commercial Lease', FINANCE: 'Finance', FORD_RCL: 'Ford RCL' };
const TRADE_CATEGORY_LABELS = { RETAIL: 'Retail', ASIS: 'As-Is', WHOLESALE: 'Wholesale', CPO: 'Certified Pre-Owned' };
const GR_CHECKLIST = [
  ['pdi', 'PDI'], ['lof', 'LOF'], ['detail', 'Detail'], ['paint', 'Paint'],
  ['safety', 'Safety'], ['leather', 'Leather'], ['fabric', 'Fabric'], ['module', 'Module'],
];

function grEffectiveFuelStatus(d) {
  if (d.fuelStatus === 'gas' || d.fuelStatus === 'charge' || d.fuelStatus === 'none') return d.fuelStatus;
  return d.needsGas ? 'gas' : 'none';
}

function buildGREmail(d, subject, intro) {
  const financingLabel = FINANCING_LABELS[d.financing] || d.financing || '';
  const plateLabel = d.plateType === 'TRANSFER' ? 'License Plate Transfer' : 'New License Plates';
  const fuelStatus = grEffectiveFuelStatus(d);
  const gasLabel = fuelStatus === 'gas' ? `Needs Gas${d.gasAmount ? ' - $' + Number(d.gasAmount).toFixed(2) : ''}`
    : fuelStatus === 'charge' ? 'Needs Charging'
    : 'No Gas/Charge Needed';
  const trades = Array.isArray(d.trades) ? d.trades.filter(t => t && t.stock) : [d.trade1, d.trade2].filter(t => t?.stock);
  const tradesLines = trades.length
    ? trades.map((t, i) => `Trade ${i + 1}: ${t.stock} - ${[t.year, t.make, t.model].filter(Boolean).join(' ')}${t.colour ? ' - ' + t.colour : ''}${t.vin ? ' - VIN ' + t.vin : ''}${t.kms ? ' - ' + t.kms + ' km' : ''} (${TRADE_CATEGORY_LABELS[t.category] || 'Retail'})`)
    : ['None'];
  const requiredSteps = GR_CHECKLIST.filter(([key]) => d['req_' + key]).map(([, label]) => label).join(', ') || 'None selected';

  const rows = [
    ['Stock #', d.stock || ''],
    ['Deal #', d.dealNum || ''],
    ['Vehicle', d.vehicle || ''],
    ['VIN', d.vin || ''],
    ['Customer', d.customer || ''],
    ['Salesperson', d.salesperson || ''],
    ['Type', d.type || ''],
    ['Financing', financingLabel],
    ['Delivery', [d.deliveryDate, d.deliveryTime].filter(Boolean).join(' ')],
    ['Plates', plateLabel],
    ['Licensing notes', d.licensingNotes || '(none)'],
    ['Gas / Charge', gasLabel],
    ['Required steps', requiredSteps],
    ['Instructions', d.instructions || '(none)'],
    ['Notes', d.notes || '(none)'],
  ];

  const text = [intro, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', 'Trade-ins:', ...tradesLines].join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111">
    <p>${esc(intro)}</p>
    <table cellpadding="4" cellspacing="0" style="border-collapse:collapse">
      ${rows.map(([k, v]) => `<tr><td style="color:#666;padding-right:12px;vertical-align:top">${esc(k)}</td><td>${esc(v).replace(/\n/g, '<br>')}</td></tr>`).join('')}
    </table>
    <p style="margin-top:16px;color:#666;font-weight:bold">Trade-ins</p>
    <p>${tradesLines.map(esc).join('<br>')}</p>
  </div>`;

  return { subject, text, html };
}

exports.onGetReadyDealCreated = onValueCreated(
  { ref: '/getready/{dealId}', region: REGION, secrets: [SENDGRID_API_KEY] },
  async (event) => {
    const db = getDatabase();
    const settingsSnap = await db.ref('settings/email').once('value');
    const settings = settingsSnap.val() || {};
    if (!settings.grAddress) return; // not configured - nothing to do

    const d = event.data.val();
    if (!d) return;

    // Idempotency guard - RTDB triggers can in rare cases redeliver, and this
    // also matters if a legacy client-side send from an old open tab races
    // with this function during the rollout.
    const flagRef = db.ref(`getready/${event.params.dealId}/emailSent`);
    const txResult = await flagRef.transaction(curr => (curr ? undefined : true));
    if (!txResult.committed) return;

    const { subject, text, html } = buildGREmail(
      d,
      `New Get Ready Deal - ${d.stock || 'no stock #'}`,
      `A new Get Ready deal was added for ${d.vehicle || d.stock || 'a vehicle'}.`,
    );
    await sendMail(SENDGRID_API_KEY.value(), { to: settings.grAddress, subject, text, html });
  },
);

// ── Incoming daily digest ───────────────────────────────────────────
function todayStrInTZ() {
  // Same local-date logic the client used (toISOString().slice(0,10)) -
  // keeping it UTC-based keeps "today" consistent with everything else
  // already stored using arrivedDate (also a plain YYYY-MM-DD string).
  return new Date().toISOString().slice(0, 10);
}

exports.dailyIncomingDigest = onSchedule(
  { schedule: 'every 15 minutes', region: REGION, secrets: [SENDGRID_API_KEY] },
  async () => {
    const db = getDatabase();
    const settingsSnap = await db.ref('settings/email').once('value');
    const settings = settingsSnap.val() || {};
    if (!settings.incAddress) return; // not configured

    const now = new Date();
    const [digestH, digestM] = (settings.digestTime || '18:00').split(':').map(Number);
    const digestTimePassed = now.getUTCHours() > digestH || (now.getUTCHours() === digestH && now.getUTCMinutes() >= digestM);
    if (!digestTimePassed) return;

    const todayStr = todayStrInTZ();
    const sentRef = db.ref('dailyDigestSent/' + todayStr);
    const txResult = await sentRef.transaction(curr => (curr ? undefined : true));
    if (!txResult.committed) return; // already sent today

    const unitsSnap = await db.ref('tracker').once('value');
    const units = unitsSnap.val() || {};
    const todaysUnits = Object.values(units).filter(u => u.arrivedDate === todayStr);
    if (!todaysUnits.length) return; // nothing arrived today

    const lines = todaysUnits.map(u => {
      const specLine = [u.year, u.type, u.trim, u.colour].filter(Boolean).join(' ');
      const condLabel = u.condition === 'used'
        ? `Used - ${({ TRADEIN: 'Trade-In', AUCTION: 'Auction' })[u.category] || u.category || ''}${u.subcategory ? ' / ' + ({ RETAIL: 'Retail', ASIS: 'As-Is', WHOLESALE: 'Wholesale', CPO: 'CPO' })[u.subcategory] : ''}`
        : `New - ${({ RETAIL: 'Retail', FLEET: 'Fleet' })[u.category] || u.category || ''}`;
      return `${u.stock || u.vin || '-'} - ${u.vehicle || specLine || 'no description'} - ${condLabel}${u.kms ? ' - ' + u.kms + ' km' : ''}`;
    });

    const subject = `Incoming Vehicles - Daily Summary (${todaysUnits.length} unit${todaysUnits.length !== 1 ? 's' : ''})`;
    const text = lines.join('\n');
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111">
      <p><strong>${todaysUnits.length}</strong> unit${todaysUnits.length !== 1 ? 's' : ''} added to Incoming today.</p>
      <ul>${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
    </div>`;
    await sendMail(SENDGRID_API_KEY.value(), { to: settings.incAddress, subject, text, html });
  },
);

// ── Settings page "Send Test" button ────────────────────────────────
exports.sendTestEmail = onCall(
  { region: REGION, secrets: [SENDGRID_API_KEY] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
    const to = (request.data && request.data.toAddress) ? String(request.data.toAddress).trim() : '';
    if (!to) throw new HttpsError('invalid-argument', 'No recipient address given.');
    try {
      await sendMail(SENDGRID_API_KEY.value(), {
        to,
        subject: 'Test notification - Vehicle Manager',
        text: 'If you got this, your email notifications are working correctly.',
        html: '<p>If you got this, your email notifications are working correctly.</p>',
      });
      return { ok: true };
    } catch (e) {
      const detail = e?.response?.body?.errors?.map(x => x.message).join('; ') || e.message || String(e);
      throw new HttpsError('internal', detail);
    }
  },
);
