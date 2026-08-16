/**
 * NOVA BACKEND ADDITIONS
 * ------------------------------------------------------------------
 * Everything in this file runs entirely on GROQ_API_KEY (the same key
 * used for chat) plus fully keyless free services - no Gemini, no second
 * API key to manage:
 *  - /generate-image    -> Pollinations.ai (free, no signup, no key)
 *  - /vision-search      -> Groq's qwen/qwen3.6-27b vision model (your existing GROQ_API_KEY)
 *  - /generate-document  -> real downloadable .docx or .pdf files (not just chat text)
 *  - /codelab/analyze-url -> analyze a GitHub repo URL or any web page/file URL
 *  - /codelab/analyze-file -> analyze a single uploaded file (code, PDF, DOCX, txt)
 * ------------------------------------------------------------------
 */

const multer = require('multer');
const AdmZip = require('adm-zip');
const { v4: uuid } = require('uuid');
const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
const PDFDocument = require('pdfkit');

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

const CODE_EXT = ['.js', '.jsx', '.ts', '.tsx', '.py', '.php', '.java', '.c', '.cpp', '.cs', '.go', '.rb', '.swift', '.kt', '.html', '.css'];

module.exports = function registerNovaLabRoutes(app, { GROQ_API_KEY }) {

  app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file received.' });
    const fileId = uuid();
    const finalPath = path.join(UPLOAD_DIR, fileId + path.extname(req.file.originalname));
    fs.renameSync(req.file.path, finalPath);
    fileIndex.set(fileId, { path: finalPath, name: req.file.originalname, mimeType: req.file.mimetype });
    res.json({ fileId, url: `/files/${path.basename(finalPath)}`, name: req.file.originalname });
  });

  // Pollinations.ai is a genuinely free, keyless image-generation API - no
  // account, no API key, just a URL. Replaces the old Gemini-based route,
  // which needed a Google AI Studio key and stopped working.
  app.post('/generate-image', async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required.' });
    try {
      const seed = Math.floor(Math.random() * 1_000_000); // avoids Pollinations' CDN caching the same image for repeat prompts
      const genUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${seed}`;
      const response = await fetch(genUrl);
      if (!response.ok) throw new Error(`Image provider responded ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      const fileId = uuid();
      const filePath = path.join(UPLOAD_DIR, `${fileId}.png`);
      fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
      res.json({ imageUrl: `/files/${fileId}.png`, caption: 'Here\'s what I generated.' });
    } catch (err) {
      res.status(500).json({ error: `Image generation failed: ${err.message}` });
    }
  });

  // ---------------- Video generation (free, reliable, 2+ minutes) ----------------
  // Honest technical note: there is no free API anywhere (Hugging Face
  // included) that generates 2 continuous minutes of true AI motion video -
  // free video models cap out around 2-4 seconds per generation, and
  // chaining many of those together is slow, rate-limit-prone, and the
  // motion doesn't connect between clips anyway.
  //
  // What actually works reliably for free: break the topic into scenes,
  // generate one AI image per scene (Gemini - already used by
  // /generate-image above), then use ffmpeg to turn each image into a
  // slow zoom/pan ("Ken Burns") clip and concatenate them into one .mp4
  // that hits your target length exactly. No third-party video API in the
  // critical path = nothing there to rate-limit or randomly fail.
  const ffmpegPath = require('ffmpeg-static');
  const { execFile } = require('child_process');

  const SCENE_SECONDS = 10;         // length of each still-image clip
  const TARGET_SECONDS = 130;       // comfortably over the requested 2 min (120s)
  const SCENE_COUNT = Math.ceil(TARGET_SECONDS / SCENE_SECONDS); // 13 scenes
  const IMAGE_CONCURRENCY = 3;      // parallel Gemini calls - fast, but under free-tier rate limits

  function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
      execFile(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.slice(-500) || err.message));
        else resolve();
      });
    });
  }

  // Runs `fn` over `items` with at most `limit` in flight at once - keeps
  // us comfortably under Gemini's free-tier requests-per-minute limit
  // instead of firing 13 requests at the same instant.
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

  // One Gemini image call, with a couple of retries on rate-limit (429)
  // or transient errors so one flaky call doesn't sink the whole video.
  async function generateSceneImage(sceneText) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_API_KEY}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: sceneText }] }] }) }
        );
        if (response.status === 429) throw new Error('rate limited');
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Gemini responded ${response.status}: ${errText.slice(0, 150)}`);
        }
        const data = await response.json();
        const imagePart = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
        if (!imagePart) throw new Error('Model did not return image data.');
        return Buffer.from(imagePart.inlineData.data, 'base64');
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); // backoff before retrying
      }
    }
    throw lastErr;
  }

  app.post('/generate-video', async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required.' });
    if (!GEMINI_API_KEY) {
      return res.status(501).json({ error: 'Video generation needs GEMINI_API_KEY - it generates the scene images the video is built from.' });
    }

    const jobId = uuid();
    const jobDir = path.join(UPLOAD_DIR, `video-${jobId}`);
    fs.mkdirSync(jobDir, { recursive: true });

    try {
      // 1. Split the topic into SCENE_COUNT short visual scenes.
      const scenesResult = await askGroqForJSON(
        GROQ_API_KEY,
        `Break this into exactly ${SCENE_COUNT} short, visually distinct scenes for a slideshow-style video: "${prompt}".
