// ============================================================================
// FaceStyle AI — backend server
// ----------------------------------------------------------------------------
// Deliberately zero-dependency: uses only Node's built-in http/fs/path
// modules. Run with: node server.js
//
// Why no framework? So this project runs anywhere with just Node.js
// installed — no `npm install` step required — while still keeping the
// AI provider's secret API key safely on the server side only.
// ============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./services/envLoader');

loadEnv();

const aiService = require('./services/aiService');
const { getStyleLibrary } = require('./services/styleLibrary');
const { AppError } = require('./services/errors');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 11 * 1024 * 1024; // ~8MB image + base64/JSON overhead

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, err) {
  if (err instanceof AppError) {
    sendJson(res, err.statusCode, err.toJSON());
    return;
  }
  // Never leak internal error details (stack traces, provider payloads, keys).
  console.error('Unexpected server error:', err);
  sendJson(res, 500, { error: 'INTERNAL_ERROR', message: 'Something went wrong on our end. Please try again.' });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(new AppError('IMAGE_TOO_LARGE', 'That upload is too large. Please use a photo under 8MB.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new AppError('INVALID_REQUEST', 'The request body was not valid JSON.', 400));
      }
    });
    req.on('error', () => reject(new AppError('NETWORK_ERROR', 'The upload was interrupted. Please try again.')));
  });
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  const resolvedPath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(resolvedPath, (err, data) => {
    if (err) {
      // Fall back to index.html for unknown paths so client-side routing
      // (e.g. deep-linking to #styles) still loads the app shell.
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (fallbackErr, fallbackData) => {
        if (fallbackErr) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'] });
        res.end(fallbackData);
      });
      return;
    }
    const ext = path.extname(resolvedPath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ----------------------------------------------------------------------------
// Route handlers
// ----------------------------------------------------------------------------

async function handleHealth(req, res) {
  sendJson(res, 200, {
    analysisConfigured: aiService.isAnalysisProviderConfigured(),
    previewConfigured: aiService.isImageEditProviderConfigured(),
  });
}

async function handleStyles(req, res) {
  sendJson(res, 200, getStyleLibrary());
}

async function handleAnalyze(req, res) {
  const body = await readJsonBody(req);
  if (!body.image) {
    throw new AppError('INVALID_REQUEST', 'No image was provided.', 400);
  }

  if (!aiService.isAnalysisProviderConfigured()) {
    // Explicit fallback mode — never pretend an analysis happened.
    sendJson(res, 200, {
      configured: false,
      message: "AI analysis isn't connected yet. Add your AI API key to enable live analysis.",
    });
    return;
  }

  const analysis = await aiService.analyzeFace(body.image);

  // These two can safely run in parallel — both only depend on `analysis`.
  const [hairstyles, beards] = await Promise.all([
    aiService.getHairstyleRecommendations(analysis),
    aiService.getBeardRecommendations(analysis),
  ]);

  const groomingGuide = aiService.getGroomingGuide(analysis);

  sendJson(res, 200, { configured: true, analysis, hairstyles, beards, groomingGuide });
}

async function handleHairstylePreview(req, res) {
  const body = await readJsonBody(req);
  if (!body.image || !body.hairstyle) {
    throw new AppError('INVALID_REQUEST', 'Missing image or hairstyle selection.', 400);
  }
  const result = await aiService.generateHairstylePreview(body.image, body.hairstyle);
  sendJson(res, 200, { configured: true, image: result });
}

async function handleBeardPreview(req, res) {
  const body = await readJsonBody(req);
  if (!body.image || !body.beardStyle) {
    throw new AppError('INVALID_REQUEST', 'Missing image or beard style selection.', 400);
  }
  const result = await aiService.generateBeardPreview(body.image, body.beardStyle);
  sendJson(res, 200, { configured: true, image: result });
}

const ROUTES = [
  { method: 'GET', pattern: /^\/api\/health$/, handler: handleHealth },
  { method: 'GET', pattern: /^\/api\/styles$/, handler: handleStyles },
  { method: 'POST', pattern: /^\/api\/analyze$/, handler: handleAnalyze },
  { method: 'POST', pattern: /^\/api\/preview\/hairstyle$/, handler: handleHairstylePreview },
  { method: 'POST', pattern: /^\/api\/preview\/beard$/, handler: handleBeardPreview },
];

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];
  const route = ROUTES.find((r) => r.method === req.method && r.pattern.test(urlPath));

  if (!route) {
    if (urlPath.startsWith('/api/')) {
      sendJson(res, 404, { error: 'NOT_FOUND', message: 'That endpoint does not exist.' });
      return;
    }
    serveStatic(req, res);
    return;
  }

  try {
    await route.handler(req, res);
  } catch (err) {
    // Handle preview errors gracefully as a 200-with-configured:false when the
    // failure is specifically "not configured", so the frontend can show a
    // clean inline message instead of a generic error toast.
    if (err instanceof AppError && (err.code === 'PREVIEW_NOT_CONFIGURED' || err.code === 'PREVIEW_NOT_IMPLEMENTED')) {
      sendJson(res, 200, { configured: false, error: err.code, message: err.message });
      return;
    }
    sendError(res, err);
  }
});

server.listen(PORT, () => {
  console.log(`FaceStyle AI server running at http://localhost:${PORT}`);
  console.log(
    aiService.isAnalysisProviderConfigured()
      ? 'AI analysis: configured (ANTHROPIC_API_KEY found).'
      : "AI analysis: NOT configured — set ANTHROPIC_API_KEY in .env to enable live analysis."
  );
  console.log(
    aiService.isImageEditProviderConfigured()
      ? 'Image preview: configured (using Gemini 2.5 Flash Image).'
      : 'Image preview: NOT configured — set IMAGE_EDIT_API_KEY in .env to enable hairstyle/beard photo previews. Until then it shows a clear "unavailable" message.'
  );
});
