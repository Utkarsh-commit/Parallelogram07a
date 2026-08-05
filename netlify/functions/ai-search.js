// netlify/functions/ai-search.js
//
// AI-powered semantic search for Parallelogram guides.
// Understands intent ("something to help me speak up in meetings") instead of
// just keyword overlap, using Google's Gemini API to match a search query
// against the guide catalog below.
//
// Uses Gemini instead of Claude because Google's Gemini API has a genuine
// no-credit-card free tier (1,500 requests/day) that doesn't expire —
// unlike most providers, which require billing setup before issuing a key.
//
// SETUP REQUIRED before this works:
// 1. Go to https://aistudio.google.com (Google AI Studio)
// 2. Sign in with any Google account — no credit card needed
// 3. Click "Get API key" → "Create API key" → copy it
// 4. In Netlify: Site settings → Environment variables → Add variable
//      Key:   GEMINI_API_KEY
//      Value: <your key>
// 5. Redeploy the site (env vars only take effect on a fresh deploy)
//
// The frontend calls this at /.netlify/functions/ai-search and falls back
// silently to local keyword search if this function isn't deployed yet or
// returns an error — so the site keeps working either way.

const GUIDES = [
  { title: 'The 35 Networking Hacks That Actually Work', category: 'Networking', hints: ['The "3-touch follow-up" method that turns strangers into allies within a week', 'Why most people fail at networking — and the single mindset shift that fixes it'] },
  { title: 'Zero to Business: Founder\'s Starter Guide', category: 'Business Building', hints: ['The "pain-pull test" — validate your idea in 48 hours before spending a rupee', 'Why 90% of first businesses fail by month 3, and what the 10% do differently'] },
  { title: 'The Social Mastery Blueprint', category: 'Social Skills', hints: ['The "FORD" conversation framework — never awkward silence again in any situation', 'Charisma is learnable: the 4 observable habits of people everyone is drawn to'] },
  { title: 'Lead Without Losing People', category: 'Team Management', hints: ['The "SBI feedback model" — give criticism that improves performance, not resentment', 'Why smart teams still fail: the hidden cost of unspoken conflict and how to surface it'] },
  { title: 'The Daily High-Performance System', category: 'Mindset', hints: ['The "90/90/1 rule" — one focus for 90 minutes a day that outliers quietly use', 'Why willpower fails by 2pm every day, and the system that makes discipline automatic'] },
  { title: 'LinkedIn Growth: The 21-Day Playbook', category: 'Networking', hints: ['The "3-2-1 posting formula" that grows your audience without chasing trends', 'Profile psychology: what decision-makers look for in the first 8 seconds on your page'] },
  { title: 'Learn Anything 3× Faster', category: 'Academics', hints: ['The Feynman Technique: if you can\'t explain it simply, you don\'t understand it yet', 'Spaced repetition science — why cramming erases memory instead of building it'] },
  { title: 'Lookmaxxing: The No-BS Appearance Guide', category: 'Lifestyle', hints: ['The "halo effect" — science shows appearance shapes how people judge your intelligence', 'A 3-step skincare routine that costs under $8/month and actually works'] },
  { title: 'Build Relationships That Actually Last', category: 'Social Skills', hints: ['The "vulnerability loop" — why oversharing early kills trust, and what to do instead', 'Research-backed: the #1 predictor of whether a friendship survives long-term'] },
  { title: 'Decode Human Behaviour', category: 'Psychology', hints: ['The 6 universal drivers of all human action — distilled from 40 years of behavioural research', 'Confirmation bias, anchoring & loss aversion: the invisible forces steering everyone\'s decisions'] },
  { title: 'Score Higher Without Studying More', category: 'Academics', hints: ['The 80/20 syllabus rule — 20% of topics appear in 80% of exam questions every year', 'Answer presentation tricks that earn partial marks even when you don\'t know the full answer'] },
  { title: 'Start Your YouTube Channel from Zero', category: 'Creator', hints: ['Niche selection framework: the intersection of passion, demand & low competition', 'The "4-second hook" rule — YouTube decides to recommend your video in the first 4 seconds'] },
  { title: 'AI Skills That Actually Matter in 2026', category: 'Creator', hints: ['The 10 AI tools replacing what used to cost thousands — all free or freemium', 'Prompt engineering: the difference between a bad answer and a brilliant one is the question'] },
  { title: 'The Art of Communicating Clearly', category: 'Social Skills', hints: ['The "pyramid principle" — start with the answer, not the context (used by McKinsey consultants)', 'Why most people talk too much and say too little: the silence-as-power principle'] },
  { title: 'Stay Positive When Life Gets Hard', category: 'Mindset', hints: ['Negativity bias is wired into your brain — here\'s how to rewire it in 21 days', 'The Stoic "dichotomy of control": stop spending energy on what you cannot change'] },
  { title: 'Break Free: Quit Any Habit for Good', category: 'Lifestyle', hints: ['The dopamine loop explained: why your brain fights you when you try to quit', '"Habit stacking" in reverse — dismantling triggers before they activate the craving'] },
  { title: 'Smarter Parenting in the Modern World', category: 'Lifestyle', hints: ['Authoritative vs. authoritarian parenting — the difference that shapes a child\'s entire adulthood', 'How to talk to children about failure so they grow up resilient, not fearful of it'] },
  { title: 'Think Smarter: Mental Models That Win', category: 'Psychology', hints: ['First-principles thinking — how Elon Musk and Jeff Bezos break problems everyone else accepts', 'Inversion: solve any problem by asking "what would make this guaranteed to fail?"'] },
  { title: 'Eat Smart: Nutrition & Diet Simplified', category: 'Lifestyle', hints: ['What your brain runs on: the foods that directly impact focus, mood & memory', 'The top 10 nutrition myths the food industry wants you to keep believing'] },
  { title: 'Money Basics: Manage It Before It Manages You', category: 'Business', hints: ['The 50/30/20 rule — the only budget framework you\'ll ever need, explained simply', 'Why your savings account is quietly making you poorer (and what to do about it)'] },
  { title: 'Speak in Public Without Freezing', category: 'Social Skills', hints: ['Public speaking anxiety is evolutionary — it\'s your brain protecting you from a threat that isn\'t there', 'The "PREP" framework: structure any speech in 4 minutes that sounds prepared for hours'] },
  { title: 'Own Your Time: The Anti-Busy System', category: 'Mindset', hints: ['Parkinson\'s Law: work expands to fill the time you give it — here\'s how to use that against itself', 'The "MIT method" — identify your 1 Most Important Task before opening your phone each morning'] },
  { title: 'Unshakeable Confidence from the Inside Out', category: 'Mindset', hints: ['Confidence is not a feeling — it\'s a decision followed by action repeated until it becomes default', 'The "confidence-competence loop": a framework for building belief through evidence, not affirmations'] },
  { title: 'Grow on Social Media Without Going Viral', category: 'Creator', hints: ['Virality is random — consistent audience growth is a system (here\'s the system)', 'The "content pillar" method: 3 topics that make your page impossible to ignore or unfollow'] }
];

