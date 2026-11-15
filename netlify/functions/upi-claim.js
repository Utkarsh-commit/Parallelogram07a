// netlify/functions/upi-claim.js
//
// A customer says "I paid by UPI" and gives their UTR. This emails YOU a message with a
// one-tap "Approve & send guide" button. You check your bank app, tap the button, and the
// guide is emailed to the customer (see approve-order.js). Nothing is sent to the customer
// until you approve.
//
// Netlify env vars: GMAIL_USER, GMAIL_APP_PASSWORD (already set), plus a NEW one:
//   APPROVE_SECRET  -> any long random text (30+ characters). Used to sign the approve links.
// Optional: OWNER_EMAIL (where the alert goes; default = GMAIL_USER)

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { GUIDE_FILES } = require('./guide-mailer');

const json = (code, body) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const b64 = (s) => Buffer.from(s).toString('base64url');

exports.handler = async (event) => {
  const log = (...a) => console.log('[upi-claim]', ...a);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const secret = process.env.APPROVE_SECRET;
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!secret || secret.length < 16) { log('APPROVE_SECRET not set (or too short)'); return json(503, { error: 'Not configured' }); }
  if (!gmailUser || !gmailPass) { log('Gmail env vars missing'); return json(503, { error: 'Email not configured' }); }

  let d;
  try { d = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Bad JSON' }); }

  const name = String(d.name || '').trim().slice(0, 80);
  const email = String(d.email || '').trim().slice(0, 120);
  const utr = String(d.utr || '').trim();
  const ref = String(d.ref || '').trim().slice(0, 30);
  const amount = Math.round(Number(d.amount));
  const titles = Array.isArray(d.titles) ? d.titles.map((t) => String(t)).slice(0, 40) : [];

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json(400, { error: 'Invalid email' });
  if (!/^[A-Za-z0-9]{12,22}$/.test(utr)) return json(400, { error: 'Invalid UTR' });
  if (!ref || !(amount >= 1 && amount <= 100000)) return json(400, { error: 'Invalid amount' });
  if (!titles.length || !titles.every((t) => GUIDE_FILES[t])) return json(400, { error: 'Unknown guide' });

  // Light spam protection (skipped quietly if the rate limiter is unavailable)
  try {
    const { checkRateLimit, getClientIp } = require('./rate-limiter');
    const rc = await checkRateLimit('upi-claim:' + getClientIp(event), 10, 3600);
    if (!rc.allowed) return json(429, { error: 'Too many requests' });
  } catch (e) { log('rate limiter unavailable, continuing:', String(e)); }

  // Signed approve link (valid 14 days)
  const payload = b64(JSON.stringify({ name, email, titles, amount, utr, ref, exp: Date.now() + 14 * 24 * 3600 * 1000 }));
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const origin = process.env.URL || 'https://' + (event.headers['x-forwarded-host'] || event.headers.host);
  const link = origin + '/.netlify/functions/approve-order?t=' + payload + '.' + sig;

  const owner = process.env.OWNER_EMAIL || gmailUser;
  const list = titles.map((t) => '<li>' + esc(t) + '</li>').join('');
  const transporter = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: gmailUser, pass: gmailPass } });
  const from = '"Parallelogram Orders" <' + gmailUser + '>';

  try {
    await transporter.sendMail({
      from, to: owner, replyTo: email,
      subject: 'UPI payment ₹' + amount + ' - check & approve - ' + email,
      html:
        '<div style="font-family:Arial,sans-serif;max-width:520px">' +
        '<h2 style="margin:0 0 8px">New UPI payment claim</h2>' +
        '<p><b>' + esc(name || 'Customer') + '</b> (' + esc(email) + ') says they paid <b>₹' + amount + '</b>.</p>' +
        '<p>UTR: <b>' + esc(utr) + '</b><br>Order ref: ' + esc(ref) + '</p>' +
        '<p>Guides:</p><ol>' + list + '</ol>' +
        '<p style="background:#fff4d6;padding:10px;border-radius:6px"><b>Step 1:</b> open your bank / UPI app and check that ₹' + amount + ' (or more) arrived with this UTR.<br>' +
        '<b>Step 2:</b> only then tap the button.</p>' +
        '<p><a href="' + link + '" style="display:inline-block;background:#C8963E;color:#000;font-weight:bold;padding:14px 22px;border-radius:8px;text-decoration:none">Open approve page</a></p>' +
        '<p style="color:#888;font-size:12px">Nothing is sent to the customer until you press Approve on that page. If the money did not arrive, just ignore this email.</p></div>',
    });
  } catch (err) {
    log('owner email failed:', String(err));
    return json(502, { error: 'Could not send alert', reason: String((err && (err.response || err.message)) || err).slice(0, 220) });
  }

  // Customer receipt (best effort)
  transporter.sendMail({
    from: '"Parallelogram" <' + gmailUser + '>', to: email, replyTo: owner,
    subject: 'We received your payment details',
    html: '<p>Hi ' + esc((name || 'there').split(' ')[0]) + ',</p><p>Thanks! We got your UPI payment details (UTR ' + esc(utr) + '). As soon as we confirm the payment, your guide(s) will be emailed to this address.</p><p>— Parallelogram</p>',
  }).catch((e) => log('customer receipt failed:', String(e)));

  log('claim emailed to owner', ref);
  return json(200, { ok: true });
};
