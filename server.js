// Nova Backend Server
// This is the "brain" that sits between your phone app and Groq's AI API.
// Your API key lives ONLY here - never in the mobile app.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const path = require('path');
const registerNovaLabRoutes = require('./server-additions');

// Render sits behind a reverse proxy - this tells Express to trust the
// X-Forwarded-For header so express-rate-limit can identify users correctly.
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'llama-3.3-70b-versatile';

if (!GROQ_API_KEY) {
  console.error('ERROR: GROQ_API_KEY is missing. Add it in your .env file (local) or Render environment variables (deployed).');
  process.exit(1);
}

app.use(cors());
app.use(express.json());

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
You can reply in English or Tamil depending on what language the user writes in.`
};

const getSystemPrompt = (personality) => NOVA_PERSONALITIES[personality] || NOVA_PERSONALITIES.friendly;

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
app.post('/chat', chatLimiter, async (req, res) => {
  try {
    const { message, history, personality } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required.' });
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

// News endpoint - top world headlines from BBC's public RSS feed (free,
// no API key needed).
app.get('/news', async (req, res) => {
  try {
    const response = await fetch('http://feeds.bbci.co.uk/news/world/rss.xml');
    if (!response.ok) return res.status(502).json({ error: 'News service unavailable right now.' });

    const xml = await response.text();
    const titles = [...xml.matchAll(/<title>(.*?)<\/title>/g)]
      .map((m) => m[1])
      .filter((t) => t && !t.toLowerCase().includes('bbc news'))
      .slice(0, 5);

    if (titles.length === 0) return res.status(502).json({ error: 'No headlines found.' });

    res.json({ headlines: titles });
  } catch (err) {
    console.error('Server error (news):', err);
    res.status(500).json({ error: 'Something went wrong getting the news.' });
  }
});

app.listen(PORT, () => {
  console.log(`Nova backend listening on port ${PORT}`);
});
