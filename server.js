// Nova Backend Server
// This is the "brain" that sits between your phone app and Groq's AI API.
// Your API key lives ONLY here - never in the mobile app.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const path = require('path');
const fs = require('fs');
const registerNovaLabRoutes = require('./server-additions');

// Render sits behind a reverse proxy - this tells Express to trust the
// X-Forwarded-For header so express-rate-limit can identify users correctly.
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY =process.env.GEMINI_API_KEY; // optional - only /generate-image and /vision-search need this
const HF_API_KEY = process.env.HF_API_KEY; // optional - only /generate-video needs this (free, no Gemini)
// Tripo Developer API v3 - the ONLY 3D generation provider now (Pollinations
// 3D was removed - unreliable free tier, kept 402ing with "insufficient
// balance"). Get a key at platform.tripo3d.ai -> API Keys, then set
// TRIPO_API_KEY in this backend's .env (local) or in Render's Environment
// tab (production). Leave unset and /api/tripo/generate-3d returns a clear
// "not configured" message instead of failing oddly.
const TRIPO_API_KEY = process.env.TRIPO_API_KEY;
// Groq retired llama-3.3-70b-versatile on Aug 16, 2026. Using their
// recommended replacement - same "everyday chat" tier, faster inference.
const GROQ_MODEL = 'openai/gpt-oss-120b';
// Groq's own vision-capable model, used only for chat messages that have a
// photo attached - GROQ_MODEL above (gpt-oss-120b) is text-only. Same
// GROQ_API_KEY, same OpenAI-compatible endpoint, no separate key needed.
const GROQ_VISION_MODEL = 'qwen/qwen3.8-27b';

if (!GROQ_API_KEY) {
  console.error('ERROR: GROQ_API_KEY is missing. Add it in your .env file (local) or Render environment variables (deployed).');
  process.exit(1);
}

if (!GEMINI_API_KEY) {
  console.warn('WARNING: GEMINI_API_KEY is missing. /generate-image and /vision-search will return a "not configured" error until you add it.');
}

if (!HF_API_KEY) {
  console.warn('WARNING: HF_API_KEY is missing. /generate-video will return a "not configured" error until you add a free token from huggingface.co/settings/tokens.');
}

app.use(cors());
app.use(express.json());

// Serves uploaded files AND generated images back to the app, e.g.
// GET /files/<uuid>.png - without this, /generate-image "succeeds" on the
// server but the app has nothing to actually load.
app.use('/files', express.static(path.join(__dirname, 'uploads')));

// Log every incoming request - helpful for confirming the app is actually
// reaching this server while you're testing. Shows up in Render's Logs tab.
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Basic protection: max 60 chat requests per 15 minutes per device/IP.
// This protects your free Groq quota from being drained accidentally.
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Please wait a bit and try again.' }
});

// Nova's personality lives here. Edit anytime, or let the app pick one of these.
const NOVA_PERSONALITIES = {
  friendly: `You are Nova, a friendly and helpful personal AI assistant.
You speak in a warm, casual, and supportive tone - like a knowledgeable friend, not a formal chatbot.
Keep replies clear and not overly long unless the user asks for detail.
You can reply in English or Tamil depending on what language the user writes in.
If the user seems to be a developer, you can go technical when relevant, but always stay approachable.`,
  jarvis: `You are Nova, styled after JARVIS from Iron Man - composed, precise, quietly witty, unfailingly polite.
Address the user respectfully. Keep replies efficient and clear, with occasional dry humor, never rambling.
You can reply in English or Tamil depending on what language the user writes in.`,
  concise: `You are Nova. Answer as briefly as possible while staying accurate and complete.
No filler, no pleasantries, straight to the point. Use bullet points for lists.
You can reply in English or Tamil depending on what language the user writes in.`,
  motivator: `You are Nova, an upbeat, encouraging personal assistant who keeps the user motivated and positive
without being over the top or dismissive of real problems. Warm, energetic tone.
You can reply in English or Tamil depending on what language the user writes in.`,
  companion: `You are Nova, hanging out in a relaxed voice chat with a close friend - not doing task work right now, just talking.
Be genuinely curious: ask natural follow-up questions, react to what they share, bring up light topics of your own.
Talk like a real friend having a spoken conversation - short, casual turns, contractions, natural filler, not a formal
paragraph. Never sound like a customer support agent. Keep each reply brief (1-3 sentences) since this is spoken aloud.
You can reply in English or Tamil depending on what language the user speaks in.`
};

