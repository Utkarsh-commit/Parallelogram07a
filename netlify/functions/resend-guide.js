// netlify/functions/resend-guide.js
//
// "Lost your guide? Resend it" — a buyer types their email, we look up
// what they bought (stored by send-guide-email.js in Netlify Blobs) and
// re-send it via Brevo. No password, no account, no login system needed.
//
// Netlify Blobs is a built-in Netlify feature (like this project's
// functions) — no extra signup or API key needed, unlike Brevo/Gemini.

const { sendGuideEmail } = require('./_lib/guide-mailer');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  const log = (...args) => console.log('[resend-guide]', ...args);
  log('invoked, method:', event.httpMethod);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    log('rejected: not POST');
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const email = (body.email || '').trim().toLowerCase();
  log('requested email:', email);
  if (!email) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing email' }) };
  }

  let orders = [];
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore('orders');
    const raw = await store.get(email, { type: 'json' });
    if (Array.isArray(raw)) orders = raw;
    log('found', orders.length, 'past order(s) for this email');
  } catch (err) {
    log('lookup failed (treated as no orders found):', String(err));
  }

  if (orders.length === 0) {
    log('no orders on file — nothing to resend');
    return { statusCode: 200, headers, body: JSON.stringify({ found: false }) };
  }

  // Resend every guide title they've ever received, deduplicated.
  const allTitles = Array.from(new Set(orders.flatMap(o => o.titles || [])));
  const name = orders[orders.length - 1].name || '';
  log('resending titles:', JSON.stringify(allTitles));

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    log('ABORT: no BREVO_API_KEY in environment');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'BREVO_API_KEY is not set' }) };
  }

  const siteOrigin = 'https://' + (event.headers['x-forwarded-host'] || event.headers.host);

  const result = await sendGuideEmail({
    name, email, titles: allTitles, siteOrigin, apiKey, resend: true,
    log: (...a) => log(...a)
  });

  if (!result.ok) {
    const status = result.error === 'no_files_available' ? 200 : 502;
    return { statusCode: status, headers, body: JSON.stringify({ found: true, sent: false, ...result }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ found: true, sent: true, delivered: result.delivered }) };
};