const SYSTEM_PROMPT = `You are the search engine for Parallelogram, a store selling short, practical knowledge guides.
You will be given a user's search query and a numbered catalog of guides (title, category, and two sample bullets).
Return the guides that are genuinely relevant to the user's intent — including cases where the query uses
different words than the guide (e.g. "shy" should match a guide about social confidence).
Respond with ONLY a JSON array of the matching titles, copied EXACTLY as they appear in the catalog. No other
text, no markdown fences, no explanation. If nothing is relevant, respond with []. Do not include weak or
tangential matches — only guides a shopper searching that term would actually want.`;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  console.log('[ai-search] invoked, method:', event.httpMethod);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    console.log('[ai-search] rejected: not POST');
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let query;
  try {
    query = JSON.parse(event.body || '{}').query;
    console.log('[ai-search] query:', query);
  } catch (e) {
    console.log('[ai-search] JSON parse failed:', String(e));
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!query || typeof query !== 'string' || !query.trim()) {
    console.log('[ai-search] empty query, returning no matches');
    return { statusCode: 200, headers, body: JSON.stringify({ matches: [] }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  console.log('[ai-search] GEMINI_API_KEY present:', !!apiKey, apiKey ? '(len ' + apiKey.length + ')' : '');
  if (!apiKey) {
    console.log('[ai-search] ABORT: no GEMINI_API_KEY in environment');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'GEMINI_API_KEY is not set in Netlify environment variables' })
    };
  }

  const catalog = GUIDES
    .map((g, i) => `${i + 1}. "${g.title}" — [${g.category}] ${g.hints.join(' | ')}`)
    .join('\n');

  // Google renames/retires Gemini model IDs fairly often. Try the current
  // model first; if it 404s (renamed again), automatically fall back to a
  // second candidate instead of breaking silently until someone notices.
  const MODEL_CANDIDATES = ['gemini-3.5-flash-lite', 'gemini-2.5-flash'];

  async function callGemini(model) {
    console.log('[ai-search] trying model:', model);
    const apiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [
            { role: 'user', parts: [{ text: `Query: "${query.trim()}"\n\nCatalog:\n${catalog}` }] }
          ],
          generationConfig: { maxOutputTokens: 400 }
        })
      }
    );
    console.log('[ai-search] model', model, '-> status', apiRes.status);
    return apiRes;
  }

  try {
    let apiRes = await callGemini(MODEL_CANDIDATES[0]);

    if (apiRes.status === 404 && MODEL_CANDIDATES[1]) {
      console.log('[ai-search] primary model 404d, trying fallback');
      apiRes = await callGemini(MODEL_CANDIDATES[1]);
    }

    if (!apiRes.ok) {
      const detail = await apiRes.text();
      console.log('[ai-search] Gemini ERROR body:', detail);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'AI request failed', detail }) };
    }

    const data = await apiRes.json();
    const text = ((data.candidates || [])[0]?.content?.parts || [])
      .map(p => p.text || '')
      .join('')
      .trim()
      .replace(/```json|```/g, '')
      .trim();

    console.log('[ai-search] raw Gemini text:', text);

    let matches = [];
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const validTitles = new Set(GUIDES.map(g => g.title));
        matches = parsed.filter(t => validTitles.has(t));
      }
    } catch (e) {
      console.log('[ai-search] failed to parse Gemini output as JSON:', String(e));
      matches = [];
    }

    console.log('[ai-search] SUCCESS, matches:', JSON.stringify(matches));

    // Best-effort logging for the admin dashboard's "popular searches" view.
    // Never blocks or fails the actual search response.
    try {
      const { getStore } = require('@netlify/blobs');
      const store = getStore('searches');
      const key = query.trim().toLowerCase();
      const existing = await store.get(key, { type: 'json' }).catch(() => null);
      const count = (existing && existing.count) || 0;
      await store.setJSON(key, { query: query.trim(), count: count + 1, lastSeen: new Date().toISOString() });
    } catch (e) {
      console.log('[ai-search] search logging failed (non-fatal):', String(e));
    }

    return { statusCode: 200, headers, body: JSON.stringify({ matches }) };
  } catch (err) {
    console.log('[ai-search] ABORT: internal error calling Gemini:', String(err));
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error', detail: String(err) }) };
  }
};