// Applied to every personality - handles messy/typo'd input the same way
// a sharp human assistant would: understand the intended meaning and just
// answer that, instead of getting stuck on the wording or asking the user
// to rephrase.
const TYPO_TOLERANCE_INSTRUCTION = `
If the user's message has spelling mistakes, typos, or awkward grammar, silently work out what they actually meant and answer THAT - don't point out the mistake, don't ask them to rephrase, and don't answer a literal misreading of a garbled word.`;

const getSystemPrompt = (personality) =>
  (NOVA_PERSONALITIES[personality] || NOVA_PERSONALITIES.friendly) + TYPO_TOLERANCE_INSTRUCTION;

// AI models have no access to the real clock/calendar - they can only guess.
// Catch time/date questions here and answer with real server time instead.
const TIME_PATTERN = /\b(what('?s| is) the time|current time|time now|what time|neram)\b/i;
const DATE_PATTERN = /\b(what('?s| is) the date|today'?s date|what day is it|current date)\b/i;
const TAMIL_REQUEST = /\btamil\b|தமிழ்/i;

// Translates a plain English fact into natural Tamil using Groq, so times/
// dates/weather stay factually correct (we compute the real fact first)
// while the phrasing itself is genuinely translated, not guessed.
const translateToTamil = async (englishText) => {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: 'You are a translator. Translate the given English text into natural, spoken Tamil. Output ONLY the Tamil translation, nothing else.' },
        { role: 'user', content: englishText }
      ],
      temperature: 0.3
    })
  });
  if (!response.ok) return englishText; // fall back to English if translation fails
  const data = await response.json();
  return data?.choices?.[0]?.message?.content?.trim() || englishText;
};

const getRealTimeAnswer = async (message) => {
  const now = new Date();
  const options = { timeZone: 'Asia/Kolkata' }; // Adjust if you're not in India
  const wantsTamil = TAMIL_REQUEST.test(message);

  if (TIME_PATTERN.test(message)) {
    const time = now.toLocaleTimeString('en-IN', { ...options, hour: '2-digit', minute: '2-digit' });
    const answer = `It's ${time} right now.`;
    return wantsTamil ? await translateToTamil(answer) : answer;
  }
  if (DATE_PATTERN.test(message)) {
    const date = now.toLocaleDateString('en-IN', { ...options, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const answer = `Today is ${date}.`;
    return wantsTamil ? await translateToTamil(answer) : answer;
  }
  return null;
};

// Health check - visit this URL in a browser to confirm the server is alive
app.get('/', (req, res) => {
  res.json({ status: 'Nova backend is running', time: new Date().toISOString() });
});

// Main chat endpoint - the mobile app calls this
// Same uploads folder /upload and /files serve from (server-additions.js
// keeps its own UPLOAD_DIR constant pointing at the same path - both
// files live next to each other, so this stays in sync automatically).
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// "Analyze this shirt and tell about it" etc. - a normal chat message that
// also has a photo attached. Uses Groq's own vision model (qwen3.8-27b) -
// same GROQ_API_KEY as normal chat, no Gemini key needed. gpt-oss-120b
// (GROQ_MODEL, used below for text-only messages) can't see images at all.
async function handleChatWithImage(req, res, message, history, attachment) {
  try {
    // The upload URL is always "/files/<fileId+ext>" (see /upload in
    // server-additions.js) - the file itself lives right there in
    // UPLOAD_DIR under that same name, so it's read directly off disk
    // instead of the backend making an HTTP request to itself.
    const fileName = path.basename(String(attachment.url || ''));
    const filePath = path.join(UPLOAD_DIR, fileName);
    if (!fileName || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'That photo is no longer available - try attaching it again.' });
    }

    const imageBuffer = fs.readFileSync(filePath);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = attachment.mimeType && attachment.mimeType.startsWith('image/') ? attachment.mimeType : 'image/jpeg';

    // Same OpenAI-style messages array the text-only path below builds,
    // just with the final user turn's content as an array so the image can
    // sit alongside the text (the vision-model shape Groq's API expects).
    const messages = [{ role: 'system', content: getSystemPrompt(req.body.personality) }];
    if (Array.isArray(history)) {
      for (const turn of history) {
        if (turn && turn.role && turn.text) {
          messages.push({ role: turn.role === 'nova' ? 'assistant' : 'user', content: turn.text });
        }
      }
    }
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: message },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
      ]
    });

    const visionRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({ model: GROQ_VISION_MODEL, messages })
    });
    if (!visionRes.ok) {
      const errText = await visionRes.text();
      console.error('Groq vision chat error:', errText);
      return res.status(502).json({ error: 'Nova could not look at that photo right now. Try again shortly.' });
    }
    const visionData = await visionRes.json();
    const reply = visionData?.choices?.[0]?.message?.content;
    if (!reply) return res.status(502).json({ error: 'Nova got an empty response looking at that photo.' });

    res.json({ reply: reply.trim() });
  } catch (err) {
    console.error('Server error (chat with image):', err);
    res.status(500).json({ error: 'Something went wrong looking at that photo.' });
  }
}

