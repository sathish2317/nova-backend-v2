/**
 * NOVA BACKEND ADDITIONS
 * ------------------------------------------------------------------
 * Text/reasoning routes now run on Groq (GROQ_API_KEY) instead of Gemini.
 * Image generation has no Groq equivalent, so /generate-image still uses
 * GEMINI_API_KEY if you pass one in - omit it and that route just returns
 * a clear "not configured" error instead of failing silently.
 *
 * Also in this file:
 *  - /generate-document  -> real downloadable .docx or .pdf files (not just chat text)
 *  - /codelab/analyze-url -> analyze a GitHub repo URL or any web page/file URL
 *  - /codelab/analyze-file -> analyze a single uploaded file (code, PDF, DOCX, txt)
 * ------------------------------------------------------------------
 */

const multer = require('multer');
const AdmZip = require('adm-zip');
// Pure-JS (WASM) RAR extractor - no system `unrar` binary needed, so this
// works on Render/any host exactly like adm-zip does. Used so the Lab tab
// can accept .rar project archives, not just .zip.
const unrar = require('node-unrar-js');
const { v4: uuid } = require('uuid');
const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
const PDFDocument = require('pdfkit');
// Free, no-API-key neural TTS - talks to the same speech service that
// powers Microsoft Edge's "Read Aloud" feature. Used by /tts below to give
// Nova a natural-sounding voice (ta-IN-PallaviNeural for Tamil, en-US-AvaNeural
// for English) instead of the phone's built-in TTS engine, which is why the
// Tamil voice sounded robotic before - expo-speech can only ever use
// whatever voices are already installed on the device.
const { EdgeTTS } = require('node-edge-tts');

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PROJECT_DIR = path.join(__dirname, 'projects');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(PROJECT_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 25 * 1024 * 1024 }
});

const fileIndex = new Map();
const projectIndex = new Map();

// Any file extension the Lab tab should treat as "code" (gets the code-
// reviewer prompt + is eligible for /codelab/fix-file and /codelab/edit-
// file) rather than the generic "document" summary path. Kept in sync with
// AttachmentBar.js's ALLOWED_EXTENSIONS on the app side - this used to be
// missing most languages (only had ~16 extensions), which is why files
// like plain .html sometimes fell through to being treated as a generic
// document instead of getting a proper code review.
const CODE_EXT = [
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.php', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rb', '.swift', '.kt', '.kts',
  '.rs', '.dart', '.sh', '.bat', '.ps1', '.pl', '.lua', '.r', '.scala', '.vue', '.svelte',
  '.json', '.xml', '.yml', '.yaml', '.sql', '.md'
];

