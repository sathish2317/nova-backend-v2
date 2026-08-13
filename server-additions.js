/**
 * NOVA BACKEND ADDITIONS
 * ------------------------------------------------------------------
 * Text/reasoning routes now run on Groq (GROQ_API_KEY) instead of Gemini.
 * Image generation has no Groq equivalent, so /generate-image still uses
 * GEMINI_API_KEY if you pass one in - omit it and that route just returns
 * a clear "not configured" error instead of failing silently.
 * ------------------------------------------------------------------
 */

const multer = require('multer');
const AdmZip = require('adm-zip');
const { v4: uuid } = require('uuid');
const fs = require('fs');
const path = require('path');

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
      return res.status(501).json({ error: 'Video generation isn\'t configured yet - set VIDEO_GEN_API_KEY to enable this.' });
    }
    res.status(501).json({ error: 'Video generation provider not wired up yet.' });
  });

  app.post('/codelab/analyze', async (req, res) => {
    const { fileId } = req.body;
    const file = fileIndex.get(fileId);
    if (!file) return res.status(404).json({ error: 'Unknown fileId - upload the project first.' });
    try {
      const projectDir = path.join(PROJECT_DIR, fileId);
      fs.mkdirSync(projectDir, { recursive: true });
      new AdmZip(file.path).extractAllTo(projectDir, true);
      const allFiles = walk(projectDir);
      const language = detectLanguage(allFiles);
      const framework = detectFramework(projectDir, allFiles);
      const structure = topLevelStructure(projectDir);
      projectIndex.set(fileId, { dir: projectDir, structure, language, framework, files: allFiles, bugs: [] });
      res.json({ language, framework, structure, fileCount: allFiles.length });
    } catch (err) {
      res.status(500).json({ error: `Analysis failed: ${err.message}` });
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