app.post('/chat', chatLimiter, async (req, res) => {
  try {
    const { message, history, personality, attachments } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    // BUG FIX: attachments were already being sent here from the app
    // (uploaded photo's fileId/url), but this route never read them - it
    // only ever sent the typed text to Groq's text-only model, which then
    // correctly but unhelpfully said "I'm not able to view images
    // directly" every single time, even though the photo really had been
    // uploaded. An attached image now goes to Gemini's vision model
    // instead of Groq, with the photo actually attached.
    const imageAttachment = Array.isArray(attachments)
      ? attachments.find((a) => a && typeof a.mimeType === 'string' && a.mimeType.startsWith('image/'))
      : null;
    if (imageAttachment) {
      return handleChatWithImage(req, res, message, history, imageAttachment);
    }

    // Answer time/date questions instantly with real server time,
    // skipping the AI call entirely (faster, and actually correct).
    const realTimeAnswer = await getRealTimeAnswer(message);
    if (realTimeAnswer) {
      return res.json({ reply: realTimeAnswer });
    }

    // Build OpenAI-style messages array for Groq: system prompt, then
    // conversation history, then the newest user message.
    const messages = [{ role: 'system', content: getSystemPrompt(personality) }];

    if (Array.isArray(history)) {
      for (const turn of history) {
        if (turn && turn.role && turn.text) {
          messages.push({
            role: turn.role === 'nova' ? 'assistant' : 'user',
            content: turn.text
          });
        }
      }
    }

    messages.push({ role: 'user', content: message });

    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({ model: GROQ_MODEL, messages })
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text();
      console.error('Groq API error:', errText);
      return res.status(502).json({ error: 'Nova could not reach the AI service. Try again shortly.' });
    }

    const data = await groqResponse.json();
    const reply = data?.choices?.[0]?.message?.content;

    if (!reply) {
      return res.status(502).json({ error: 'Nova got an empty response. Try rephrasing your message.' });
    }

    res.json({ reply });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Something went wrong on Nova\'s side.' });
  }
});

// Fun tab endpoint - short, punchy, playful content. Kept separate from
// /chat so it doesn't carry conversation history and stays fast/cheap.
const FUN_PROMPTS = {
  joke: 'Tell me one short, original, clean joke. Just the joke, no preamble.',
  fact: 'Tell me one surprising, true fun fact. One or two sentences, no preamble.',
  wyr: 'Give me one fun, light "would you rather" question with two options. No preamble, no explanation.',
  roast: 'Give me one playful, lighthearted, friendly roast one-liner aimed at "the user" in a fun way, nothing mean-spirited or offensive. No preamble.'
};

app.post('/fun', chatLimiter, async (req, res) => {
  try {
    const { kind } = req.body;
    const prompt = FUN_PROMPTS[kind];

    if (!prompt) {
      return res.status(400).json({ error: 'Unknown fun type requested.' });
    }

    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: 'You are Nova in a playful mood. Keep it short, fun, and family-friendly.' },
          { role: 'user', content: prompt }
        ],
        temperature: 1.1
      })
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text();
      console.error('Groq API error (fun):', errText);
      return res.status(502).json({ error: 'Nova could not think of anything fun right now. Try again shortly.' });
    }

    const data = await groqResponse.json();
    const reply = data?.choices?.[0]?.message?.content;

    if (!reply) {
      return res.status(502).json({ error: 'Nova drew a blank. Try again.' });
    }

    res.json({ reply: reply.trim() });
  } catch (err) {
    console.error('Server error (fun):', err);
    res.status(500).json({ error: 'Something went wrong on Nova\'s side.' });
  }
});

