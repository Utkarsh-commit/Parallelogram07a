// netlify/functions/lemonsqueezy-webhook.js
//
// Receives Lemon Squeezy's "order_created" webhook the moment a real
// payment succeeds, verifies it's genuinely from Lemon Squeezy (not
// spoofed), then automatically emails the guides — no "I've paid, trust
// me" button needed anymore. This is real, verified payment confirmation.
//
// SETUP REQUIRED:
// 1. In Lemon Squeezy: Settings → Webhooks → Create webhook
//    URL: https://<your-site>.netlify.app/.netlify/functions/lemonsqueezy-webhook
//    Event: order_created
//    Copy the Signing Secret it generates.
// 2. In Netlify: Site settings → Environment variables → Add:
//      Key: LEMONSQUEEZY_WEBHOOK_SECRET   Value: <the signing secret>
// 3. Redeploy.
//
// How the price/contents get communicated: the frontend builds the
// checkout URL with the cart's exact total as a "pay what you want"
// custom price, and passes the buyer's name/email/guide titles/coupon as
// Lemon Squeezy "custom data" on the checkout — that same custom data
// comes back in this webhook payload, telling us what to deliver.
//
// IMPORTANT: that browser-built URL is just editable text before payment,
// so this webhook never trusts it blindly. It independently recomputes
// what the order SHOULD cost from the real guide catalog + coupon config,
// and refuses to auto-deliver anything if the amount actually paid
// doesn't match — holding it for manual review instead. See the
// "SERVER-SIDE PRICE VERIFICATION" block below.

