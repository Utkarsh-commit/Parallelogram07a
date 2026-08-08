// netlify/functions/rate-limiter.js
//
// Simple fixed-window rate limiter using Netlify Blobs (no new service —
// same storage already used for orders/searches/etc). Protects functions
// that cost money or quota per call (email sends, AI search) from being
// hammered by a single source and exhausting daily limits that would
// otherwise block real customers.
//
// Not perfectly precise at window boundaries (a burst right at the
// boundary could briefly allow ~2x the limit) — that's an accepted
// tradeoff for staying simple and not needing a paid rate-limiting
// service. Good enough to stop casual/scripted abuse, which is the
// actual threat here, not a sophisticated attacker.

const { getSafeStore } = require('./blobs-helper');

// Returns { allowed: boolean, remaining: number, retryAfterSeconds?: number }
async function checkRateLimit(key, maxRequests, windowSeconds) {
  const store = getSafeStore('rate-limits');
  const now = Date.now();

  let record = null;
  try {
    record = await store.get(key, { type: 'json' });
  } catch (e) { /* no existing record — fine, treat as first request */ }

  if (!record || now - record.windowStart > windowSeconds * 1000) {
    // New window
    await store.setJSON(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: maxRequests - 1 };
  }

  if (record.count >= maxRequests) {
    const retryAfterSeconds = Math.ceil((windowSeconds * 1000 - (now - record.windowStart)) / 1000);
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  await store.setJSON(key, { count: record.count + 1, windowStart: record.windowStart });
  return { allowed: true, remaining: maxRequests - record.count - 1 };
}

// Best-effort client IP extraction across Netlify's various header conventions.
function getClientIp(event) {
  const headers = event.headers || {};
  return (
    headers['x-nf-client-connection-ip'] ||
    headers['client-ip'] ||
    (headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    'unknown'
  );
}

module.exports = { checkRateLimit, getClientIp };
