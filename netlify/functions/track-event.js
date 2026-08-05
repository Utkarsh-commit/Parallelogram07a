// netlify/functions/track-event.js
//
// Generic, lightweight event logger for the admin dashboard. Currently used
// for coupon-usage tracking (coupon codes are applied entirely client-side,
// so there's no other server touchpoint to log them from). Reusable for any
// future event you want to see counted on the dashboard.
//
// Fire-and-forget from the frontend — never blocks the user's action if
// this fails or is slow.

const { getSafeStore } = require('./blobs-helper');

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

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const type = (body.type || '').trim();
  const label = (body.label || '').trim() || 'unlabeled';
  if (!type) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing type' }) };
  }

  try {
    const store = getSafeStore('events-' + type);
    const key = label.toLowerCase();
    const existing = await store.get(key, { type: 'json' }).catch(() => null);
    const count = (existing && existing.count) || 0;
    await store.setJSON(key, { label, count: count + 1, lastSeen: new Date().toISOString() });
    console.log('[track-event]', type, label, '->', count + 1);
  } catch (e) {
    console.log('[track-event] logging failed (non-fatal):', String(e));
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