module.exports = function registerNovaLabRoutes(app, { GROQ_API_KEY, GEMINI_API_KEY, HF_API_KEY }) {

  app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file received.' });
    const fileId = uuid();
    const finalPath = path.join(UPLOAD_DIR, fileId + path.extname(req.file.originalname));
    fs.renameSync(req.file.path, finalPath);
    fileIndex.set(fileId, { path: finalPath, name: req.file.originalname, mimeType: req.file.mimetype });
    res.json({ fileId, url: `/files/${path.basename(finalPath)}`, name: req.file.originalname });
  });

  // ---------------- Image generation ----------------
  // Now tries Hugging Face's free text-to-image model FIRST (same
  // HF_IMAGE_MODEL/callHuggingFace used by the video pipeline below - no
  // new dependency), and only falls back to Gemini if HF is unavailable
  // and a GEMINI_API_KEY is configured. This used to be Gemini-only, which
  // is why it broke the moment the Gemini key's project got blocked
  // (403) - HF and Gemini are unrelated accounts, so one being down
  // doesn't take out the other anymore.
  app.post('/generate-image', async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required.' });

    if (HF_API_KEY) {
      try {
        const buffer = await callHuggingFace(HF_IMAGE_MODEL, prompt, { maxAttempts: 3 });
        if (buffer && buffer.length > 500) {
          const fileId = uuid();
          const filePath = path.join(UPLOAD_DIR, `${fileId}.png`);
          fs.writeFileSync(filePath, buffer);
          // Render's disk is wiped on every restart/redeploy (free tier
          // sleeps after ~15 min idle), so /files/<id>.png can 404 later
          // even though generation succeeded. Sending the bytes back as
          // base64 right now means the app can save the image straight
          // to the phone without ever depending on that file still being
          // there - imageUrl is kept only for the inline chat preview.
          return res.json({
            imageUrl: `/files/${fileId}.png`,
            imageBase64: `data:image/png;base64,${buffer.toString('base64')}`,
            caption: 'Here\'s what I generated (Hugging Face).'
          });
        }
      } catch (hfErr) {
        // Falls through to Gemini below instead of failing outright.
      }
    }

    if (!GEMINI_API_KEY) {
      return res.status(501).json({
        error: HF_API_KEY
          ? 'Image generation failed on Hugging Face and no GEMINI_API_KEY is configured as a fallback.'
          : 'Image generation needs HF_API_KEY or GEMINI_API_KEY configured on the backend.'
      });
    }
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
      );
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini responded ${response.status}: ${errText.slice(0, 200)}`);
      }
      const data = await response.json();
      const imagePart = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      if (!imagePart) throw new Error('Model did not return image data.');
      const fileId = uuid();
      const filePath = path.join(UPLOAD_DIR, `${fileId}.png`);
      fs.writeFileSync(filePath, Buffer.from(imagePart.inlineData.data, 'base64'));
      res.json({
        imageUrl: `/files/${fileId}.png`,
        imageBase64: `data:image/png;base64,${imagePart.inlineData.data}`,
        caption: 'Here\'s what I generated (Gemini).'
      });
    } catch (err) {
      res.status(500).json({ error: `Image generation failed: ${err.message}` });
    }
  });

  // ---------------- Video generation (Hugging Face - free, no Gemini) ----------------
  // Previously this called Gemini (gemini-2.5-flash-image) for every scene
  // image, which is why it broke with a 403 the moment the Gemini key was
  // rate-limited / suspended / missing. It's been swapped for Hugging
  // Face's free Inference API end-to-end - no Gemini call anywhere in this
  // route anymore.
  //
  // Two-tier approach, both entirely free:
  //  1. Try a real Hugging Face text-to-video model directly (one call,
  //     returns actual motion video). Free-tier video models are short
  //     (a few seconds) and sometimes need to "warm up" (503 while loading).
  //  2. If that model is unavailable/still loading after a couple of
  //     retries, fall back to the scene-image + ffmpeg Ken-Burns pipeline -
  //     same idea as before, but the scene images now come from a free
  //     Hugging Face text-to-image model instead of Gemini.
  const ffmpegPath = require('ffmpeg-static');
  const { execFile } = require('child_process');

  const SCENE_SECONDS = 10;         // length of each still-image clip (fallback pipeline)
  const TARGET_SECONDS = 130;       // comfortably over the requested 2 min (120s)
  const SCENE_COUNT = Math.ceil(TARGET_SECONDS / SCENE_SECONDS); // 13 scenes
  const IMAGE_CONCURRENCY = 2;      // parallel HF calls - free tier is easily rate-limited, keep this low

  const HF_VIDEO_MODEL = 'damo-vilab/text-to-video-ms-1.7b';
  // stable-diffusion-2-1 used to work here but Hugging Face has since
  // narrowed what the free "hf-inference" provider actually serves - as of
  // 2025 it's mostly lightweight CPU tasks (embeddings, classification,
  // small text models), and older/heavier diffusion checkpoints like this
  // one were dropped from it entirely, which is why every call was coming
  // back "Model not supported by provider hf-inference" (a 400, not a
  // loading/rate-limit response, so it wasn't something retries could fix).
  // stable-diffusion-3-medium-diffusers is what HF's own current docs list
  // as a live hf-inference example, so scene images (and therefore both
  // /generate-image and the video slideshow fallback, which both call this
  // model) actually work again.
  const HF_IMAGE_MODEL = 'stabilityai/stable-diffusion-3-medium-diffusers';
  // Hugging Face fully decommissioned the old api-inference.huggingface.co
  // "Serverless Inference API" host - it now returns 410/refuses to
  // resolve. Every call has to go through the new Inference Providers
  // router instead, at the same /models/<id> path just under a different
  // host + /hf-inference prefix. This was the actual cause of "Video
  // generation failed: fetch failed" (a raw network failure, since the old
  // host stopped responding at all - not just an HTTP error status).
  const HF_INFERENCE_BASE = 'https://router.huggingface.co/hf-inference/models';

  function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
      execFile(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.slice(-500) || err.message));
        else resolve();
      });
    });
  }

  // Runs `fn` over `items` with at most `limit` in flight at once - keeps
  // us comfortably under Hugging Face's free-tier rate limit instead of
  // firing every request at the same instant.
  async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  // Shared Hugging Face Inference API caller. HF's free tier commonly
  // returns 503 with { estimated_time } while a model "cold starts" on
  // their servers - this waits that long (capped) and retries instead of
  // failing on the very first call, which is the most common cause of
  // free HF requests looking "broken" when they're really just warming up.
  async function callHuggingFace(model, prompt, { maxAttempts = 4 } = {}) {
    if (!HF_API_KEY) {
      throw new Error('HUGGINGFACE_API_KEY is not configured on the backend.');
    }
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const response = await fetch(`${HF_INFERENCE_BASE}/${model}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${HF_API_KEY}`
        },
        body: JSON.stringify({ inputs: prompt, options: { wait_for_model: true } })
      });

      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }

      if (response.status === 503) {
        let waitSeconds = 8;
        try {
          const body = await response.json();
          if (body?.estimated_time) waitSeconds = Math.min(body.estimated_time, 30);
        } catch (e) { /* no JSON body - just use the default wait */ }
        lastErr = new Error('Model is still loading on Hugging Face.');
        await new Promise((r) => setTimeout(r, waitSeconds * 1000));
        continue;
      }

      if (response.status === 429) {
        lastErr = new Error('Hugging Face free-tier rate limit hit.');
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }

      const errText = await response.text();
      throw new Error(`Hugging Face responded ${response.status}: ${errText.slice(0, 200)}`);
    }
    throw lastErr || new Error('Hugging Face request failed after retries.');
  }

  async function generateSceneImage(sceneText) {
    return callHuggingFace(HF_IMAGE_MODEL, sceneText);
  }

  // Tries the direct text-to-video model first - one call, real motion
  // video, no ffmpeg needed. Returns null (instead of throwing) if it
  // isn't usable right now, so the caller can fall back cleanly.
  async function tryDirectHuggingFaceVideo(prompt) {
    try {
      const buffer = await callHuggingFace(HF_VIDEO_MODEL, prompt, { maxAttempts: 3 });
      // A successful video response is at least a few KB - a tiny buffer
      // usually means HF sent back a JSON error we didn't catch above.
      if (!buffer || buffer.length < 2000) return null;
      return buffer;
    } catch (e) {
      return null;
    }
  }

  app.post('/generate-video', async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required.' });
    if (!HF_API_KEY) {
      return res.status(501).json({ error: 'Video generation needs HUGGINGFACE_API_KEY - create a free token at huggingface.co/settings/tokens and add it to your backend .env / Render environment variables.' });
    }

    // 1. Try a real AI video model directly (free, but short clips).
    const directVideo = await tryDirectHuggingFaceVideo(prompt);
    if (directVideo) {
      const finalId = uuid();
      const finalPath = path.join(UPLOAD_DIR, `${finalId}.mp4`);
      fs.writeFileSync(finalPath, directVideo);
      return res.json({
        videoUrl: `/files/${finalId}.mp4`,
        caption: "Here's your video, generated with a free Hugging Face text-to-video model."
      });
    }

    // 2. Fallback: scene images (Hugging Face) stitched into a Ken-Burns
    // slideshow video with ffmpeg - still free, still no Gemini involved.
    const jobId = uuid();
    const jobDir = path.join(UPLOAD_DIR, `video-${jobId}`);
    fs.mkdirSync(jobDir, { recursive: true });

    try {
      const scenesResult = await askGroqForJSON(
        GROQ_API_KEY,
        `Break this into exactly ${SCENE_COUNT} short, visually distinct scenes for a slideshow-style video: "${prompt}".
