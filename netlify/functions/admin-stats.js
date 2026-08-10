// netlify/functions/admin-stats.js
//
// Aggregates everything the admin dashboard (admin.html) displays, reading
// from the Netlify Blobs stores that other functions have been quietly
// writing to: "orders" (send-guide-email.js), "searches" (ai-search.js),
// and "events-coupon" (track-event.js, called from the frontend).
//
// Requires a valid token from admin-login.js — see that file for setup.

const crypto = require('crypto');
const { getSafeStore } = require('./blobs-helper');

function verifyToken(token, adminPassword) {
  if (!token || typeof token !== 'string') return false;
  const [expiryStr, signature] = token.split('.');
  const expiry = Number(expiryStr);
  if (!expiry || !signature || Date.now() > expiry) return false;
  const expected = crypto.createHmac('sha256', adminPassword).update(String(expiry)).digest('hex');
  return signature === expected;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_PASSWORD is not set' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!verifyToken(body.token, adminPassword)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid or expired session' }) };
  }

  try {
    // Date range filter — searches/coupons stay all-time (they're stored as
    // cumulative counters, not individually timestamped events, so a range
    // filter can't apply to them without a bigger storage redesign).
    const rangeParam = body.range || '30';
    const rangeDays = rangeParam === 'all' ? 3650 : Number(rangeParam) || 30;
    const rangeStart = new Date();
    rangeStart.setDate(rangeStart.getDate() - rangeDays);

    // ---- Orders ----
    const ordersStore = getSafeStore('orders');
    const orderKeys = await ordersStore.list();
    let allOrders = [];
    for (const blob of orderKeys.blobs || []) {
      const record = await ordersStore.get(blob.key, { type: 'json' }).catch(() => null);
      if (Array.isArray(record)) {
        allOrders = allOrders.concat(record.map(o => ({ ...o, email: blob.key })));
      }
    }

    const ordersInRange = allOrders.filter(o => o.date && new Date(o.date) >= rangeStart);

    const paidOrders = ordersInRange.filter(o => !o.isFree);
    const totalRevenue = paidOrders.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
    const totalOrders = ordersInRange.length;
    const totalPaidOrders = paidOrders.length;
    const totalFreeOrders = ordersInRange.length - paidOrders.length;

    // Orders per day, across the selected range
    const bucketDays = Math.min(rangeDays, 365); // cap chart granularity for "all"
    const dayBuckets = {};
    const now = new Date();
    for (let i = bucketDays - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dayBuckets[d.toISOString().slice(0, 10)] = { orders: 0, freeOrders: 0, revenue: 0 };
    }
    ordersInRange.forEach(o => {
      const day = (o.date || '').slice(0, 10);
      if (dayBuckets[day]) {
        if (o.isFree) {
          dayBuckets[day].freeOrders += 1;
        } else {
          dayBuckets[day].orders += 1;
        }
        dayBuckets[day].revenue += Number(o.total) || 0;
      }
    });

    // Guide popularity, within range
    const guideCounts = {};
    ordersInRange.forEach(o => {
      (o.titles || []).forEach(t => { guideCounts[t] = (guideCounts[t] || 0) + 1; });
    });
    const topGuides = Object.entries(guideCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([title, count]) => ({ title, count }));

    // ---- Searches (all-time, see note above) ----
    const searchStore = getSafeStore('searches');
    const searchKeys = await searchStore.list();
    let searches = [];
    for (const blob of searchKeys.blobs || []) {
      const record = await searchStore.get(blob.key, { type: 'json' }).catch(() => null);
      if (record) searches.push(record);
    }
    const topSearches = searches.sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 15);

    // ---- Coupon usage (all-time, see note above) ----
    const couponStore = getSafeStore('events-coupon');
    const couponKeys = await couponStore.list();
    let coupons = [];
    for (const blob of couponKeys.blobs || []) {
      const record = await couponStore.get(blob.key, { type: 'json' }).catch(() => null);
      if (record) coupons.push(record);
    }
    coupons = coupons.sort((a, b) => (b.count || 0) - (a.count || 0));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        range: rangeParam,
        totalOrders,
        totalPaidOrders,
        totalFreeOrders,
        totalRevenue,
        dayBuckets,
        topGuides,
        topSearches,
        coupons,
        recentOrders: ordersInRange.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 20)
      })
    };
  } catch (err) {
    console.log('[admin-stats] error:', String(err));
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error', detail: String(err) }) };
  }
};
