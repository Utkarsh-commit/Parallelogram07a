// netlify/functions/send-guide-email.js
//
// Automatically emails guide HTML files to a buyer (paid checkout) or a
// claimant (free guide form) right after they submit. Uses Brevo — see
// _lib/guide-mailer.js for the email-sending logic and setup steps.
//
// On success, also saves a lightweight order record to Netlify Blobs
// (no setup needed — it's a built-in Netlify feature, not a separate
// service) keyed by the buyer's email. This lets resend-guide.js look up
// "what did this email buy?" later, so a buyer who loses the email can
// get it re-sent just by typing their email again — no account/login
// system needed.

const { sendGuideEmail } = require('./_lib/guide-mailer');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  const log = (...args) => console.log('[send-guide-email]', ...args);
  log('invoked, method:', event.httpMethod);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    log('rejected: not POST');
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let order;
  try {
    order = JSON.parse(event.body || '{}');
    log('parsed order:', JSON.stringify(order));
  } catch (e) {
    log('JSON parse failed:', String(e));
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { name, email, total, titles, isFree } = order;
  if (!email || !Array.isArray(titles) || titles.length === 0) {
    log('missing email or titles. email=', email, 'titles=', titles);
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing email or titles' }) };
  }

  const apiKey = process.env.BREVO_API_KEY;
  log('BREVO_API_KEY present:', !!apiKey, apiKey ? '(len ' + apiKey.length + ')' : '');
  if (!apiKey) {
    log('ABORT: no BREVO_API_KEY in environment');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'BREVO_API_KEY is not set' }) };
  }

  const siteOrigin = 'https://' + (event.headers['x-forwarded-host'] || event.headers.host);
  log('siteOrigin:', siteOrigin);

  const result = await sendGuideEmail({ name, email, titles, total, isFree, siteOrigin, apiKey, log: (...a) => log(...a) });

  if (!result.ok) {
    const status = result.error === 'no_files_available' ? 200
      : result.error === 'attachment_fetch_failed' ? 502
      : result.error === 'brevo_failed' ? 502
      : 500;
    return { statusCode: status, headers, body: JSON.stringify({ sent: false, ...result }) };
  }

  // Save order record for future "resend my guide" lookups. Best-effort —
  // if this fails, the buyer still got their email just now, so we don't
  // fail the request over it.
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore('orders');
    const key = email.trim().toLowerCase();
    let existing = [];
    try {
      const raw = await store.get(key, { type: 'json' });
      if (Array.isArray(raw)) existing = raw;
    } catch (e) { /* no existing record yet — fine */ }
    existing.push({ name: name || '', titles: result.delivered, total: total || 0, date: new Date().toISOString(), isFree: !!isFree });
    await store.setJSON(key, existing);
    log('order record saved for', key, '- total orders on file:', existing.length);
  } catch (err) {
    log('WARNING: failed to save order record (email still sent fine):', String(err));
  }

  return { statusCode: 200, headers, body: JSON.stringify({ sent: true, delivered: result.delivered, skipped: result.skipped }) };
};
