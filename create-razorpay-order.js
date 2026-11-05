// Creates a Razorpay order for the cart. The amount is calculated HERE on the
// server (never trusted from the browser).
// Needs env vars in Netlify: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
const COUPONS = { FIRST20: 20 };      // keep in sync with CHECKOUT_COUPONS in index.html
const ALLOWED_UNITS = [199, 249];     // per-guide rupee prices the site can charge

const json = (code, body) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  // GET = "is online payment configured?" (the site calls this on load)
  if (event.httpMethod === 'GET') return json(200, { configured: !!(keyId && keySecret) });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!keyId || !keySecret) return json(503, { error: 'Razorpay is not configured' });

  let data;
  try { data = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Bad JSON' }); }

  const name = String(data.name || '').trim().slice(0, 80);
  const email = String(data.email || '').trim().slice(0, 120);
  const titles = Array.isArray(data.titles) ? data.titles.map((t) => String(t).slice(0, 120)) : [];
  const units = Array.isArray(data.units) ? data.units.map(Number) : [];

  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: 'Name and a valid email are required' });
  if (!titles.length || titles.length > 40 || titles.length !== units.length) return json(400, { error: 'Invalid cart' });
  if (!units.every((u) => ALLOWED_UNITS.includes(u))) return json(400, { error: 'Invalid price' });

  const subtotal = units.reduce((a, b) => a + b, 0);
  const code = String(data.coupon || '').toUpperCase();
  const pct = COUPONS[code] || 0;
  const total = subtotal - Math.round((subtotal * pct) / 100);
  if (total < 1) return json(400, { error: 'Invalid amount' });

  // Razorpay notes: max 15 keys, 256 chars each -> store titles in chunks
  const notes = { name, email, count: String(titles.length), coupon: code };
  const joined = titles.join('||');
  for (let i = 0, k = 0; i < joined.length && k < 11; i += 250, k++) notes['t' + k] = joined.slice(i, i + 250);

  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(keyId + ':' + keySecret).toString('base64'),
    },
    body: JSON.stringify({
      amount: total * 100,           // paise
      currency: 'INR',
      receipt: 'PG' + Date.now(),
      notes,
    }),
  });
  const order = await res.json();
  if (!res.ok || !order.id) {
    console.error('Razorpay order error', order);
    return json(502, { error: 'Could not create order' });
  }
  return json(200, { orderId: order.id, amount: order.amount, keyId, total });
};