// Translate endpoint - used by the Translate button in the Fun tab,
// and reusable for translating any Nova reply.
app.post('/translate', chatLimiter, async (req, res) => {
  try {
    const { text, target } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text is required.' });
    }
    const targetLang = target || 'Tamil';

    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: `You are a translator. Translate the given text into natural, spoken ${targetLang}. Output ONLY the translation, nothing else.` },
          { role: 'user', content: text }
        ],
        temperature: 0.3
      })
    });

    if (!groqResponse.ok) {
      return res.status(502).json({ error: 'Translation service unavailable right now.' });
    }
    const data = await groqResponse.json();
    const translated = data?.choices?.[0]?.message?.content?.trim();
    if (!translated) return res.status(502).json({ error: 'Got an empty translation.' });

    res.json({ translated });
  } catch (err) {
    console.error('Server error (translate):', err);
    res.status(500).json({ error: 'Something went wrong translating that.' });
  }
});

// Weather endpoint - real current weather via Open-Meteo (free, no API key
// needed). Defaults to Chennai; pass ?lat=&lon=&place= to override.
const WEATHER_CODES = {
  0: 'clear sky', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'depositing rime fog',
  51: 'light drizzle', 53: 'moderate drizzle', 55: 'dense drizzle',
  61: 'light rain', 63: 'moderate rain', 65: 'heavy rain',
  71: 'light snow', 73: 'moderate snow', 75: 'heavy snow',
  80: 'light rain showers', 81: 'moderate rain showers', 82: 'violent rain showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail'
};

app.get('/weather', async (req, res) => {
  try {
    const lat = req.query.lat || '13.0827';
    const lon = req.query.lon || '80.2707';
    const place = req.query.place || 'Chennai';

    const response = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`
    );
    if (!response.ok) return res.status(502).json({ error: 'Weather service unavailable right now.' });

    const data = await response.json();
    const cw = data.current_weather;
    if (!cw) return res.status(502).json({ error: 'No weather data available.' });

    const condition = WEATHER_CODES[cw.weathercode] || 'unusual conditions';
    res.json({
      place,
      temperatureC: cw.temperature,
      windSpeedKmh: cw.windspeed,
      condition,
      reply: `It's currently ${cw.temperature}°C with ${condition} in ${place}, wind at ${cw.windspeed} km/h.`
    });
  } catch (err) {
    console.error('Server error (weather):', err);
    res.status(500).json({ error: 'Something went wrong getting the weather.' });
  }
});

// News endpoint - was general world news (BBC), changed to AI-specific
// news: how AI is improving day to day and its impact/progress across
// countries, not general world events. Google News' public RSS search
// (free, no API key) is used instead of a single outlet's feed, so
// headlines are pulled from many different publishers and countries in
// one request.
//
// BUG FIX: RSS titles come wrapped as <title><![CDATA[Some headline]]>
// </title> - the old code only stripped the <title> tags, so the raw
// "<![CDATA[...]]>" markers were sent straight to the app and shown
// on screen exactly like that. decodeRssTitle() below strips the CDATA
// wrapper and un-escapes the handful of HTML entities RSS feeds commonly
// use (&amp; &quot; etc.), so headlines read as plain text.
function decodeRssTitle(raw) {
  let t = raw.trim();
  const cdata = t.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) t = cdata[1];
  t = t
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    // Catch-all for any other numeric entity (&#8217; &#x2019; etc.) that
    // slipped through - this is what was still showing as raw symbols
    // even after the fixes above, since those only covered a few named
    // entities and missed numeric ones entirely.
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
  return t.trim();
}

