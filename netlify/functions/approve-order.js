// netlify/functions/approve-order.js
//
// The page behind the "Approve" button in your payment email. It shows the order, and when you
// press "Approve & send guide" it emails the guide(s) to the customer and saves the order record.
// Opening the link alone sends nothing (so email scanners can't approve by accident).
//
// Netlify env var: APPROVE_SECRET (same one used by upi-claim.js)

const crypto = require('crypto');
const { sendGuideEmail } = require('./guide-mailer');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const page = (code, title, body) => ({
  statusCode: code,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' },
  body:
    '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>' + esc(title) + '</title>' +
    '<style>body{background:#0b0b0e;color:#eee;font-family:Arial,sans-serif;padding:22px;max-width:480px;margin:0 auto}h1{font-size:20px;color:#C8963E}' +
    '.box{background:#16161b;border:1px solid #333;border-radius:12px;padding:16px;margin:14px 0;line-height:1.55}' +
    'button{width:100%;font-size:17px;font-weight:bold;padding:16px;border:0;border-radius:12px;background:#22c55e;color:#000;margin-top:6px}' +
    '.warn{color:#f0c36b;font-size:13px}.ok{color:#86efac}.bad{color:#fca5a5}</style></head><body>' + body + '</body></html>',
});

function verify(token) {
  const secret = process.env.APPROVE_SECRET;
  if (!secret || !token || token.indexOf('.') < 1) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!d.exp || Date.now() > d.exp) return { expired: true };
    return d;
  } catch (e) { return null; }
}

exports.handler = async (event) => {
  const log = (...a) => console.log('[approve-order]', ...a);
  let token = '';
  if (event.httpMethod === 'GET') token = (event.queryStringParameters || {}).t || '';
  else if (event.httpMethod === 'POST') {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
    token = new URLSearchParams(raw).get('t') || '';
  } else return page(405, 'Not allowed', '<h1>Not allowed</h1>');

  const d = verify(token);
  if (!d) return page(400, 'Invalid link', '<h1>Invalid link</h1><p class="bad">This approve link is not valid.</p>');
  if (d.expired) return page(400, 'Expired', '<h1>Link expired</h1><p class="bad">This approve link is older than 14 days. Ask the customer to submit again, or send the guide manually.</p>');

  let store = null;
  try { store = require('./blobs-helper').getSafeStore('upi-approved'); } catch (e) { log('store unavailable:', String(e)); }
  const already = store ? await store.get(d.ref, { type: 'json' }).catch(() => null) : null;

  const details =
    '<div class="box"><b>' + esc(d.name || 'Customer') + '</b><br>' + esc(d.email) + '<br><br>' +
    'Claimed payment: <b>₹' + esc(d.amount) + '</b><br>UTR: <b>' + esc(d.utr) + '</b><br>Order ref: ' + esc(d.ref) +
    '<br><br>Guides:<ol>' + d.titles.map((t) => '<li>' + esc(t) + '</li>').join('') + '</ol></div>';

  if (already) return page(200, 'Already sent', '<h1 class="ok">Already sent ✓</h1>' + details + '<p>This order was approved earlier. Nothing more was sent.</p>');

  if (event.httpMethod === 'GET') {
    return page(200, 'Approve order',
      '<h1>Approve this order?</h1>' + details +
      '<p class="warn">First check your bank / UPI app: did ₹' + esc(d.amount) + ' (or more) arrive with this UTR? Only then approve.</p>' +
      '<form method="POST"><input type="hidden" name="t" value="' + esc(token) + '"><button type="submit">Approve &amp; send guide</button></form>');
  }

  // POST = approve
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const siteOrigin = process.env.URL || proto + '://' + (event.headers['x-forwarded-host'] || event.headers.host);
  const result = await sendGuideEmail({ name: d.name, email: d.email, titles: d.titles, isFree: false, siteOrigin, log });
  if (!result.ok) {
    log('send failed', result.error, d.ref);
    return page(502, 'Failed', '<h1 class="bad">Could not send</h1><p>Error: ' + esc(result.error) + '. Nothing was marked as sent, so you can open the email link and try again.</p>');
  }

  try {
    const { getSafeStore } = require('./blobs-helper');
    const orders = getSafeStore('orders');
    const key = d.email.trim().toLowerCase();
    let existing = [];
    try { const r = await orders.get(key, { type: 'json' }); if (Array.isArray(r)) existing = r; } catch (e) {}
    existing.push({ name: d.name || '', titles: result.delivered, total: d.amount, date: new Date().toISOString(), isFree: false, payment: 'UPI ' + d.utr });
    await orders.setJSON(key, existing);
    if (store) await store.setJSON(d.ref, { at: new Date().toISOString(), email: key, utr: d.utr });
  } catch (e) { log('WARNING: record not saved (email was sent):', String(e)); }

  log('approved and sent', d.ref, '->', d.email);
  return page(200, 'Sent', '<h1 class="ok">Guide sent ✓</h1>' + details + '<p>The guide(s) were emailed to the customer.</p>');
};
