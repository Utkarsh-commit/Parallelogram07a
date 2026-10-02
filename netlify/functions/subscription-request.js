// Netlify function: when someone requests a Basic/Pro subscription, email
//   (1) YOU a notification (reply to it to answer the buyer), and
//   (2) the BUYER a confirmation
// using your Gmail account over SMTP (nodemailer).
//
// Environment variables (Netlify → Site settings → Environment variables).
// If your existing send-guide-email function already sends through Gmail, reuse the SAME values —
// these common names are all accepted:
//   Gmail address : GMAIL_USER  | EMAIL_USER | SMTP_USER   (default: parallelogramguides@gmail.com)
//   App password  : GMAIL_APP_PASSWORD | GMAIL_PASS | EMAIL_PASS | SMTP_PASS | SMTP_PASSWORD
// Optional: OWNER_EMAIL (where notifications go; default = the Gmail address)
// The password must be a Google "App Password" (needs 2-Step Verification on the account).

const nodemailer = require('nodemailer');

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const env = (...names) => names.map(n => process.env[n]).find(Boolean);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  const user = env('GMAIL_USER', 'EMAIL_USER', 'SMTP_USER') || 'parallelogramguides@gmail.com';
  const pass = env('GMAIL_APP_PASSWORD', 'GMAIL_PASS', 'EMAIL_PASS', 'SMTP_PASS', 'SMTP_PASSWORD');
  const owner = process.env.OWNER_EMAIL || user;
  if (!pass) return json(500, { ok: false, error: 'Email is not configured' });

  let d;
  try { d = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { ok: false, error: 'Bad request' }); }

  const name = String(d.name || '').trim().slice(0, 80);
  const email = String(d.email || '').trim().slice(0, 120);
  const plan = ['Basic', 'Pro'].includes(d.plan) ? d.plan : null;
  const price = String(d.price || '').slice(0, 20);
  const guides = Array.isArray(d.guides) ? d.guides.slice(0, 10).map(g => String(g).slice(0, 120)) : [];
  if (!plan || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || guides.length === 0) {
    return json(400, { ok: false, error: 'Missing or invalid fields' });
  }

  const transporter = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
  const list = guides.map(g => `<li>${esc(g)}</li>`).join('');
  const from = `"Parallelogram Guides" <${user}>`;
  const safe = p => p.then(() => true).catch(err => { console.error('Mail error:', err && err.message); return false; });

  const ownerSent = await safe(transporter.sendMail({
    from, to: owner, replyTo: `"${name.replace(/"/g, '')}" <${email}>`,
    subject: `New ${plan} subscription request — ${email}`,
    html: `<p><b>${esc(name || 'Someone')}</b> (${esc(email)}) wants the <b>${plan}</b> plan (${esc(price)}).</p><p>Picked guides:</p><ol>${list}</ol><p>Reply to this email to send them the payment link.</p>`
  }));

  const buyerSent = await safe(transporter.sendMail({
    from, to: email, replyTo: owner,
    subject: `We got your ${plan} plan request`,
    html: `<p>Hi ${esc(name || 'there')},</p><p>Thanks for choosing the <b>${plan}</b> plan (${esc(price)}). We received your picks:</p><ol>${list}</ol><p>We'll email you the payment link within a few hours, and send your guides as soon as payment clears. Just reply to this email if you have questions.</p><p>— Parallelogram Guides</p>`
  }));

  const ok = ownerSent || buyerSent;
  return json(ok ? 200 : 502, { ok, ownerSent, buyerSent });
};