Respond ONLY with JSON (no markdown fences): {"scenes": ["scene 1 visual description", "scene 2 visual description", ...]}
Exactly ${SCENE_COUNT} items. Each is one concise sentence describing what to SHOW, written for an image generator, forming a coherent visual progression from start to end.`
      );
      const scenes = Array.isArray(scenesResult.scenes) ? scenesResult.scenes.slice(0, SCENE_COUNT) : [];
      while (scenes.length < SCENE_COUNT) scenes.push(prompt);
      if (scenes.length === 0) throw new Error('Could not break the prompt into scenes.');

      const imageBuffers = await mapWithConcurrency(scenes, IMAGE_CONCURRENCY, generateSceneImage);
      imageBuffers.forEach((buf, i) => fs.writeFileSync(path.join(jobDir, `scene${i}.png`), buf));

      const fps = 25;
      const frames = SCENE_SECONDS * fps;
      for (let i = 0; i < scenes.length; i++) {
        const inPath = path.join(jobDir, `scene${i}.png`);
        const outPath = path.join(jobDir, `clip${i}.mp4`);
        await runFfmpeg([
          '-y', '-loop', '1', '-i', inPath,
          '-vf', `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,zoompan=z='min(zoom+0.0015,1.2)':d=${frames}:s=1280x720:fps=${fps}`,
          '-t', String(SCENE_SECONDS),
          '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-movflags', '+faststart',
          outPath
        ]);
      }

      const listPath = path.join(jobDir, 'list.txt');
      const listContent = scenes.map((_, i) => `file '${path.join(jobDir, `clip${i}.mp4`)}'`).join('\n');
      fs.writeFileSync(listPath, listContent);
      const finalId = uuid();
      const finalPath = path.join(UPLOAD_DIR, `${finalId}.mp4`);
      await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', finalPath]);

      fs.rmSync(jobDir, { recursive: true, force: true });

      res.json({
        videoUrl: `/files/${finalId}.mp4`,
        durationSeconds: SCENE_COUNT * SCENE_SECONDS,
        caption: `Here's your ${SCENE_COUNT * SCENE_SECONDS}-second video (Hugging Face images + slideshow, since the direct video model wasn't available right now).`
      });
    } catch (err) {
      fs.rmSync(jobDir, { recursive: true, force: true });
      res.status(500).json({ error: `Video generation failed: ${err.message}` });
    }
  });

  // ---------------- Document generation (real downloadable files) ----------------
  // The app previously only ever returned plain chat text for "write me a
  // report/letter/resume" style requests. This generates an actual .docx or
  // .pdf file on disk and hands back a /files/ URL the app can download,
  // same as an image or video.
  app.post('/generate-document', async (req, res) => {
    const { prompt, format, revision } = req.body;
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt is required.' });
    const fmt = format === 'pdf' ? 'pdf' : 'docx';

    try {
      // `revision` lets the app show a preview first and only write a new
      // file once the user is happy - see ChatScreen's pendingDocRef. When
      // present, we hand the PREVIOUS content back to the model along with
      // the user's correction instead of starting from a blank page, so
      // "make the second paragraph shorter" actually edits it instead of
      // regenerating something unrelated.
      const isRevision = revision && revision.previousContent && typeof revision.instruction === 'string';
      const structuredPrompt = isRevision
        ? `You are precisely editing a document you previously wrote. Here is the CURRENT content as JSON - treat it as the source of truth for anything the user did NOT ask to change:
${JSON.stringify(revision.previousContent)}

The user's requested change (their wording may contain typos or awkward phrasing - infer their real intent, don't nitpick the wording): "${revision.instruction}"

RULES:
1. Copy every section, heading, paragraph, and bullet EXACTLY as given above, UNCHANGED, except the specific part(s) the instruction targets.
2. Only rewrite the smallest amount of content needed to satisfy the instruction (e.g. if they say "make the second paragraph shorter", only that paragraph changes).
3. If the instruction is genuinely ambiguous about which part it targets, make the most reasonable interpretation given the document's content - do not ask a clarifying question, just make your best correct edit.
4. Still return the FULL document (all sections), not just the changed part.
Respond ONLY with JSON in this exact shape (no markdown fences):
{"title": "Document title", "sections": [{"heading": "Optional heading or empty string", "paragraphs": ["paragraph text", "..."], "bullets": ["optional bullet", "..."]}]}`
        : `You are a professional document writer. Write the full content for this request (their wording may contain typos or awkward phrasing - infer their real intent and write what they actually meant to ask for): "${prompt}".
