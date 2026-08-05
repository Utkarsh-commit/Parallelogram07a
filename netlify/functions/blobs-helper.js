// netlify/functions/blobs-helper.js
//
// Netlify normally auto-injects Blobs credentials (siteID + token) into
// every function automatically. On some sites — often ones that were
// transferred to a new Netlify account, like this one — that
// auto-injection silently fails, causing:
//   MissingBlobsEnvironmentError: The environment has not been
//   configured to use Netlify Blobs.
//
// Fix: supply the credentials explicitly instead of relying on
// auto-injection. Every function that touches Blobs should call
// getSafeStore(name) from this file instead of getStore(name) directly.
//
// SETUP REQUIRED:
// 1. Netlify → Site settings → General → Site details → copy the
//    "Site ID" (sometimes labeled "Project ID")
// 2. Netlify → click your avatar (top right) → User settings →
//    Applications → Personal access tokens → New access token → copy it
// 3. Netlify → Site settings → Environment variables → add both:
//      Key: BLOBS_SITE_ID   Value: <site ID from step 1>
//      Key: BLOBS_TOKEN     Value: <token from step 2>
// 4. Redeploy

const { getStore } = require('@netlify/blobs');

function getSafeStore(name) {
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_TOKEN;
  if (siteID && token) {
    return getStore({ name, siteID, token });
  }
  // Fall back to auto-injection in case it does work in this environment —
  // this keeps things working for anyone whose site doesn't hit the bug.
  return getStore(name);
}

module.exports = { getSafeStore };
