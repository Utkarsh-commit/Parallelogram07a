// netlify/functions/razorpay-webhook.js
//
// Razorpay -> your site. When a payment is confirmed (order.paid), this emails the
// guides automatically using the same mailer as send-guide-email.js, and saves the
// order record (so "Resend my guide" and the admin dashboard work).
//
// Netlify env var needed: RAZORPAY_WEBHOOK_SECRET
// Razorpay Dashboard > Webhooks: subscribe ONLY to the "order.paid" event.
//
// It calls guide-mailer directly (not send-guide-email), so it is never hit by the
// 10-per-hour-per-IP rate limit that protects the public browser endpoint.

const crypto = require('crypto');
const { sendGuideEmail } = require('./guide-mailer');

exports.handler = async (event) => {
  const log = (...a) => console.log('[razorpay-webhook]', ...a);
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) { log('RAZORPAY_WEBHOOK_SECRET not set'); return { statusCode: 503, body: 'Webhook secret not set' }; }

  // 1) Verify the request really came from Razorpay
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body || '';
  const sig = event.headers['x-razorpay-signature'] || event.headers['X-Razorpay-Signature'] || '';
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const valid = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!valid) { log('invalid signature'); return { statusCode: 400, body: 'Invalid signature' }; }

  let payload;
  try { payload = JSON.parse(raw); } catch (e) { return { statusCode: 400, body: 'Bad JSON' }; }
  if (payload.event !== 'order.paid') return { statusCode: 200, body: 'Ignored' };

  const order = payload.payload && payload.payload.order && payload.payload.order.entity;
  const payment = payload.payload && payload.payload.payment && payload.payload.payment.entity;
  if (!order || order.status !== 'paid') return { statusCode: 200, body: 'Not paid' };

  // 2) Read what was bought (stored in the order notes by create-razorpay-order)
  const notes = order.notes || {};
  let joined = '';
  for (let k = 0; k < 11; k++) if (notes['t' + k]) joined += notes['t' + k];
  const titles = joined ? joined.split('||') : [];
  const email = String(notes.email || '').trim();
  const name = notes.name || '';
  if (!email || !titles.length) {
    log('PAID order without delivery details - deliver manually:', order.id, 'paid', order.amount_paid / 100);
    return { statusCode: 200, body: 'No delivery details' };
  }

  // 3) Don't deliver twice if Razorpay retries the same webhook
  let store = null;
  try {
    const { getSafeStore } = require('./blobs-helper');
    store = getSafeStore('razorpay-processed');
    if (await store.get(order.id, { type: 'json' }).catch(() => null)) {
      log('already delivered', order.id);
      return { statusCode: 200, body: 'Already processed' };
    }
  } catch (e) { log('dedupe store unavailable (continuing):', String(e)); }

  // 4) Email the guides
  const total = order.amount_paid / 100;   // rupees
  const siteOrigin = process.env.URL || 'https://' + (event.headers['x-forwarded-host'] || event.headers.host);
  // total is NOT passed to the mailer: it prints "$<total>" in the email, which would be wrong for rupees.
  const result = await sendGuideEmail({ name, email, titles, isFree: false, siteOrigin, log });

  if (!result.ok) {
    log('delivery failed', result.error, order.id);
    if (result.error === 'no_files_available') return { statusCode: 200, body: 'No files available' }; // retrying won't help
    return { statusCode: 500, body: 'Delivery failed' };   // Razorpay retries later
  }

  // 5) Save the order record (same format as send-guide-email) + mark as processed
  try {
    const { getSafeStore } = require('./blobs-helper');
    const orders = getSafeStore('orders');
    const key = email.toLowerCase();
    let existing = [];
    try { const r = await orders.get(key, { type: 'json' }); if (Array.isArray(r)) existing = r; } catch (e) {}
    existing.push({ name, titles: result.delivered, total, date: new Date().toISOString(), isFree: false, payment: payment ? payment.id : order.id });
    await orders.setJSON(key, existing);
    if (store) await store.setJSON(order.id, { at: new Date().toISOString(), email: key });
  } catch (e) { log('WARNING: could not save order record (email was sent):', String(e)); }

  log('delivered', order.id, '->', email);
  return { statusCode: 200, body: 'OK' };
};
