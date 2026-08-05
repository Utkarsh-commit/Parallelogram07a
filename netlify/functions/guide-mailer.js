// netlify/functions/_lib/guide-mailer.js
//
// Shared logic for emailing guide HTML files via Brevo. Used by both
// send-guide-email.js (checkout / free claim) and resend-guide.js
// (buyer re-requesting a lost guide by email, no login needed).

const SEND_FROM_EMAIL = 'parallelogram12107@gmail.com'; // must be verified in Brevo
const SEND_FROM_NAME  = 'Parallelogram';

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

// Sends the given titles' guide files to `email` via Brevo. Returns
// { ok, delivered, skipped, error?, detail? } — never throws; callers just
// check `ok` and log/return `error`/`detail` as needed.
async function sendGuideEmail({ name, email, titles, total, isFree, siteOrigin, apiKey, resend, log = () => {} }) {
  const available = titles.filter(t => GUIDE_FILES[t]);
  const unavailable = titles.filter(t => !GUIDE_FILES[t]);
  log('available:', JSON.stringify(available), 'unavailable:', JSON.stringify(unavailable));

  if (available.length === 0) {
    log('ABORT: no matching guide files for these titles');
    return { ok: false, error: 'no_files_available' };
  }

  let attachments;
  try {
    attachments = await Promise.all(
      available.map(async (title) => {
        const file = GUIDE_FILES[title];
        const url = siteOrigin + '/' + file;
        log('fetching guide file:', url);
        const res = await fetch(url);
        log('fetch result for', file, '-> status', res.status);
        if (!res.ok) throw new Error('Could not fetch ' + file + ' (status ' + res.status + ')');
        const buf = Buffer.from(await res.arrayBuffer());
        return { name: file, content: buf.toString('base64') };
      })
    );
  } catch (err) {
    log('ABORT: attachment fetch failed:', String(err));
    return { ok: false, error: 'attachment_fetch_failed', detail: String(err) };
  }

  const greeting = name ? `Hi ${name.split(' ')[0]},` : 'Hi,';
  const listHtml = available.map(t => `<li>${t}</li>`).join('');
  const missingNote = unavailable.length
    ? `<p style="color:#999;font-size:13px">The rest of your order (${unavailable.join(', ')}) is being sent separately — you'll have it shortly.</p>`
    : '';
  const introLine = resend
    ? `Here's a fresh copy of your guide${available.length > 1 ? 's' : ''}, as requested.`
    : isFree
      ? `Here's your free guide — enjoy!`
      : `Thanks for your order${total ? ' ($' + total + ')' : ''}! Your guide${available.length > 1 ? 's are' : ' is'} attached to this email as HTML files — open them in any browser for the full formatted guide.`;

  const html = `
    <div style="font-family:Arial,sans-serif;background:#121110;color:#eee;padding:32px">
      <h2 style="color:#C9A227">Your guide${available.length > 1 ? 's are' : ' is'} here 🎉</h2>
      <p>${greeting}</p>
      <p>${introLine}</p>
      <ul>${listHtml}</ul>
      ${missingNote}
      <p style="color:#999;font-size:13px">Questions? Just reply to this email.</p>
    </div>`;

  try {
    log('calling Brevo API, to:', email);
    const emailRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'api-key': apiKey
      },
      body: JSON.stringify({
        sender: { name: SEND_FROM_NAME, email: SEND_FROM_EMAIL },
        to: [{ email, name: name || undefined }],
        subject: (resend ? 'Your Parallelogram guide (resent) ' : 'Your Parallelogram guide') +
                 (available.length > 1 ? 's are' : ' is') + ' here 🎉',
        htmlContent: html,
        attachment: attachments
      })
    });

    log('Brevo response status:', emailRes.status);

    if (!emailRes.ok) {
      const detail = await emailRes.text();
      log('Brevo ERROR body:', detail);
      return { ok: false, error: 'brevo_failed', detail };
    }

    log('SUCCESS');
    return { ok: true, delivered: available, skipped: unavailable };
  } catch (err) {
    log('ABORT: internal error calling Brevo:', String(err));
    return { ok: false, error: 'internal_error', detail: String(err) };
  }
}

module.exports = { GUIDE_FILES, sendGuideEmail };