Respond ONLY with JSON (no markdown fences): {"scenes": ["scene 1 visual description", "scene 2 visual description", ...]}
Exactly ${SCENE_COUNT} items. Each is one concise sentence describing what to SHOW, written for an image generator, forming a coherent visual progression from start to end.`
      );
      const scenes = Array.isArray(scenesResult.scenes) ? scenesResult.scenes.slice(0, SCENE_COUNT) : [];
      while (scenes.length < SCENE_COUNT) scenes.push(prompt); // pad if the model returned fewer than asked
      if (scenes.length === 0) throw new Error('Could not break the prompt into scenes.');

      // 2. Generate one image per scene (a few in parallel at a time).
      const imageBuffers = await mapWithConcurrency(scenes, IMAGE_CONCURRENCY, generateSceneImage);
      imageBuffers.forEach((buf, i) => fs.writeFileSync(path.join(jobDir, `scene${i}.png`), buf));

      // 3. Turn each image into a Ken-Burns clip of SCENE_SECONDS length.
      // Every clip is encoded with identical size/fps/codec so the final
      // concat step can just copy the streams (fast, and nothing to
      // mismatch/fail on).
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

      // 4. Concatenate all clips into the final video.
      const listPath = path.join(jobDir, 'list.txt');
      const listContent = scenes.map((_, i) => `file '${path.join(jobDir, `clip${i}.mp4`)}'`).join('\n');
      fs.writeFileSync(listPath, listContent);
      const finalId = uuid();
      const finalPath = path.join(UPLOAD_DIR, `${finalId}.mp4`);
      await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', finalPath]);

      // Clean up the per-job scratch folder, keep only the final file.
      fs.rmSync(jobDir, { recursive: true, force: true });

      res.json({
        videoUrl: `/files/${finalId}.mp4`,
        durationSeconds: SCENE_COUNT * SCENE_SECONDS,
        caption: `Here's your ${SCENE_COUNT * SCENE_SECONDS}-second video.`
      });
    } catch (err) {
      fs.rmSync(jobDir, { recursive: true, force: true });
      res.status(500).json({ error: `Video generation failed: ${err.message}` });
    }
  });

  // ---------------- "Take a picture and search" (visual search) ----------------
  // Two stages: (1) Groq's qwen/qwen3.6-27b vision model looks at the photo
  // and identifies what it is + writes a short search query for it (runs on
  // the same GROQ_API_KEY already used for chat - no separate vision key
  // needed), (2) that query goes to DuckDuckGo's free Instant Answer API
  // (no key needed) for a quick supporting summary/links, so the reply
  // isn't just "here's a guess" but has a bit of real lookup behind it too.
  app.post('/vision-search', async (req, res) => {
    const { fileId } = req.body;
    const file = fileIndex.get(fileId);
    if (!file) return res.status(404).json({ error: 'Unknown fileId - upload the photo first.' });
    try {
      const imageBuffer = fs.readFileSync(file.path);
      const base64Image = imageBuffer.toString('base64');
      const mimeType = file.mimeType && file.mimeType.startsWith('image/') ? file.mimeType : 'image/jpeg';

      const visionRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
        body: JSON.stringify({
          model: 'qwen/qwen3.6-27b',
          response_format: { type: 'json_object' },
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: `Look closely at this photo. Respond ONLY with JSON (no markdown fences):
{"subject": "short name of the main thing in the photo", "description": "3-5 sentence detailed description of what it is, covering anything notable", "searchQuery": "a good short web search query to learn more about this specific thing"}` },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
            ]
          }]
        })
      });
      if (!visionRes.ok) {
        const errText = await visionRes.text();
        throw new Error(`Vision model responded ${visionRes.status}: ${errText.slice(0, 200)}`);
      }
      const visionData = await visionRes.json();
      const rawText = visionData?.choices?.[0]?.message?.content || '{}';
      const clean = rawText.replace(/```json|```/g, '').trim();
      let parsed;
      try { parsed = JSON.parse(clean); } catch (e) { parsed = { subject: 'Unknown', description: clean, searchQuery: '' }; }

      let webSummary = null;
      let relatedLinks = [];
      if (parsed.searchQuery) {
        try {
          const ddgRes = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(parsed.searchQuery)}&format=json&no_html=1&skip_disambig=1`);
          if (ddgRes.ok) {
            const ddg = await ddgRes.json();
            webSummary = ddg.AbstractText || null;
            relatedLinks = (ddg.RelatedTopics || [])
              .filter((t) => t.Text && t.FirstURL)
              .slice(0, 4)
              .map((t) => ({ text: t.Text, url: t.FirstURL }));
          }
        } catch (e) { /* web enrichment is best-effort - vision result still stands without it */ }
      }

      res.json({
        subject: parsed.subject || 'Unknown',
        description: parsed.description || '',
        searchQuery: parsed.searchQuery || '',
        webSummary,
        relatedLinks
      });
    } catch (err) {
      res.status(500).json({ error: `Visual search failed: ${err.message}` });
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
        ? `You are revising a document you previously wrote. Here is the CURRENT content as JSON:
${JSON.stringify(revision.previousContent)}

The user's requested change: "${revision.instruction}"

Apply that change and return the FULL updated document (not just the changed part). Keep everything the user didn't ask to change as close to the original as sensible.
Respond ONLY with JSON in this exact shape (no markdown fences):
{"title": "Document title", "sections": [{"heading": "Optional heading or empty string", "paragraphs": ["paragraph text", "..."], "bullets": ["optional bullet", "..."]}]}`
        : `You are a professional document writer. Write the full content for this request: "${prompt}".
Respond ONLY with JSON in this exact shape (no markdown fences):
{"title": "Document title", "sections": [{"heading": "Optional heading or empty string", "paragraphs": ["paragraph text", "..."], "bullets": ["optional bullet", "..."]}]}
Write complete, well-organized, ready-to-use content - not a description of what the document should contain.`;

      const structured = await askGroqForJSON(GROQ_API_KEY, structuredPrompt);

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
      const description = parsed.description || 'No description available.';

      // Best-effort Tamil narration - if translation fails for any reason,
      // fall back to the English text rather than failing the whole request.
      const [subjectTamil, descriptionTamil] = await Promise.all([
        translateText(GROQ_API_KEY, subject),
        translateText(GROQ_API_KEY, description)
      ]);

      res.json({ subject, description, subjectTamil, descriptionTamil });
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
  app.post('/codelab/analyze-file', async (req, res) => {
    const { fileId } = req.body;
    const file = fileIndex.get(fileId);
    if (!file) return res.status(404).json({ error: 'Unknown fileId - upload the file first.' });
    try {
      const ext = path.extname(file.name).toLowerCase();
      const mime = file.mimeType || '';

      if (ext === '.zip' || mime.includes('zip')) {
        const result = await analyzeZipFile(file.path, fileId);
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

      let text = '';
      if (ext === '.pdf' || mime === 'application/pdf') {
        const pdfParse = require('pdf-parse');
        const buf = fs.readFileSync(file.path);
        const parsed = await pdfParse(buf);
        text = parsed.text || '';
      } else if (ext === '.docx' || mime.includes('wordprocessingml')) {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ path: file.path });
        text = result.value || '';
      } else if (ext === '.doc') {
        return res.json({
          kind: 'document',
          name: file.name,
          summary: 'Old-format .doc files aren\'t supported for text extraction yet - please convert to .docx or .pdf and try again.'
        });
      } else {
        // Code file or plain text
        text = fs.readFileSync(file.path, 'utf8');
      }

      const isCode = CODE_EXT.includes(ext);
      const trimmed = text.slice(0, 8000);
      const lineCount = text.split('\n').length;

      const prompt = isCode
        ? `You are a senior code reviewer. Review this single ${ext} file (${lineCount} lines). Respond ONLY with JSON:
{"language": "detected language", "summary": "2-3 sentence summary of what this file does", "issues": [{"title": "...", "severity": "critical|high|medium|low", "line": 0, "explanation": "..."}]}
File content:\n\n${trimmed}`
        : `Summarize this document (${file.name}, ${lineCount} lines/paragraphs of extracted text). Respond ONLY with JSON:
{"summary": "3-5 sentence summary of the document's content and purpose", "notableFindings": ["short finding", "..."]}
Extracted text:\n\n${trimmed}`;

      const result = await askGroqForJSON(GROQ_API_KEY, prompt);

      res.json({
        kind: isCode ? 'code-file' : 'document',
        name: file.name,
        mimeType: mime,
        lineCount,
        language: result.language || (isCode ? 'unknown' : 'N/A'),
        summary: result.summary || 'No summary available.',
        issues: result.issues || [],
        notableFindings: result.notableFindings || []
      });
    } catch (err) {
      res.status(500).json({ error: `File analysis failed: ${err.message}` });
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

  // Shared by /codelab/analyze and /codelab/analyze-url (GitHub repos)
  async function analyzeZipFile(zipPath, fileId) {
    const projectDir = path.join(PROJECT_DIR, fileId);
    fs.mkdirSync(projectDir, { recursive: true });
    new AdmZip(zipPath).extractAllTo(projectDir, true);
    const allFiles = walk(projectDir);
    const language = detectLanguage(allFiles);
    const framework = detectFramework(projectDir, allFiles);
    const structure = topLevelStructure(projectDir);
    projectIndex.set(fileId, { dir: projectDir, structure, language, framework, files: allFiles, bugs: [] });
    return { language, framework, structure, fileCount: allFiles.length };
  }
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
        model: 'llama-3.3-70b-versatile',
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
async function askGroqForJSON(apiKey, prompt) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || 'Groq request failed.');
  const text = data?.choices?.[0]?.message?.content || '{}';
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}
