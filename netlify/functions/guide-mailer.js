// netlify/functions/_lib/guide-mailer.js
//
// Shared logic for emailing guide HTML files via Gmail SMTP (nodemailer).
// Used by both send-guide-email.js (checkout / free claim) and
// resend-guide.js (buyer re-requesting a lost guide by email, no login
// needed).
//
// Switched from Brevo -> Gmail SMTP because Gmail/Yahoo/Microsoft now
// require DKIM+DMARC alignment for bulk senders, and a @gmail.com address
// can never be authenticated that way when sent *through* a third party
// like Brevo (Google owns gmail.com's DMARC policy, not us). Sending
// directly through Gmail's own SMTP servers with an App Password sidesteps
// that entirely, since Gmail is then sending its own authenticated mail.
//
// Requires two Netlify environment variables:
//   GMAIL_USER          - parallelogramguides@gmail.com
//   GMAIL_APP_PASSWORD  - 16-character App Password from
//                          myaccount.google.com/apppasswords
//                          (requires 2-Step Verification enabled first)

const nodemailer = require('nodemailer');

const SEND_FROM_NAME = 'Parallelogram';

function getTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
}

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

// Sends the given titles' guide files to `email` via Gmail SMTP. Returns
// { ok, delivered, skipped, error?, detail? } — never throws; callers just
// check `ok` and log/return `error`/`detail` as needed.
//
// `apiKey` is kept as an accepted (but unused) param so existing callers
// don't need to change their call sites — Gmail auth is read directly
// from env vars inside this module instead.
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

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailPass) {
    log('ABORT: GMAIL_USER or GMAIL_APP_PASSWORD not set in environment');
    return { ok: false, error: 'gmail_not_configured' };
  }

  try {
    log('sending via Gmail SMTP, to:', email);
    const transporter = getTransporter();

    await transporter.sendMail({
      from: `"${SEND_FROM_NAME}" <${gmailUser}>`,
      to: name ? `"${name}" <${email}>` : email,
      subject: (resend ? 'Your Parallelogram guide (resent) ' : 'Your Parallelogram guide') +
               (available.length > 1 ? 's are' : ' is') + ' here 🎉',
      html,
      attachments: attachments.map(a => ({
        filename: a.name,
        content: a.content,
        encoding: 'base64'
      }))
    });

    log('SUCCESS');
    return { ok: true, delivered: available, skipped: unavailable };
  } catch (err) {
    log('ABORT: Gmail SMTP send failed:', String(err));
    return { ok: false, error: 'gmail_send_failed', detail: String(err) };
  }
}

module.exports = { GUIDE_FILES, sendGuideEmail };