Respond ONLY with JSON in this exact shape (no markdown fences):
{"title": "Document title", "sections": [{"heading": "Optional heading or empty string", "paragraphs": ["paragraph text", "..."], "bullets": ["optional bullet", "..."]}]}
Write complete, well-organized, ready-to-use content - not a description of what the document should contain.`;

      // Lower temperature on revisions - we want a precise, minimal edit,
      // not a creative rewrite of the whole document.
      const structured = await askGroqForJSON(GROQ_API_KEY, structuredPrompt, isRevision ? 0.15 : 0.3);

      const title = structured.title || 'Document';
      const sections = Array.isArray(structured.sections) ? structured.sections : [];
      const fileId = uuid();
      let filePath, url;

      if (fmt === 'docx') {
        filePath = path.join(UPLOAD_DIR, `${fileId}.docx`);
        url = `/files/${fileId}.docx`;
        const children = [
          new Paragraph({ text: title, heading: HeadingLevel.TITLE })
        ];
        for (const sec of sections) {
          if (sec.heading) children.push(new Paragraph({ text: sec.heading, heading: HeadingLevel.HEADING_1 }));
          for (const p of sec.paragraphs || []) {
            children.push(new Paragraph({ children: [new TextRun(p)] }));
          }
          for (const b of sec.bullets || []) {
            children.push(new Paragraph({ text: b, bullet: { level: 0 } }));
          }
        }
        const doc = new Document({ sections: [{ properties: {}, children }] });
        const buffer = await Packer.toBuffer(doc);
        fs.writeFileSync(filePath, buffer);
      } else {
        filePath = path.join(UPLOAD_DIR, `${fileId}.pdf`);
        url = `/files/${fileId}.pdf`;
        await new Promise((resolve, reject) => {
          const pdf = new PDFDocument({ margin: 50 });
          const stream = fs.createWriteStream(filePath);
          pdf.pipe(stream);
          pdf.fontSize(20).font('Helvetica-Bold').text(title, { align: 'left' });
          pdf.moveDown();
          for (const sec of sections) {
            if (sec.heading) {
              pdf.fontSize(14).font('Helvetica-Bold').text(sec.heading);
              pdf.moveDown(0.3);
            }
            pdf.fontSize(11).font('Helvetica');
            for (const p of sec.paragraphs || []) {
              pdf.text(p, { align: 'left' });
              pdf.moveDown(0.5);
            }
            for (const b of sec.bullets || []) {
              pdf.text(`\u2022 ${b}`, { indent: 14 });
            }
            pdf.moveDown(0.5);
          }
          pdf.end();
          stream.on('finish', resolve);
          stream.on('error', reject);
        });
      }

      res.json({
        documentUrl: url,
        name: `${title}.${fmt}`,
        title,
        format: fmt,
        // Sent back so the app can hold onto it and pass it back as
        // `revision.previousContent` if the user asks for a change.
        content: { title, sections },
        caption: isRevision ? `Updated - here's the new version.` : `Here's your ${fmt.toUpperCase()} - review it, then download when you're happy with it.`
      });
    } catch (err) {
      res.status(500).json({ error: `Document generation failed: ${err.message}` });
    }
  });

  // ---------------- Camera "take a picture and search" ----------------
  // The app has called this route for a while (config.js -> ENDPOINTS.visionSearch)
  // but it never actually existed on the backend, so every camera-search
  // request 404'd. Uses Gemini's vision model to identify + describe the
  // photo, then narrates the result in Tamil as well (subjectTamil /
  // descriptionTamil) since that's what the app speaks aloud.
  app.post('/vision-search', async (req, res) => {
    const { fileId } = req.body;
    const file = fileIndex.get(fileId);
    if (!file) return res.status(404).json({ error: 'Unknown fileId - upload the photo first.' });
    if (!GEMINI_API_KEY) {
      return res.status(501).json({ error: 'Photo search needs GEMINI_API_KEY configured on the backend - Gemini is the only free vision model wired up here.' });
    }
    try {
      const imageBuffer = fs.readFileSync(file.path);
      const base64Image = imageBuffer.toString('base64');
      const mimeType = file.mimeType && file.mimeType.startsWith('image/') ? file.mimeType : 'image/jpeg';

      const visionRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                {
                  text: 'Identify the main subject of this photo and give a short, factual, helpful description of it - as if researching it for someone who just took the picture. Respond ONLY with JSON (no markdown fences): {"subject": "short name of what it is", "description": "2-4 sentence factual description or interesting facts about it"}'
                },
                { inlineData: { mimeType, data: base64Image } }
              ]
            }]
          })
        }
      );
      if (!visionRes.ok) {
        const errText = await visionRes.text();
        throw new Error(`Gemini vision responded ${visionRes.status}: ${errText.slice(0, 200)}`);
      }
      const visionData = await visionRes.json();
      const rawText = visionData?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text || '{}';
      const clean = rawText.replace(/```json|```/g, '').trim();
      let parsed;
      try { parsed = JSON.parse(clean); } catch (e) { parsed = { subject: 'Unknown subject', description: clean.slice(0, 400) || 'Could not analyze this photo.' }; }

      const subject = parsed.subject || 'Unknown subject';
      const briefDescription = parsed.description || 'No description available.';

      // "Deep search" step - a SECOND Gemini call, this time with Google
      // Search grounding turned on (tools: [{ google_search: {} }]).
      // Gemini's vision call above only looks at the pixels; it has no
      // way to pull in live, current facts. This second call takes the
      // subject it identified and actually searches Google for it, so
      // the final description is grounded in real, current web results
      // instead of only what the model already "knew". Same GEMINI_API_KEY,
      // still free-tier - if grounding fails for any reason (quota, etc.)
      // this falls back to the plain description above instead of failing
      // the whole request.
      let description = briefDescription;
      let sources = [];
      try {
        const groundedRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [{
                  text: `Using Google Search, find current, accurate, detailed information about "${subject}" (this was identified from a photo someone just took). Write a thorough but easy-to-follow 4-6 sentence explanation: what it is, key facts, and anything notable or currently relevant. Write it directly for the person who took the photo, not as a search-result summary.`
                }]
              }],
              tools: [{ google_search: {} }]
            })
          }
        );
        if (groundedRes.ok) {
          const groundedData = await groundedRes.json();
          const groundedText = groundedData?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text;
          if (groundedText) description = groundedText.trim();
          const chunks = groundedData?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
          sources = chunks
            .map((c) => ({ title: c.web?.title, url: c.web?.uri }))
            .filter((s) => s.url)
            .slice(0, 5);
        }
      } catch (e) {
        // Grounded search failed - `description` already holds the
        // fallback from the vision call, so the request still succeeds.
      }

      // Best-effort Tamil narration - if translation fails for any reason,
      // fall back to the English text rather than failing the whole request.
      const [subjectTamil, descriptionTamil] = await Promise.all([
        translateText(GROQ_API_KEY, subject),
        translateText(GROQ_API_KEY, description)
      ]);

      res.json({ subject, description, subjectTamil, descriptionTamil, sources });
    } catch (err) {
      res.status(500).json({ error: `Visual search failed: ${err.message}` });
    }
  });

  app.post('/codelab/analyze', async (req, res) => {
    const { fileId } = req.body;
    const file = fileIndex.get(fileId);
    if (!file) return res.status(404).json({ error: 'Unknown fileId - upload the project first.' });
    try {
      const result = await analyzeZipFile(file.path, fileId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: `Analysis failed: ${err.message}` });
    }
  });

  // ---------------- URL analyzer ----------------
  // Accepts a GitHub repo URL (downloaded and analyzed like a ZIP upload)
  // or any other URL (fetched and summarized/type-detected).
  app.post('/codelab/analyze-url', async (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'A valid http(s) URL is required.' });
    }
    try {
      const githubMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+))?\/?$/i);

      if (githubMatch) {
        const [, owner, repo, branchFromUrl] = githubMatch;
        const branches = branchFromUrl ? [branchFromUrl] : ['main', 'master'];
        let zipBuffer = null;
        let usedBranch = null;
        for (const branch of branches) {
          const zipUrl = `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${branch}`;
          const zipRes = await fetch(zipUrl);
          if (zipRes.ok) {
            zipBuffer = Buffer.from(await zipRes.arrayBuffer());
            usedBranch = branch;
            break;
          }
        }
        if (!zipBuffer) throw new Error(`Could not download ${owner}/${repo} - check the URL, or the repo may be private.`);

        const fileId = uuid();
        const zipPath = path.join(UPLOAD_DIR, `${fileId}.zip`);
        fs.writeFileSync(zipPath, zipBuffer);
        fileIndex.set(fileId, { path: zipPath, name: `${repo}.zip`, mimeType: 'application/zip' });

        const result = await analyzeZipFile(zipPath, fileId);
        return res.json({ kind: 'project', fileId, sourceUrl: url, branch: usedBranch, repo: `${owner}/${repo}`, ...result });
      }

      // Generic URL: fetch and summarize / type-detect.
      const pageRes = await fetch(url);
      if (!pageRes.ok) throw new Error(`URL responded with status ${pageRes.status}`);
      const contentType = pageRes.headers.get('content-type') || 'unknown';
      const rawText = await pageRes.text();
      const sizeBytes = Buffer.byteLength(rawText, 'utf8');
      const isCode = /javascript|typescript|python|json|xml|x-httpd-php/i.test(contentType) || CODE_EXT.some((e) => url.toLowerCase().endsWith(e));
      const isHtml = /text\/html/i.test(contentType);
      const excerpt = rawText.slice(0, 6000);

      const summary = await askGroqForJSON(
        GROQ_API_KEY,
        `Analyze this content fetched from the URL "${url}" (content-type: ${contentType}).
Respond ONLY with JSON: {"summary": "2-4 sentence summary of what this is", "language": "detected programming language or 'N/A' for non-code", "notableFindings": ["short finding", "..."]}
Content:\n\n${excerpt}`
      );

      res.json({
        kind: isHtml ? 'webpage' : (isCode ? 'code-file' : 'document'),
        sourceUrl: url,
        contentType,
        sizeBytes,
        language: summary.language || 'N/A',
        summary: summary.summary || 'No summary available.',
        notableFindings: summary.notableFindings || []
      });
    } catch (err) {
      res.status(500).json({ error: `URL analysis failed: ${err.message}` });
    }
  });

  // ---------------- Single file analyzer ----------------
  // For a single uploaded file that isn't a ZIP project: source code file,
  // PDF, Word doc, plain text, or anything else. Detects type and gives an
  // AI-generated review/summary instead of just running the full project
  // pipeline (which needs a ZIP).
  // Shared by /codelab/analyze-file, /codelab/analyze-text, and
  // /codelab/fix-file - reads a file's text content by extension/mimetype.
  // Returns null for types that don't have text extraction wired up yet
  // (images, old .doc) so callers can respond appropriately.
  async function extractTextFromFile(file, ext, mime) {
    if (ext === '.pdf' || mime === 'application/pdf') {
      const pdfParse = require('pdf-parse');
      const buf = fs.readFileSync(file.path);
      const parsed = await pdfParse(buf);
      return parsed.text || '';
    }
    if (ext === '.docx' || mime.includes('wordprocessingml')) {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: file.path });
      return result.value || '';
    }
    if (ext === '.doc') return null;
    return fs.readFileSync(file.path, 'utf8');
  }

  app.post('/codelab/analyze-file', async (req, res) => {
    const { fileId } = req.body;
    const file = fileIndex.get(fileId);
    if (!file) return res.status(404).json({ error: 'Unknown fileId - upload the file first.' });
    try {
      const ext = path.extname(file.name).toLowerCase();
      const mime = file.mimeType || '';

      if (ext === '.zip' || ext === '.rar' || mime.includes('zip') || mime.includes('rar')) {
        const result = await analyzeZipFile(file.path, fileId, ext === '.rar' ? '.rar' : '.zip');
        return res.json({ kind: 'project', ...result });
      }

      if (mime.startsWith('image/')) {
        const stat = fs.statSync(file.path);
        return res.json({
          kind: 'image',
          name: file.name,
          mimeType: mime,
          sizeBytes: stat.size,
          summary: 'This is an image file. Visual/OCR analysis isn\'t wired up yet - only text-based files (code, PDF, DOCX, plain text) get an AI review right now.'
        });
      }

      const text = await extractTextFromFile(file, ext, mime);
      if (text === null) {
        return res.json({
          kind: 'document',
          name: file.name,
          summary: 'Old-format .doc files aren\'t supported for text extraction yet - please convert to .docx or .pdf and try again.'
        });
      }

      const isCode = CODE_EXT.includes(ext);
      const CHAR_LIMIT = 20000; // ~5-6k tokens - covers most real source files whole, not just the first screen of one
      const wasTruncated = text.length > CHAR_LIMIT;
      const trimmed = text.slice(0, CHAR_LIMIT);
      const lineCount = text.split('\n').length;

      const prompt = isCode
        ? buildCodeReviewPrompt(file.name, ext, trimmed, lineCount, wasTruncated)
        : `Summarize this document (${file.name}, ${lineCount} lines/paragraphs of extracted text). Respond ONLY with JSON:
{"summary": "3-5 sentence summary of the document's content and purpose", "notableFindings": ["short finding", "..."]}
Extracted text:\n\n${trimmed}`;

      const result = await askGroqForJSON(GROQ_API_KEY, prompt, isCode ? 0.2 : 0.3, isCode ? 8000 : undefined);

      if (isCode) {
        // confirmedErrors (rich, per-line) map onto the existing `issues`
        // shape the app already renders - explanation packs problem/
        // cause/fix into one readable block so CodeLabScreen.js doesn't
        // need a layout change to show them.
        const issues = (result.confirmedErrors || []).map((e) => ({
          title: e.title,
          severity: e.severity,
          line: e.line,
          explanation: [
            e.problem,
            e.cause ? `Why: ${e.cause}` : null,
            e.badCode ? `Current:\n${e.badCode}` : null,
            e.fixedCode ? `Fix:\n${e.fixedCode}` : null
          ].filter(Boolean).join('\n\n')
        }));

        return res.json({
          kind: 'code-file',
          fileId,
          name: file.name,
          mimeType: mime,
          lineCount,
          language: result.language || 'unknown',
          framework: result.framework || '',
          overallStatus: result.overallStatus || 'ok',
          summary: result.summary || 'No summary available.',
          issues,
          potentialProblems: result.potentialProblems || [],
          improvements: result.improvements || [],
          correctedFile: result.correctedFile || '',
          requiredCommands: result.requiredCommands || [],
          fixable: true
        });
      }

      res.json({
        kind: 'document',
        fileId,
        name: file.name,
        mimeType: mime,
        lineCount,
        language: 'N/A',
        summary: result.summary || 'No summary available.',
        issues: [],
        notableFindings: result.notableFindings || [],
        fixable: false
      });
    } catch (err) {
      res.status(500).json({ error: `File analysis failed: ${err.message}` });
    }
  });

  // ---------------- Paste-code analyzer ----------------
  // Same analysis as /codelab/analyze-file, but for code pasted directly
  // into the app instead of picked from a file/drag-and-drop - no
  // multipart upload needed, just JSON. Registers a real fileId so the
  // result can still be sent through /codelab/fix-file afterwards.
  app.post('/codelab/analyze-text', async (req, res) => {
    const { name, content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'content is required.' });
    const safeName = (name && name.trim()) || 'pasted-code.txt';
    try {
      const fileId = uuid();
      const finalPath = path.join(UPLOAD_DIR, fileId + path.extname(safeName));
      fs.writeFileSync(finalPath, content, 'utf8');
      fileIndex.set(fileId, { path: finalPath, name: safeName, mimeType: 'text/plain' });

      const ext = path.extname(safeName).toLowerCase();
      const isCode = CODE_EXT.includes(ext) || !ext;
      const CHAR_LIMIT = 20000;
      const wasTruncated = content.length > CHAR_LIMIT;
      const trimmed = content.slice(0, CHAR_LIMIT);
      const lineCount = content.split('\n').length;

      const prompt = buildCodeReviewPrompt(safeName, ext || '.txt', trimmed, lineCount, wasTruncated);
      const result = await askGroqForJSON(GROQ_API_KEY, prompt, 0.2, 8000);

      const issues = (result.confirmedErrors || []).map((e) => ({
        title: e.title,
        severity: e.severity,
        line: e.line,
        explanation: [
          e.problem,
          e.cause ? `Why: ${e.cause}` : null,
          e.badCode ? `Current:\n${e.badCode}` : null,
          e.fixedCode ? `Fix:\n${e.fixedCode}` : null
        ].filter(Boolean).join('\n\n')
      }));

      res.json({
        kind: 'code-file',
        fileId,
        name: safeName,
        lineCount,
        language: result.language || 'unknown',
        framework: result.framework || '',
        overallStatus: result.overallStatus || 'ok',
        summary: result.summary || 'No summary available.',
        issues,
        potentialProblems: result.potentialProblems || [],
        improvements: result.improvements || [],
        correctedFile: result.correctedFile || '',
        requiredCommands: result.requiredCommands || [],
        fixable: true
      });
    } catch (err) {
      res.status(500).json({ error: `Analysis failed: ${err.message}` });
    }
  });

  // ---------------- Full-file AI fix ----------------
  // Rewrites an ENTIRE single file to fix every issue found (not just one
  // diff at a time like /codelab/fix + /codelab/apply-fix, which are for
  // per-bug fixes inside a ZIP project). If the file is really a bundle of
  // more than one language (e.g. a single .html file with a large inline
  // <script>/<style>), the model is asked to split the fixed result into
  // separate files by language - each gets written to disk and served back
  // as its own downloadable file, same as any other generated file here.
  app.post('/codelab/fix-file', async (req, res) => {
    const { fileId } = req.body;
    const file = fileIndex.get(fileId);
    if (!file) return res.status(404).json({ error: 'Unknown fileId - analyze the file first.' });
    try {
      const ext = path.extname(file.name).toLowerCase();
      const mime = file.mimeType || '';
      const text = await extractTextFromFile(file, ext, mime);
      const fixable = CODE_EXT.includes(ext) || ext === '' || ext === '.txt';
      if (text === null || !fixable) {
        return res.status(400).json({ error: 'Only code/text files can be auto-fixed - this file type isn\'t supported for a full-file fix.' });
      }

      const baseName = path.basename(file.name, ext) || 'fixed';
      const prompt = `You are a senior software engineer. Fix EVERY bug, error, and bad practice in this file so it runs correctly with zero errors. Keep the original intent and behavior, just make it correct, safe, and clean.

If this single file actually bundles more than one language together (for example a .html file with a large inline <style> block and/or <script> block), split your fixed result into SEPARATE files - one per language (e.g. "${baseName}.html", "${baseName}.css", "${baseName}.js") - each containing only that language's fixed code, wired together correctly (e.g. the HTML links the separate .css/.js files instead of inlining them). Otherwise, just return the one fixed file with the same name.

Respond ONLY with JSON, no markdown fences:
{"fixSummary": "2-4 sentence summary of what was wrong and what you fixed", "files": [{"filename": "${file.name}", "language": "...", "content": "the complete fixed file content"}]}

Original file (${file.name}):\n\n${text.slice(0, 12000)}`;

      const result = await askGroqForJSON(GROQ_API_KEY, prompt, 0.2);
      const outFiles = Array.isArray(result.files) ? result.files : [];
      if (outFiles.length === 0) throw new Error('The model did not return any fixed file content.');

      const written = outFiles.map((f) => {
        const outName = f.filename || file.name;
        const outId = uuid();
        const outExt = path.extname(outName) || ext || '.txt';
        const finalPath = path.join(UPLOAD_DIR, `${outId}${outExt}`);
        fs.writeFileSync(finalPath, f.content || '', 'utf8');
        fileIndex.set(outId, { path: finalPath, name: outName, mimeType: 'text/plain' });
        // `content` is echoed back (not just the download url) so the app
        // can show an in-app code preview before the user downloads it.
        return { name: outName, language: f.language || 'unknown', url: `/files/${path.basename(finalPath)}`, fileId: outId, content: f.content || '' };
      });

      res.json({ fixSummary: result.fixSummary || 'Fixed.', files: written });
    } catch (err) {
      res.status(500).json({ error: `Fix failed: ${err.message}` });
    }
  });

  // ---------------- Prompt-driven single-file edit ----------------
  // Like /codelab/fix-file, but instead of "fix every bug", the change is
  // whatever free-text instruction the user typed (e.g. "make the button
  // blue", "add a loading spinner", "remove the console.logs"). Reuses the
  // same split-by-language behavior and response shape as fix-file so the
  // app's preview/download UI works identically for both.
  app.post('/codelab/edit-file', async (req, res) => {
    const { fileId, instruction } = req.body;
    const file = fileIndex.get(fileId);
    if (!file) return res.status(404).json({ error: 'Unknown fileId - analyze the file first.' });
    if (!instruction || !instruction.trim()) return res.status(400).json({ error: 'instruction is required.' });
    try {
      const ext = path.extname(file.name).toLowerCase();
      const mime = file.mimeType || '';
      const text = await extractTextFromFile(file, ext, mime);
      const editable = CODE_EXT.includes(ext) || ext === '' || ext === '.txt';
      if (text === null || !editable) {
        return res.status(400).json({ error: 'Only code/text files can be edited this way - this file type isn\'t supported.' });
      }

      const baseName = path.basename(file.name, ext) || 'edited';
      const prompt = `You are a senior software engineer editing a file for someone. Apply ONLY this requested change (their wording may contain typos - infer their real intent): "${instruction.trim()}"

Keep everything else in the file exactly as it is - do not fix unrelated issues, do not rewrite working code, do not change formatting/style outside what the instruction requires. Make the smallest correct change that satisfies the request.

If this single file actually bundles more than one language together (for example a .html file with a large inline <style> block and/or <script> block), split your result into SEPARATE files - one per language (e.g. "${baseName}.html", "${baseName}.css", "${baseName}.js"). Otherwise, just return the one file with the same name.

Respond ONLY with JSON, no markdown fences:
{"fixSummary": "1-3 sentence description of exactly what you changed", "files": [{"filename": "${file.name}", "language": "...", "content": "the complete updated file content"}]}

Current file (${file.name}):\n\n${text.slice(0, 12000)}`;

      const result = await askGroqForJSON(GROQ_API_KEY, prompt, 0.2);
      const outFiles = Array.isArray(result.files) ? result.files : [];
      if (outFiles.length === 0) throw new Error('The model did not return any updated file content.');

      const written = outFiles.map((f) => {
        const outName = f.filename || file.name;
        const outId = uuid();
        const outExt = path.extname(outName) || ext || '.txt';
        const finalPath = path.join(UPLOAD_DIR, `${outId}${outExt}`);
        fs.writeFileSync(finalPath, f.content || '', 'utf8');
        fileIndex.set(outId, { path: finalPath, name: outName, mimeType: 'text/plain' });
        return { name: outName, language: f.language || 'unknown', url: `/files/${path.basename(finalPath)}`, fileId: outId, content: f.content || '' };
      });

      res.json({ fixSummary: result.fixSummary || 'Updated.', files: written });
    } catch (err) {
      res.status(500).json({ error: `Edit failed: ${err.message}` });
    }
  });

  app.post('/codelab/generate-tests', async (req, res) => {
    const { fileId } = req.body;
    const project = projectIndex.get(fileId);
    if (!project) return res.status(404).json({ error: 'Run /codelab/analyze first.' });
    try {
      const codeSample = sampleSourceFiles(project.files, 6, project.dir);
      const prompt = `You are a senior QA engineer. Given these source files from a ${project.language}/${project.framework} project, generate a JSON array of test case names (normal, empty input, invalid input, boundary, null, large input, error handling) covering the most important functions/components. Respond ONLY with JSON: {"tests": [{"name": "..."}]}. Files:\n\n${codeSample}`;
      const result = await askGroqForJSON(GROQ_API_KEY, prompt);
      res.json({ tests: Array.isArray(result.tests) ? result.tests : [], suites: 1 });
    } catch (err) {
      res.status(500).json({ error: `Test generation failed: ${err.message}` });
    }
  });

  app.post('/codelab/break', async (req, res) => {
    const { fileId } = req.body;
    const project = projectIndex.get(fileId);
    if (!project) return res.status(404).json({ error: 'Run /codelab/analyze first.' });
    try {
      const codeSample = sampleSourceFiles(project.files, 10, project.dir);
      const prompt = `You are an adversarial QA engineer. Review this ${project.language}/${project.framework} code and find real bugs: missing null checks, unhandled errors, bad edge cases, security issues. Respond ONLY with JSON:
{"bugs": [{"id": "b1", "file": "relative/path.js", "line": 10, "title": "...", "explanation": "...", "severity": "critical|high|medium|low"}], "health": {"overall": 0-100, "codeQuality": 0-100, "security": 0-100, "performance": 0-100, "testCoverage": 0-100}}
Code:\n\n${codeSample}`;
      const result = await askGroqForJSON(GROQ_API_KEY, prompt);
      const bugs = (result.bugs || []).map((b) => ({ ...b, id: b.id || uuid() }));
      project.bugs = bugs;
      res.json({ bugs, health: result.health || null });
    } catch (err) {
      res.status(500).json({ error: `Break-testing failed: ${err.message}` });
    }
  });

  app.post('/codelab/fix', async (req, res) => {
    const { fileId, bugId } = req.body;
    const project = projectIndex.get(fileId);
    const bug = project?.bugs?.find((b) => b.id === bugId);
    if (!project || !bug) return res.status(404).json({ error: 'Unknown project or bug.' });
    try {
      const filePath = path.join(project.dir, bug.file);
      const fileContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
      const around = fileContent.split('\n').slice(Math.max(0, bug.line - 6), bug.line + 5).join('\n');
      const prompt = `Fix this bug: "${bug.title}" (${bug.explanation}). Here is the surrounding code:\n${around}\nRespond ONLY with JSON: {"before": "exact line(s) to replace", "after": "fixed line(s)"}`;
      const diff = await askGroqForJSON(GROQ_API_KEY, prompt);
      bug.suggestedFix = diff;
      res.json({ diff });
    } catch (err) {
      res.status(500).json({ error: `Fix generation failed: ${err.message}` });
    }
  });

  app.post('/codelab/apply-fix', async (req, res) => {
    const { fileId, bugId } = req.body;
    const project = projectIndex.get(fileId);
    const bug = project?.bugs?.find((b) => b.id === bugId);
    if (!project || !bug?.suggestedFix) return res.status(404).json({ error: 'Generate a fix first.' });
    try {
      const filePath = path.join(project.dir, bug.file);
      let content = fs.readFileSync(filePath, 'utf8');
      if (!content.includes(bug.suggestedFix.before)) {
        return res.status(409).json({ error: 'The original line has changed - re-run "Fix with AI" to regenerate the diff.' });
      }
      content = content.replace(bug.suggestedFix.before, bug.suggestedFix.after);
      fs.writeFileSync(filePath, content);
      const prompt = `Re-review this fixed code for the same class of bug ("${bug.title}"). Respond ONLY with JSON: {"stillBroken": true|false}\n\n${content.split('\n').slice(Math.max(0, bug.line - 6), bug.line + 5).join('\n')}`;
      const check = await askGroqForJSON(GROQ_API_KEY, prompt);
      bug.status = check.stillBroken ? 'regressed' : 'fixed';
      res.json({ retestPassed: !check.stillBroken });
    } catch (err) {
      res.status(500).json({ error: `Apply failed: ${err.message}` });
    }
  });

  // Extracts a .zip or .rar archive to destDir. Split out from
  // analyzeArchiveFile so both the archive AND folder-of-files paths (see
  // /codelab/analyze-file) can reuse it.
  async function extractArchive(archivePath, ext, destDir) {
    if (ext === '.rar') {
      const data = Uint8Array.from(fs.readFileSync(archivePath)).buffer;
      const extractor = await unrar.createExtractorFromData({ data });
      const { files } = extractor.extract(); // no `files` filter = extract everything
      for (const f of files) {
        if (!f.fileHeader || f.fileHeader.flags?.directory || !f.extraction) continue;
        const outPath = path.join(destDir, f.fileHeader.name);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, Buffer.from(f.extraction));
      }
    } else {
      new AdmZip(archivePath).extractAllTo(destDir, true);
    }
  }

  // Shared by /codelab/analyze and /codelab/analyze-url (GitHub repos) -
  // handles both .zip and .rar project archives (see extractArchive above).
  async function analyzeZipFile(zipPath, fileId, ext = '.zip') {
    const projectDir = path.join(PROJECT_DIR, fileId);
    fs.mkdirSync(projectDir, { recursive: true });
    await extractArchive(zipPath, ext, projectDir);
    const allFiles = walk(projectDir);
    const language = detectLanguage(allFiles);
    const framework = detectFramework(projectDir, allFiles);
    const structure = topLevelStructure(projectDir);
    projectIndex.set(fileId, { dir: projectDir, structure, language, framework, files: allFiles, bugs: [] });
    return { language, framework, structure, fileCount: allFiles.length };
  }

  // Tamil Unicode block is U+0B80-U+0BFF - same quick script check used on
  // the app side (utils/novaVoice.js) to decide which language/voice to
  // speak a reply in.
  const TAMIL_SCRIPT = /[\u0B80-\u0BFF]/;

  // Generates natural-sounding speech audio for a line of text and returns
  // a URL the app can play (same /files static route /upload already uses).
  // Free, no API key - see the node-edge-tts require above for why this
  // sounds far better than the device's own TTS engine, especially in Tamil.
  app.post('/tts', async (req, res) => {
    const { text, lang } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'text is required.' });

    const isTamil = lang === 'ta' || lang === 'ta-IN' || TAMIL_SCRIPT.test(text);
    const voice = isTamil ? 'ta-IN-PallaviNeural' : 'en-US-AvaNeural';
    const voiceLang = isTamil ? 'ta-IN' : 'en-US';

    try {
      const fileId = uuid();
      const finalPath = path.join(UPLOAD_DIR, `${fileId}.mp3`);
      const tts = new EdgeTTS({
        voice,
        lang: voiceLang,
        outputFormat: 'audio-24khz-96kbitrate-mono-mp3',
        // Slightly warmer/gentler than the raw default, matching the pitch/
        // rate tuning speakAsNova() used to apply on-device.
        pitch: '+5Hz',
        rate: isTamil ? '-8%' : 'default'
      });
      await tts.ttsPromise(text, finalPath);
      res.json({ audioUrl: `/files/${fileId}.mp3`, voice });
    } catch (err) {
      res.status(500).json({ error: `TTS failed: ${err.message}` });
    }
  });
};

