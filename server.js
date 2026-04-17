// Form Reader — extraction server
// Accepts multi-file uploads (images + PDFs), sends them to a vision model,
// returns structured JSON. Thin AI layer. No storage, no history.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const Busboy = require('busboy');

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 8091;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.MODEL || 'google/gemini-2.0-flash-001';
const KILL_SWITCH = process.env.KILL_SWITCH === 'true';

// Abuse protection
const MAX_PAYLOAD_BYTES = 15 * 1024 * 1024; // 15 MB per request
const MAX_FILES = 10;                       // Max 10 files per request
const RATE_LIMIT_WINDOW_MS = 60 * 1000;     // 1 minute window
const RATE_LIMIT_PER_IP = 20;               // 20 requests/minute/IP

if (!OPENROUTER_KEY) {
  console.error('Missing OPENROUTER_API_KEY');
  process.exit(1);
}

// ── Prompts ─────────────────────────────────────────────────────────────────
const PROMPTS = {
  davis: fs.readFileSync(path.join(__dirname, 'prompts/davis.md'), 'utf8'),
  general: fs.readFileSync(path.join(__dirname, 'prompts/general.md'), 'utf8')
};

// ── Rate limiting (in-memory) ───────────────────────────────────────────────
const rateBuckets = new Map(); // ip -> [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const bucket = (rateBuckets.get(ip) || []).filter(t => t > cutoff);
  bucket.push(now);
  rateBuckets.set(ip, bucket);

  if (rateBuckets.size > 1000) {
    // Prune old IPs occasionally
    for (const [key, times] of rateBuckets.entries()) {
      if (times.every(t => t <= cutoff)) rateBuckets.delete(key);
    }
  }

  return bucket.length > RATE_LIMIT_PER_IP;
}

// ── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const clientIp = (req.headers['cf-connecting-ip'] ||
                    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                    req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Kill switch
  if (KILL_SWITCH) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Service temporarily disabled' }));
  }

  // ─ Static file serving for /public/* and / ─
  if (req.method === 'GET') {
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';

    const safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(__dirname, 'public', safePath);

    // Health
    if (urlPath === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        status: 'ok',
        model: MODEL,
        killSwitch: KILL_SWITCH
      }));
    }

    // Serve public/ files
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404);
        return res.end('Not found');
      }
      const ext = path.extname(filePath).toLowerCase();
      const mime = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.webmanifest': 'application/manifest+json',
        '.ico': 'image/x-icon'
      }[ext] || 'application/octet-stream';

      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(filePath).pipe(res);
    });
    return;
  }

  // ─ POST /extract ─
  if (req.method === 'POST' && req.url === '/extract') {
    if (rateLimited(clientIp)) {
      console.log(`[${new Date().toISOString()}] RATE LIMITED: ${clientIp}`);
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Too many requests. Wait a minute.' }));
    }

    const contentLength = parseInt(req.headers['content-length'], 10);
    if (contentLength > MAX_PAYLOAD_BYTES) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `Payload too large (max ${MAX_PAYLOAD_BYTES / 1024 / 1024}MB)` }));
    }

    handleExtract(req, res, clientIp).catch(err => {
      console.error(`[${new Date().toISOString()}] Fatal error:`, err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── Extract handler ─────────────────────────────────────────────────────────
async function handleExtract(req, res, clientIp) {
  const contentType = req.headers['content-type'] || '';
  let files = [];
  let mode = 'davis';
  let totalBytes = 0;

  // Multipart form upload (preferred)
  if (contentType.startsWith('multipart/form-data')) {
    const result = await parseMultipart(req);
    files = result.files;
    mode = result.mode || 'davis';
  } else if (contentType.includes('application/json')) {
    // JSON fallback: { mode, files: [{ name, media_type, data_base64 }] }
    const body = await readBody(req);
    const parsed = JSON.parse(body.toString());
    mode = parsed.mode || 'davis';
    files = (parsed.files || []).map(f => ({
      filename: f.name || 'file',
      mediaType: f.media_type || 'image/jpeg',
      buffer: Buffer.from(f.data_base64, 'base64')
    }));
  } else {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Unsupported content type' }));
  }

  if (files.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'No files provided' }));
  }

  if (files.length > MAX_FILES) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: `Too many files (max ${MAX_FILES})` }));
  }

  // Expand PDFs into images (one image per page) — Gemini accepts PDFs directly
  // so we pass them through without conversion. Only images and PDFs allowed.
  for (const file of files) {
    if (!file.mediaType.startsWith('image/') && file.mediaType !== 'application/pdf') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `Unsupported file type: ${file.mediaType}` }));
    }
    totalBytes += file.buffer.length;
  }

  console.log(`[${new Date().toISOString()}] ${clientIp} extracting ${files.length} file(s), ${(totalBytes / 1024).toFixed(0)}KB, mode=${mode}`);

  const prompt = PROMPTS[mode] || PROMPTS.davis;
  const result = await callOpenRouter(files, prompt);

  console.log(`[${new Date().toISOString()}] extraction complete`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}

// ── Multipart parser ────────────────────────────────────────────────────────
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const files = [];
    const fields = {};
    const bb = Busboy({
      headers: req.headers,
      limits: {
        fileSize: MAX_PAYLOAD_BYTES,
        files: MAX_FILES,
        fields: 5
      }
    });

    bb.on('file', (_name, stream, info) => {
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('limit', () => reject(new Error('File too large')));
      stream.on('end', () => {
        files.push({
          filename: info.filename || 'file',
          mediaType: info.mimeType || 'application/octet-stream',
          buffer: Buffer.concat(chunks)
        });
      });
    });
    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('finish', () => resolve({ files, mode: fields.mode }));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > MAX_PAYLOAD_BYTES) {
        req.destroy();
        return reject(new Error('Payload too large'));
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── OpenRouter call ─────────────────────────────────────────────────────────
function callOpenRouter(files, prompt) {
  return new Promise((resolve, reject) => {
    const content = [];
    for (const file of files) {
      const dataUrl = `data:${file.mediaType};base64,${file.buffer.toString('base64')}`;
      if (file.mediaType === 'application/pdf') {
        content.push({ type: 'file', file: { filename: file.filename, file_data: dataUrl } });
      } else {
        content.push({ type: 'image_url', image_url: { url: dataUrl } });
      }
    }
    content.push({ type: 'text', text: prompt });

    const payload = JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      messages: [{ role: 'user', content }]
    });

    const options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer': 'https://form-reader.nestai.cc',
        'X-Title': 'Form Reader'
      }
    };

    const request = https.request(options, (response) => {
      const chunks = [];
      response.on('data', c => chunks.push(c));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) {
            return reject(new Error(`OpenRouter: ${parsed.error.message || JSON.stringify(parsed.error)}`));
          }
          const text = parsed.choices?.[0]?.message?.content;
          if (!text) return reject(new Error('No content in model response'));

          let cleaned = text.trim();
          if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
          }
          resolve(JSON.parse(cleaned));
        } catch (e) {
          reject(new Error(`Parse failure: ${e.message}\nRaw (first 500): ${raw.substring(0, 500)}`));
        }
      });
    });

    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

// ── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Form Reader server on port ${PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Kill switch: ${KILL_SWITCH ? 'ON (503s)' : 'OFF'}`);
  console.log(`Rate limit: ${RATE_LIMIT_PER_IP} req/${RATE_LIMIT_WINDOW_MS / 1000}s per IP`);
  console.log(`Max payload: ${MAX_PAYLOAD_BYTES / 1024 / 1024}MB`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM — shutting down');
  server.close(() => process.exit(0));
});
