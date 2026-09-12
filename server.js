const http = require('http');
const { captchaModelManager, parseFlag } = require('./src/captcha-model-manager');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 11438;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function authorized(req, token = process.env.FIPTCHA_TOKEN || '') {
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request body is too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}

function decodeImage(value) {
  if (typeof value !== 'string' || !value.length) {
    const error = new Error('image must be a non-empty base64 string');
    error.statusCode = 400;
    throw error;
  }
  const normalized = value.replace(/^data:image\/png;base64,/, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    const error = new Error('image must be valid base64');
    error.statusCode = 400;
    throw error;
  }
  const image = Buffer.from(normalized, 'base64');
  if (!image.length) {
    const error = new Error('image decoded to an empty buffer');
    error.statusCode = 400;
    throw error;
  }
  if (image.length > MAX_IMAGE_BYTES) {
    const error = new Error('image is too large');
    error.statusCode = 413;
    throw error;
  }
  return image;
}

function parseThreshold(value) {
  if (value === undefined || value === null) return undefined;
  const threshold = Number(value);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    const error = new Error('threshold must be a number between 0 and 1');
    error.statusCode = 400;
    throw error;
  }
  return threshold;
}

function createServer(options = {}) {
  const modelManager = options.modelManager || captchaModelManager;
  const token = options.token ?? process.env.FIPTCHA_TOKEN ?? '';
  return http.createServer(async (req, res) => {
    try {
      if (!authorized(req, token)) return json(res, 401, { error: 'unauthorized' });

      const url = new URL(req.url || '/', 'http://fiptcha.local');
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, {
          ok: true,
          service: 'fiptcha',
          model: modelManager.status(),
          skipped: parseFlag(process.env.SKIP_LOCAL_CAPTCHA_MODEL)
        });
      }

      if (req.method === 'POST' && url.pathname === '/detect') {
        const body = await readJson(req);
        const label = String(body.label || '').trim();
        if (!label || label.length > 500) return json(res, 400, { error: 'label must be between 1 and 500 characters' });
        const image = decodeImage(body.image);
        const threshold = parseThreshold(body.threshold);
        const detections = await modelManager.detect(image, label, threshold);
        return json(res, 200, {
          detections: Array.isArray(detections) ? detections : [],
          model: modelManager.status()
        });
      }

      return json(res, 404, { error: 'not_found' });
    } catch (error) {
      const status = Number(error.statusCode) || 500;
      return json(res, status, { error: status >= 500 ? 'solver_error' : 'bad_request', message: error.message });
    }
  });
}

async function start() {
  const host = process.env.FIPTCHA_HOST || DEFAULT_HOST;
  const port = Number(process.env.FIPTCHA_PORT) || DEFAULT_PORT;
  captchaModelManager.start().catch((error) => {
    console.warn('[FIPTCHA] Model startup failed:', error.message);
  });
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  console.log(`[FIPTCHA] Listening on http://${host}:${port}`);
  return server;
}

if (require.main === module) {
  start().catch((error) => {
    console.error('[FIPTCHA] Failed to start:', error);
    process.exitCode = 1;
  });
}

module.exports = { createServer, start, readJson, decodeImage, parseThreshold, DEFAULT_HOST, DEFAULT_PORT };
