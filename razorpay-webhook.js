// Razorpay -> your site. When a payment is confirmed, emails the guides automatically.
// Needs env var in Netlify: RAZORPAY_WEBHOOK_SECRET
// In Razorpay Dashboard > Webhooks, subscribe ONLY to the "order.paid" event.
const crypto = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return { statusCode: 503, body: 'Webhook secret not set' };

  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body || '';
  const sig = event.headers['x-razorpay-signature'] || event.headers['X-Razorpay-Signature'] || '';
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!ok) return { statusCode: 400, body: 'Invalid signature' };

  let payload;
  try { payload = JSON.parse(raw); } catch (e) { return { statusCode: 400, body: 'Bad JSON' }; }
  if (payload.event !== 'order.paid') return { statusCode: 200, body: 'Ignored' };

  const order = payload.payload && payload.payload.order && payload.payload.order.entity;
  const payment = payload.payload && payload.payload.payment && payload.payload.payment.entity;
  if (!order || order.status !== 'paid') return { statusCode: 200, body: 'Not paid' };

  const notes = order.notes || {};
  let joined = '';
  for (let k = 0; k < 11; k++) if (notes['t' + k]) joined += notes['t' + k];
  const titles = joined ? joined.split('||') : [];
  if (!notes.email || !titles.length) {
    console.error('Paid order without delivery details', order.id);
    return { statusCode: 200, body: 'No delivery details' };
  }

  const base = process.env.URL || 'https://parallelogram-official.netlify.app';
  const res = await fetch(base + '/.netlify/functions/send-guide-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: notes.name || '',
      email: notes.email,
      titles,
      total: '₹' + order.amount_paid / 100 + ' INR (Razorpay ' + (payment ? payment.id : order.id) + ')',
      method: 'razorpay',
    }),
  });
  if (!res.ok) {
    console.error('send-guide-email failed', res.status, order.id);
    return { statusCode: 500, body: 'Delivery failed' };   // Razorpay will retry
  }
  return { statusCode: 200, body: 'OK' };
};
