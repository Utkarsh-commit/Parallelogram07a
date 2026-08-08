// netlify/functions/admin-login.js
//
// Simple password gate for the admin dashboard (admin.html). Not a full
// user-auth system — this is a single-owner dashboard, so one shared
// password is enough. Issues a signed, time-limited token so the dashboard
// doesn't need to resend the raw password on every stats request.
//
// Includes a lockout after repeated failed attempts from the same IP, so
// the password can't just be brute-forced with unlimited guesses.
//
// SETUP REQUIRED:
// In Netlify: Site settings → Environment variables → Add variable
//   Key:   ADMIN_PASSWORD
//   Value: <pick a password only you know>
// Redeploy after adding it.

const crypto = require('crypto');
const { checkRateLimit, getClientIp } = require('./rate-limiter');

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
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_PASSWORD is not set in Netlify environment variables' }) };
  }

  // Lockout: max 5 attempts per IP per 15 minutes. Checked BEFORE looking
  // at the password, so even a correct password submitted after too many
  // wrong guesses still gets locked out — this is what actually stops
  // brute-forcing, not just slowing down failed guesses.
  const clientIp = getClientIp(event);
  const lockoutCheck = await checkRateLimit('admin-login:' + clientIp, 5, 900);
  if (!lockoutCheck.allowed) {
    console.log('[admin-login] LOCKED OUT, ip:', clientIp, '- retry after', lockoutCheck.retryAfterSeconds, 's');
    return {
      statusCode: 429, headers,
      body: JSON.stringify({ error: 'Too many failed attempts. Try again later.', retryAfterSeconds: lockoutCheck.retryAfterSeconds })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (body.password !== adminPassword) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Wrong password' }) };
  }

  const expiry = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
  const signature = crypto.createHmac('sha256', adminPassword).update(String(expiry)).digest('hex');
  const token = expiry + '.' + signature;

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, token }) };
};