// ------------------------- helpers -------------------------

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

function topLevelStructure(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name !== 'node_modules' && e.name !== '.git')
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
}

function detectLanguage(files) {
  if (files.some((f) => f.endsWith('.ts') || f.endsWith('.tsx'))) return 'TypeScript';
  if (files.some((f) => f.endsWith('.jsx') || f.endsWith('.js'))) return 'JavaScript';
  if (files.some((f) => f.endsWith('.py'))) return 'Python';
  if (files.some((f) => f.endsWith('.php'))) return 'PHP';
  return 'unknown';
}

function detectFramework(dir, files) {
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.expo) return 'Expo / React Native';
    if (deps['react-native']) return 'React Native';
    if (deps.next) return 'Next.js';
    if (deps.react) return 'React';
    if (deps.express) return 'Express';
  }
  if (files.some((f) => f === 'composer.json')) return 'PHP/Composer';
  if (files.some((f) => f === 'requirements.txt')) return 'Python';
  return 'unknown';
}

function sampleSourceFiles(files, max, projectDir) {
  const codeExt = ['.js', '.jsx', '.ts', '.tsx', '.py', '.php'];
  return files
    .filter((f) => codeExt.includes(path.extname(f)))
    .slice(0, max)
    .map((f) => {
      const full = path.join(projectDir, f);
      let content = '';
      try { content = fs.readFileSync(full, 'utf8').slice(0, 4000); } catch (e) { /* skip unreadable */ }
      return `--- ${f} ---\n${content}`;
    })
    .join('\n\n');
}