// Best-effort, keyword-based tag for whether a headline leans toward a
// risk/concern or a positive development - not a real classifier, just a
// quick visual cue since AI news genuinely comes in both flavors and the
// user wants to see both, not just one.
const AI_RISK_WORDS = /\b(warn(?:s|ing)?|risk|danger(?:ous)?|threat|job loss(?:es)?|layoffs?|scam|fraud|deepfake|misinformation|disinformation|bias(?:ed)?|lawsuit|sues?|sued|ban(?:s|ned)?|regulat(?:e|ion|ors?)|crackdown|hallucinat\w*|cyberattack|surveillance|privacy concern|copyright|fake|harm(?:ful)?|backlash|controvers(?:y|ial)|shut ?down|security flaw|vulnerab\w*|exploit(?:ed)?)\b/i;
const AI_POSITIVE_WORDS = /\b(breakthrough|advance(?:s|ment)?|boosts?|improves?|unveils?|launche?s?|discovers?|cures?|efficienc\w*|accelerat\w*|innovat\w*|partnership|funding|invests?|growth|milestone|record|success(?:ful)?|helps?|benefit\w*|life-?sav\w*)\b/i;
function tagAiHeadline(title) {
  if (AI_RISK_WORDS.test(title)) return `\u26A0\uFE0F ${title}`;
  if (AI_POSITIVE_WORDS.test(title)) return `\u2705 ${title}`;
  return title;
}

// AI model comparison - what the Fun tab's "AI news" was missing: the
// Google News RSS feed above only returns generic headlines, never a
// breakdown of what actually changed in ChatGPT/Claude/Gemini specifically.
// This asks Groq's text model directly for a short, current-as-of-training
// comparison, since there's no single feed for "what's new across the big
// three assistants" the way there is for general news.
app.get('/ai-comparison', async (req, res) => {
  try {
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are a neutral AI-industry analyst. Compare ChatGPT (OpenAI), ' +
              'Claude (Anthropic), and Gemini (Google) for a general reader. For ' +
              'EACH of the three, give: (1) one line on its recent strengths/' +
              'improvements, (2) one line on its main disadvantages/limitations. ' +
              'Be balanced - don\'t favor one over the others. End with one short ' +
              'line noting that all three ship new updates often, so specifics can ' +
              'shift. Plain text, short labeled sections, no markdown asterisks.'
          },
          { role: 'user', content: 'Give me the comparison.' }
        ],
        temperature: 0.5
      })
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text();
      console.error('Groq API error (ai-comparison):', errText);
      return res.status(502).json({ error: 'Could not put the comparison together right now.' });
    }

    const data = await groqResponse.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) return res.status(502).json({ error: 'Empty response from Groq.' });
    res.json({ reply });
  } catch (err) {
    console.error('Server error (ai-comparison):', err);
    res.status(500).json({ error: 'Something went wrong building the AI comparison.' });
  }
});

app.get('/news', async (req, res) => {
  try {
    const feedUrl = 'https://news.google.com/rss/search?q=artificial+intelligence+when:2d&hl=en-US&gl=US&ceid=US:en';
    const response = await fetch(feedUrl);
    if (!response.ok) return res.status(502).json({ error: 'News service unavailable right now.' });

    const xml = await response.text();
    const titles = [...xml.matchAll(/<title>([\s\S]*?)<\/title>/g)]
      .map((m) => decodeRssTitle(m[1]))
      // Google News RSS repeats the feed's own title as the first <title>
      // (e.g. "artificial intelligence - Google News") - drop that, not a
      // real headline.
      .filter((t) => t && !/google news$/i.test(t))
      // Was 5 - now pulls more so both risk and positive AI stories from
      // today actually show up rather than whatever 5 happened to be first.
      .slice(0, 15)
      .map(tagAiHeadline);

    if (titles.length === 0) return res.status(502).json({ error: 'No headlines found.' });

    res.json({ headlines: titles });
  } catch (err) {
    console.error('Server error (news):', err);
    res.status(500).json({ error: 'Something went wrong getting the news.' });
  }
});

// Registers /upload, /generate-image, /generate-video, /codelab/* on top
// of this app. This line was missing before - the routes were defined in
// server-additions.js but never actually attached to `app`.
registerNovaLabRoutes(app, { GROQ_API_KEY, GEMINI_API_KEY, HF_API_KEY, TRIPO_API_KEY });

app.listen(PORT, () => {
  console.log(`Nova backend listening on port ${PORT}`);
});
