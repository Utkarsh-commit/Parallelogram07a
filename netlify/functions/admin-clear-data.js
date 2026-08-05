// netlify/functions/admin-clear-data.js
//
// Wipes dashboard data (orders, searches, or coupon usage) from Netlify
// Blobs. Destructive and irreversible — requires a valid admin token AND
// an explicit confirm:true flag, so a stray/accidental request can't wipe
// data by itself.

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

function verifyToken(token, adminPassword) {
  if (!token || typeof token !== 'string') return false;
  const [expiryStr, signature] = token.split('.');
  const expiry = Number(expiryStr);
  if (!expiry || !signature || Date.now() > expiry) return false;
  const expected = crypto.createHmac('sha256', adminPassword).update(String(expiry)).digest('hex');
  return signature === expected;
}

const STORE_NAMES = {
  orders: ['orders'],
  searches: ['searches'],
  coupons: ['events-coupon'],
  all: ['orders', 'searches', 'events-coupon']
};

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

  if (body.confirm !== true) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing confirm:true — refusing to delete without explicit confirmation' }) };
  }

  const target = body.target;
  const stores = STORE_NAMES[target];
  if (!stores) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid target. Use: orders, searches, coupons, or all' }) };
  }

  try {
    let deletedCount = 0;
    for (const storeName of stores) {
      const store = getStore(storeName);
      const { blobs } = await store.list();
      for (const blob of blobs || []) {
        await store.delete(blob.key);
        deletedCount += 1;
      }
    }
    console.log('[admin-clear-data] cleared target:', target, '- keys deleted:', deletedCount);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, target, deletedCount }) };
  } catch (err) {
    console.log('[admin-clear-data] error:', String(err));
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error', detail: String(err) }) };
  }
};