const crypto = require('crypto');
const { sendGuideEmail } = require('./guide-mailer');

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };
  const log = (...args) => console.log('[lemonsqueezy-webhook]', ...args);

  log('invoked, method:', event.httpMethod);

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret) {
    log('ABORT: no LEMONSQUEEZY_WEBHOOK_SECRET in environment');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'LEMONSQUEEZY_WEBHOOK_SECRET is not set' }) };
  }

  // Verify this request genuinely came from Lemon Squeezy — critical,
  // otherwise anyone could POST a fake "order_created" and get free guides.
  const signature = event.headers['x-signature'] || event.headers['X-Signature'];
  const rawBody = event.body || '';
  const expectedSig = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  const sigValid = signature &&
    crypto.timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expectedSig, 'utf8'));

  if (!sigValid) {
    log('ABORT: invalid webhook signature — request did not come from Lemon Squeezy');
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid signature' }) };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    log('JSON parse failed:', String(e));
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const eventName = payload.meta && payload.meta.event_name;
  log('event_name:', eventName);
  if (eventName !== 'order_created') {
    // Ignore other event types gracefully — still 200 so LS doesn't retry.
    return { statusCode: 200, headers, body: JSON.stringify({ ignored: true, eventName }) };
  }

  const customData = (payload.meta && payload.meta.custom_data) || {};
  const orderAttrs = (payload.data && payload.data.attributes) || {};

  const email = customData.email || orderAttrs.user_email;
  const name = customData.name || orderAttrs.user_name || '';
  const titles = customData.guides ? customData.guides.split('|').filter(Boolean) : [];
  const couponCode = (customData.coupon || '').trim().toUpperCase();
  const total = orderAttrs.total ? orderAttrs.total / 100 : 0; // LS sends cents (what was actually paid)

  log('order for:', email, '- titles:', JSON.stringify(titles), '- coupon:', couponCode || '(none)', '- paid:', total);

  if (!email || titles.length === 0) {
    log('ABORT: missing email or titles in custom_data — cannot fulfill automatically');
    // Still 200 so LS doesn't retry forever — but this needs manual follow-up.
    return { statusCode: 200, headers, body: JSON.stringify({ warning: 'Missing email or titles, manual fulfillment needed' }) };
  }

  // ---- SERVER-SIDE PRICE VERIFICATION ----
  // The checkout URL (price + guide list) is built in the browser, which
  // means both values are just editable text in a URL before payment. This
  // recomputes what the order SHOULD cost from our own guide catalog and
  // coupon config — never trusting what the browser or the buyer's device
  // claims — and refuses to deliver anything if the two don't match.
  const { GUIDE_FILES } = require('./guide-mailer');
  const GUIDE_PRICE = 4; // flat price per guide, matches index.html's cart.push price
  const CHECKOUT_COUPONS = { FIRST20: 20 }; // must match index.html's CHECKOUT_COUPONS
  const FIRST_TIME_ONLY_COUPONS = ['FIRST20']; // these only apply if the buyer has no prior PAID order

  const validTitles = titles.filter(t => GUIDE_FILES[t]);
  const invalidTitles = titles.filter(t => !GUIDE_FILES[t]);
  if (invalidTitles.length > 0) {
    log('WARNING: order contains titles not in our real catalog (ignored for pricing/delivery):', JSON.stringify(invalidTitles));
  }

  // FIRST20 is meant for first-time buyers only — actually verify that
  // server-side against real order history, not just trust the coupon
  // name/label. A free guide claim doesn't count as a "prior purchase"
  // here (that's the funnel into a first paid order, not a disqualifier).
  let effectiveCoupon = couponCode;
  if (couponCode && FIRST_TIME_ONLY_COUPONS.includes(couponCode)) {
    try {
      const { getSafeStore } = require('./blobs-helper');
      const ordersStore = getSafeStore('orders');
      const priorOrders = await ordersStore.get(email.trim().toLowerCase(), { type: 'json' }).catch(() => null);
      const hasPriorPaidOrder = Array.isArray(priorOrders) && priorOrders.some(o => !o.isFree);
      if (hasPriorPaidOrder) {
        log('WARNING:', couponCode, 'is first-time-only, but', email, 'has a prior paid order — coupon rejected for pricing');
        effectiveCoupon = '';
      }
    } catch (err) {
      // If we can't check history for some reason, fail safe: don't honor
      // a first-time discount we can't actually verify.
      log('WARNING: could not verify prior-order history for', couponCode, '- rejecting coupon to be safe:', String(err));
      effectiveCoupon = '';
    }
  }

  let expectedSubtotal = validTitles.length * GUIDE_PRICE;
  let expectedTotal = expectedSubtotal;
  if (effectiveCoupon && CHECKOUT_COUPONS[effectiveCoupon]) {
    expectedTotal = expectedSubtotal - Math.round(expectedSubtotal * CHECKOUT_COUPONS[effectiveCoupon] / 100);
  } else if (couponCode && !effectiveCoupon) {
    // already logged above (rejected as not-first-time or unverifiable)
  } else if (couponCode) {
    log('WARNING: unrecognized coupon code in order, ignoring it for pricing:', couponCode);
  }

  const priceMismatch = Math.abs(total - expectedTotal) > 0.01; // small tolerance for rounding
  log('expected total:', expectedTotal, '- actually paid:', total, '- mismatch:', priceMismatch);

  if (priceMismatch) {
    log('ABORT: PRICE MISMATCH — refusing to auto-deliver. This needs manual review before sending anything.');
    // 200 so Lemon Squeezy doesn't retry (payment itself is real and fine),
    // but we deliberately do NOT call sendGuideEmail here. Check these logs
    // and fulfill manually via the resend-guide flow once you've confirmed
    // what actually happened (legitimate case: a coupon you forgot to add
    // here; suspicious case: tampered checkout data).
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        warning: 'Price mismatch — held for manual review, not auto-delivered',
        email, titles: validTitles, expectedTotal, actuallyPaid: total, couponCode
      })
    };
  }

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    log('ABORT: no BREVO_API_KEY set');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'BREVO_API_KEY is not set' }) };
  }

  const siteOrigin = 'https://' + (event.headers['x-forwarded-host'] || event.headers.host);
  const result = await sendGuideEmail({ name, email, titles: validTitles, total, isFree: false, siteOrigin, apiKey, log: (...a) => log(...a) });

  if (!result.ok) {
    log('DELIVERY FAILED:', JSON.stringify(result));
    // Still 200 to Lemon Squeezy (payment itself succeeded, this is our
    // delivery problem, not theirs) — but log clearly for manual follow-up.
    return { statusCode: 200, headers, body: JSON.stringify({ paid: true, delivered: false, ...result }) };
  }

  // Save order record for the dashboard + resend-guide lookups.
  try {
    const { getSafeStore } = require('./blobs-helper');
    const store = getSafeStore('orders');
    const key = email.trim().toLowerCase();
    let existing = [];
    try {
      const raw = await store.get(key, { type: 'json' });
      if (Array.isArray(raw)) existing = raw;
    } catch (e) { /* no existing record — fine */ }
    existing.push({ name, titles: result.delivered, total, date: new Date().toISOString(), isFree: false });
    await store.setJSON(key, existing);
    log('order record saved for', key);
  } catch (err) {
    log('WARNING: order record save failed (email still sent fine):', String(err));
  }

  log('SUCCESS — paid and delivered automatically');
  return { statusCode: 200, headers, body: JSON.stringify({ paid: true, delivered: true }) };
};
