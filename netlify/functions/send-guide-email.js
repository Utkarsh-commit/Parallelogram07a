// netlify/functions/send-guide-email.js
//
// Automatically emails purchased guide HTML files to the buyer right after they
// confirm payment. Uses Resend (https://resend.com) — simple HTTP email API,
// generous free tier (3,000 emails/month), no domain verification required
// to get started (uses their shared onboarding@resend.dev sender).
//
// SETUP REQUIRED before this works:
// 1. Create a free account at https://resend.com
// 2. Dashboard → API Keys → create one, copy it
// 3. In Netlify: Site settings → Environment variables → add:
//      Key:   RESEND_API_KEY
//      Value: <your key>
// 4. (Optional, recommended once you have a domain) Verify your own domain in
//    Resend and change SEND_FROM below to something like
//    "Parallelogram <guides@yourdomain.com>" — until then it sends from
//    Resend's shared address, which works fine but looks less branded.
// 5. Redeploy the site.
//
// This function only sends guides that actually exist as HTML files (see GUIDE_FILES
// below). Anything in the order that isn't in that list is silently skipped
// here — your existing WhatsApp notification still tells you about the full
// order either way, so you can deliver missing ones by hand.

const SEND_FROM = 'Parallelogram <onboarding@resend.dev>';

// Title (must match the site's product-title text exactly) -> HTML filename
// living at /<file> on this same deployed site (repo root).
const GUIDE_FILES = {
  'AI Skills That Actually Matter in 2026': 'ai-skills-that-actually-matter-2026.html',
  'The Art of Communicating Clearly': 'art-of-communicating-clearly.html',
  'Break Free: Quit Any Habit for Good': 'break-free-quit-any-habit.html',
  'Build Relationships That Actually Last': 'build-relationships-that-last.html',
  'Decode Human Behaviour': 'decode-human-behaviour.html',
  'Eat Smart: Nutrition & Diet Simplified': 'eat-smart-nutrition-diet-simplified.html',
  'The Daily High-Performance System': 'high-performance-system.html',
  'Learn Anything 3× Faster': 'learn-anything-3x-faster.html',
  'Lookmaxxing: The No-BS Appearance Guide': 'lookmaxxing-no-bs-appearance-guide.html',
  'Money Basics: Manage It Before It Manages You': 'money-basics-manage-it.html',
  'Own Your Time: The Anti-Busy System': 'own-your-time-anti-busy-system.html',
  'Score Higher Without Studying More': 'score-higher-without-studying-more.html',
  'Smarter Parenting in the Modern World': 'smarter-parenting-modern-world.html',
  'The Social Mastery Blueprint': 'social-mastery-blueprint.html',
  'Speak in Public Without Freezing': 'speak-in-public-without-freezing.html',
  'Start Your YouTube Channel from Zero': 'start-youtube-channel-from-zero.html',
  'Stay Positive When Life Gets Hard': 'stay-positive-when-life-gets-hard.html',
  'Think Smarter: Mental Models That Win': 'think-smarter-mental-models.html',
  'Unshakeable Confidence from the Inside Out': 'unshakeable-confidence-from-the-inside-out.html',
  'The 35 Networking Hacks That Actually Work': '35-networking-hacks.html',
  "Zero to Business: Founder's Starter Guide": 'founders-starter-guide.html',
  'Lead Without Losing People': 'lead-without-losing-people.html',
  'LinkedIn Growth: The 21-Day Playbook': 'linkedin-growth-21-day-playbook.html',
  'Grow on Social Media Without Going Viral': 'grow-social-without-viral.html'
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  console.log('[send-guide-email] invoked, method:', event.httpMethod);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    console.log('[send-guide-email] rejected: not POST');
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let order;
  try {
    order = JSON.parse(event.body || '{}');
    console.log('[send-guide-email] parsed order:', JSON.stringify(order));
  } catch (e) {
    console.log('[send-guide-email] JSON parse failed:', String(e));
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { name, email, total, titles } = order;
  if (!email || !Array.isArray(titles) || titles.length === 0) {
    console.log('[send-guide-email] missing email or titles. email=', email, 'titles=', titles);
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing email or titles' }) };
  }

  const apiKey = process.env.RESEND_API_KEY;
  console.log('[send-guide-email] RESEND_API_KEY present:', !!apiKey, apiKey ? '(len ' + apiKey.length + ')' : '');
  if (!apiKey) {
    console.log('[send-guide-email] ABORT: no RESEND_API_KEY in environment');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'RESEND_API_KEY is not set' }) };
  }

  const siteOrigin = 'https://' + (event.headers['x-forwarded-host'] || event.headers.host);
  console.log('[send-guide-email] siteOrigin:', siteOrigin);

  const available = titles.filter(t => GUIDE_FILES[t]);
  const unavailable = titles.filter(t => !GUIDE_FILES[t]);
  console.log('[send-guide-email] available:', JSON.stringify(available), 'unavailable:', JSON.stringify(unavailable));

  if (available.length === 0) {
    console.log('[send-guide-email] ABORT: no matching guide files for these titles');
    return { statusCode: 200, headers, body: JSON.stringify({ sent: false, reason: 'no_files_available' }) };
  }

  // Fetch each guide HTML file from the site root and base64-encode for attachment.
  let attachments;
  try {
    attachments = await Promise.all(
      available.map(async (title) => {
        const file = GUIDE_FILES[title];
        const url = siteOrigin + '/' + file;
        console.log('[send-guide-email] fetching guide file:', url);
        const res = await fetch(url);
        console.log('[send-guide-email] fetch result for', file, '-> status', res.status);
        if (!res.ok) throw new Error('Could not fetch ' + file + ' (status ' + res.status + ')');
        const buf = Buffer.from(await res.arrayBuffer());
        console.log('[send-guide-email] fetched', file, '-', buf.length, 'bytes');
        return { filename: file, content: buf.toString('base64') };
      })
    );
  } catch (err) {
    console.log('[send-guide-email] ABORT: attachment fetch failed:', String(err));
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Failed to prepare attachments', detail: String(err) }) };
  }

  console.log('[send-guide-email] all attachments ready, count:', attachments.length);

  const greeting = name ? `Hi ${name.split(' ')[0]},` : 'Hi,';
  const listHtml = available.map(t => `<li>${t}</li>`).join('');
  const missingNote = unavailable.length
    ? `<p style="color:#999;font-size:13px">The rest of your order (${unavailable.join(', ')}) is being sent separately — you'll have it shortly.</p>`
    : '';

  const html = `
    <div style="font-family:Arial,sans-serif;background:#121110;color:#eee;padding:32px">
      <h2 style="color:#C9A227">Your guides are here 🎉</h2>
      <p>${greeting}</p>
      <p>Thanks for your order${total ? ' ($' + total + ')' : ''}! Your guide${available.length > 1 ? 's are' : ' is'} attached to this email as HTML files — open them in any browser for the full formatted guide.</p>
      <ul>${listHtml}</ul>
      ${missingNote}
      <p style="color:#999;font-size:13px">Questions? Just reply to this email.</p>
    </div>`;

  try {
    console.log('[send-guide-email] calling Resend API, to:', email);
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        from: SEND_FROM,
        to: [email],
        subject: 'Your Parallelogram guide' + (available.length > 1 ? 's are' : ' is') + ' here 🎉',
        html,
        attachments
      })
    });

    console.log('[send-guide-email] Resend response status:', emailRes.status);

    if (!emailRes.ok) {
      const detail = await emailRes.text();
      console.log('[send-guide-email] Resend ERROR body:', detail);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Resend request failed', detail }) };
    }

    const resendBody = await emailRes.text();
    console.log('[send-guide-email] SUCCESS, Resend response:', resendBody);
    return { statusCode: 200, headers, body: JSON.stringify({ sent: true, delivered: available, skipped: unavailable }) };
  } catch (err) {
    console.log('[send-guide-email] ABORT: internal error calling Resend:', String(err));
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error', detail: String(err) }) };
  }
};
