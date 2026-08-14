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

module.exports = function registerNovaLabRoutes(app, { GROQ_API_KEY, GEMINI_API_KEY }) {

  app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file received.' });
    const fileId = uuid();
    const finalPath = path.join(UPLOAD_DIR, fileId + path.extname(req.file.originalname));
    fs.renameSync(req.file.path, finalPath);
    fileIndex.set(fileId, { path: finalPath, name: req.file.originalname, mimeType: req.file.mimetype });
    res.json({ fileId, url: `/files/${path.basename(finalPath)}`, name: req.file.originalname });
  });

app.post('/generate-image', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({
      error: 'prompt is required.'
    });
  }

  if (!GEMINI_API_KEY) {
    return res.status(501).json({
      error: 'Image generation needs GEMINI_API_KEY.'
    });
  }

  try {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt
                }
              ]
            }
          ],
          generationConfig: {
            responseModalities: ['IMAGE']
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data?.error?.message ||
        `Gemini request failed (${response.status})`
      );
<<<<<<< HEAD
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
      res.json({ imageUrl: `/files/${fileId}.png`, caption: 'Here\'s what I generated.' });
    } catch (err) {
      res.status(500).json({ error: `Image generation failed: ${err.message}` });
=======
>>>>>>> 79a6644e906357c5fcff1f15270a20f97a6d42f1
    }

    const parts =
      data?.candidates?.[0]?.content?.parts || [];

    const imagePart = parts.find(
      part => part.inlineData?.data
    );

    if (!imagePart) {
      throw new Error('No image data returned by Gemini.');
    }

    const fileId = uuid();
    const filePath = path.join(
      UPLOAD_DIR,
      `${fileId}.png`
    );

    fs.writeFileSync(
      filePath,
      Buffer.from(
        imagePart.inlineData.data,
        'base64'
      )
    );

    res.json({
      imageUrl: `/files/${fileId}.png`,
      caption: "Here's what I generated."
    });

  } catch (err) {
    console.error('Image generation error:', err);

    res.status(500).json({
      error: `Image generation failed: ${err.message}`
    });
  }
});

  app.post('/generate-video', async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required.' });
    if (!process.env.VIDEO_GEN_API_KEY) {
      return res.status(501).json({ error: 'Video generation isn\'t configured yet - there is no free video-generation API to wire up here. Set VIDEO_GEN_API_KEY to a paid provider (e.g. Runway, Luma, Pika) to enable this.' });
    }
    res.status(501).json({ error: 'Video generation provider not wired up yet.' });
  });

  // ---------------- Document generation (real downloadable files) ----------------
  // The app previously only ever returned plain chat text for "write me a
  // report/letter/resume" style requests. This generates an actual .docx or
  // .pdf file on disk and hands back a /files/ URL the app can download,
  // same as an image or video.
  app.post('/generate-document', async (req, res) => {
    const { prompt, format } = req.body;
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt is required.' });
    const fmt = format === 'pdf' ? 'pdf' : 'docx';

    try {
      const structured = await askGroqForJSON(
        GROQ_API_KEY,
        `You are a professional document writer. Write the full content for this request: "${prompt}".
Respond ONLY with JSON in this exact shape (no markdown fences):
{"title": "Document title", "sections": [{"heading": "Optional heading or empty string", "paragraphs": ["paragraph text", "..."], "bullets": ["optional bullet", "..."]}]}
Write complete, well-organized, ready-to-use content - not a description of what the document should contain.`
      );

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

      res.json({ documentUrl: url, name: `${title}.${fmt}`, title, format: fmt, caption: `Here's your ${fmt.toUpperCase()} - tap to download.` });
    } catch (err) {
      res.status(500).json({ error: `Document generation failed: ${err.message}` });
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