// Small, best-effort translator for Tamil narration on /vision-search.
// Separate from server.js's translateToTamil (that one isn't exported) -
// duplicated here on purpose to keep server-additions.js self-contained.
async function translateText(apiKey, text, targetLang = 'Tamil') {
  if (!text) return '';
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: `You are a translator. Translate the given text into natural, spoken ${targetLang}. Output ONLY the translation, nothing else.` },
          { role: 'user', content: text }
        ],
        temperature: 0.3
      })
    });
    if (!response.ok) return text;
    const data = await response.json();
    return data?.choices?.[0]?.message?.content?.trim() || text;
  } catch (e) {
    return text; // fall back to English rather than failing the whole request
  }
}

// Groq's chat-completions endpoint is OpenAI-compatible - same shape as
// the OpenAI SDK, just a different base URL. json_object mode plus the
// "respond ONLY with JSON" prompts keep output parseable.
async function askGroqForJSON(apiKey, prompt, temperature = 0.3, maxTokens) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature,
      ...(maxTokens ? { max_tokens: maxTokens } : {})
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || 'Groq request failed.');
  const text = data?.choices?.[0]?.message?.content || '{}';
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ---------------- Nova AI Code File Analyzer (spec-driven) ----------------
// Builds the review prompt used by /codelab/analyze-file and
// /codelab/analyze-text. Kept as one shared function so both routes stay
// in sync - this is the "Nova AI — Code File Analyzer" behaviour: detect
// language/framework, walk the WHOLE file (not just the first few lines),
// separate confirmed errors from potential problems and improvements,
// give each confirmed error's exact line + why it happens + a corrected
// snippet, then a full corrected file where practical, with the smallest
// reliable changes rather than a rewrite.
function buildCodeReviewPrompt(fileName, ext, trimmed, lineCount, wasTruncated) {
  return `You are Nova AI, an advanced programming code analysis and debugging assistant. Analyze the ENTIRE file below (not just the first few lines) and respond ONLY with a JSON object, no other text.

File: ${fileName}
Extension: ${ext || '(none)'}
Line count: ${lineCount}${wasTruncated ? ' (content was truncated below - only analyze what is shown, do not invent lines past it)' : ''}

Rules:
- Identify the language, and framework/library/runtime if detectable (e.g. Node.js/Express, React Native/Expo, Laravel, plain PHP). Do not guess the language if the extension and code contradict each other - say so in "summary" instead.
- Only report a "confirmedErrors" entry when there is real evidence in the code (syntax errors, undefined variables/functions, missing imports, incorrect API/framework usage, deprecated methods, broken paths/URLs, missing error handling, null/undefined bugs, async/await/promise mistakes, security issues, etc). Do not invent errors and do not flag normal style preferences as errors.
- Put things that MIGHT be a problem but aren't certain into "potentialProblems" instead of "confirmedErrors".
- Put non-bug suggestions (naming, structure, performance, maintainability) into "improvements" - never mix these into confirmedErrors.
- For every confirmedErrors entry, give the exact (or closest approximate) line number, the problematic code, what is wrong, why it happens (explained simply, no unnecessary jargon), and a corrected code snippet.
- Classify every confirmedErrors entry's severity as exactly one of: "critical" (app may fail to start / major feature broken), "high" (a significant feature may not work), "medium" (works but buggy/unreliable), "low" (minor/cosmetic).
- If you find a hardcoded secret (API key, password, token), do NOT reproduce the real value anywhere in your response - mask it like "GROQ_API_KEY=********" and tell the user to move it to an environment variable.
- Make the smallest reliable fix - do not rewrite unrelated working code. If a full corrected file is practical given the size shown, provide it in "correctedFile"; otherwise leave "correctedFile" empty and rely on each error's own corrected snippet.
- If the file needs an npm/pip/composer package that isn't already implied as installed, list the exact install command in "requiredCommands".

Respond with exactly this JSON shape:
{
  "language": "detected language",
  "framework": "detected framework/library, or empty string if none",
  "overallStatus": "broken" | "needs-fixes" | "minor-issues" | "ok",
  "summary": "2-4 sentence summary of what this file does and its overall condition",
  "confirmedErrors": [
    {
      "title": "short error name",
      "severity": "critical" | "high" | "medium" | "low",
      "line": 0,
      "problem": "what is wrong",
      "cause": "why it happens, explained simply",
      "badCode": "the problematic code",
      "fixedCode": "the corrected code for just this spot"
    }
  ],
  "potentialProblems": ["short description", "..."],
  "improvements": ["short suggestion", "..."],
  "correctedFile": "full corrected file content, or empty string if not practical/needed",
  "requiredCommands": ["npm install example-package", "..."]
}

File content:

${trimmed}`;
}
