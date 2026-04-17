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
const MODEL = process.env.MODEL || 'google/gemini-2.5-pro';
const KILL_SWITCH = process.env.KILL_SWITCH === 'true';

// When true, trust proxy headers (cf-connecting-ip, x-forwarded-for).
// Only enable behind a known reverse proxy / tunnel. Default off.
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

// Allowed browser origins. Comma-separated. Empty = no CORS (same-origin only).
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

// Abuse protection
const MAX_PAYLOAD_BYTES = 15 * 1024 * 1024; // 15 MB per full request
const MAX_FILES = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;     // 1 minute
const RATE_LIMIT_PER_IP = 20;
const MAX_RATE_BUCKETS = 2000;               // bounded LRU

if (!OPENROUTER_KEY) {
  console.error('Missing OPENROUTER_API_KEY');
  process.exit(1);
}

// ── Prompts ─────────────────────────────────────────────────────────────────
const PROMPTS = {
  davis: fs.readFileSync(path.join(__dirname, 'prompts/davis.md'), 'utf8'),
  general: fs.readFileSync(path.join(__dirname, 'prompts/general.md'), 'utf8')
};

// ── Reference images (the blank forms) ──────────────────────────────────────
// Included at the start of Davis-mode extraction so the model has a precise
// anchor for what a blank Davis form looks like. If forms change, re-render
// these PNGs; no code change needed.
const REFERENCES = {};
try {
  const refDir = path.join(__dirname, 'prompts/reference');
  if (fs.existsSync(refDir)) {
    REFERENCES.davis = [];
    for (const name of ['quick-start.png', 'financial-sketch.png', 'what-to-bring.png']) {
      const p = path.join(refDir, name);
      if (fs.existsSync(p)) {
        REFERENCES.davis.push({
          filename: name,
          mediaType: 'image/png',
          buffer: fs.readFileSync(p),
          label: name.replace('.png', '')
        });
      }
    }
    console.log(`Loaded ${REFERENCES.davis.length} reference blank forms`);
  }
} catch (e) {
  console.error('Reference load warning:', e.message);
}

// ── Rate limiting — bounded LRU with deterministic expiry ───────────────────
const rateBuckets = new Map(); // ip -> array of timestamps

function rateLimited(ip) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const existing = rateBuckets.get(ip) || [];
  const fresh = existing.filter(t => t > cutoff);
  fresh.push(now);

  // Re-insert to move to most-recent position (LRU)
  rateBuckets.delete(ip);
  rateBuckets.set(ip, fresh);

  // Evict oldest entries if we exceed the cap
  while (rateBuckets.size > MAX_RATE_BUCKETS) {
    const oldestKey = rateBuckets.keys().next().value;
    rateBuckets.delete(oldestKey);
  }

  return fresh.length > RATE_LIMIT_PER_IP;
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp) return cfIp.trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
  }
  return (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

// ── CORS ────────────────────────────────────────────────────────────────────
function setCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return; // same-origin requests don't need CORS
  if (ALLOW_ORIGINS.length === 0) return; // no configured allowlist = no CORS
  if (ALLOW_ORIGINS.includes(origin) || ALLOW_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}

// ── Error sanitization ──────────────────────────────────────────────────────
// Never leak upstream model content or stack traces to the browser.
function safeErrorMessage(err, fallback = 'Something went wrong reading that upload. Please try again.') {
  if (!err) return fallback;
  const msg = err.message || String(err);
  // Whitelist of safe messages we set ourselves — pass them through.
  const safe = [
    'Too many requests',
    'Payload too large',
    'Too many files',
    'No files provided',
    'Unsupported file type',
    'Unsupported content type',
    'Service temporarily disabled'
  ];
  for (const s of safe) {
    if (msg.startsWith(s) || msg.includes(s)) return msg.substring(0, 200);
  }
  return fallback;
}

// ── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Kill switch — active even for static pages so we stop serving the UI too
  if (KILL_SWITCH && req.url !== '/health') {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Service temporarily disabled' }));
  }

  if (req.method === 'GET') {
    return handleGet(req, res);
  }

  // POST / (share target) — redirect share-target uploads into the main flow
  // by rendering the index page; the frontend will pick up the files from a
  // temporary in-memory stash via the session-cookie-free "redirect with query"
  // pattern. For now we just redirect to the root, since share-target receive
  // and forward is a whole sub-project — see issue tracker for v0.2.
  if (req.method === 'POST' && (req.url === '/' || req.url === '')) {
    // Consume the body (required) then redirect to root so the user sees the UI.
    req.resume();
    req.on('end', () => {
      res.writeHead(303, { Location: '/' });
      res.end();
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/extract') {
    const ip = clientIp(req);
    if (rateLimited(ip)) {
      console.log(`[${new Date().toISOString()}] rate-limited: ${ip}`);
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Too many requests. Please wait a minute.' }));
    }

    handleExtract(req, res, ip).catch(err => {
      console.error(`[${new Date().toISOString()}] error:`, err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: safeErrorMessage(err) }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── Static files ────────────────────────────────────────────────────────────
function handleGet(req, res) {
  let urlPath = req.url.split('?')[0];

  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      model: MODEL,
      killSwitch: KILL_SWITCH
    }));
  }

  if (urlPath === '/') urlPath = '/index.html';

  const safe = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(__dirname, 'public', safe);
  const publicDir = path.join(__dirname, 'public');
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

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
}

// ── Extract handler ─────────────────────────────────────────────────────────
async function handleExtract(req, res, ip) {
  const contentType = req.headers['content-type'] || '';
  let files = [];
  let mode = 'davis';

  if (contentType.startsWith('multipart/form-data')) {
    const result = await parseMultipart(req);
    files = result.files;
    mode = result.mode || 'davis';
  } else if (contentType.includes('application/json')) {
    const body = await readBodyLimited(req, MAX_PAYLOAD_BYTES);
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

  let total = 0;
  for (const file of files) {
    if (!file.mediaType.startsWith('image/') && file.mediaType !== 'application/pdf') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `Unsupported file type: ${file.mediaType}` }));
    }
    total += file.buffer.length;
  }

  console.log(`[${new Date().toISOString()}] ${ip} extract: ${files.length} file(s), ${(total / 1024).toFixed(0)}KB, mode=${mode}`);

  const prompt = PROMPTS[mode] || PROMPTS.davis;
  const references = mode === 'davis' ? (REFERENCES.davis || []) : [];
  const result = await callOpenRouter(files, prompt, references);

  // Post-processing validation: sanity-check values and add flags for anything
  // that looks suspicious. The model is fast but fallible; these are cheap
  // server-side checks that catch the most common handwriting miscues.
  if (mode === 'davis') {
    validateDavisFields(result);
  }

  console.log(`[${new Date().toISOString()}] extract complete`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}

// ── Davis field validation ──────────────────────────────────────────────────
const COMMON_TLDS = new Set([
  'com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'io', 'co', 'us', 'me',
  'info', 'biz', 'us', 'uk', 'ca', 'eu', 'ai', 'dev', 'app', 'tech'
]);

// Common free-mail domains — we can be more specific about these
const COMMON_DOMAINS = [
  'gmail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com', 'outlook.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com', 'mail.com', 'msn.com',
  'comcast.net', 'verizon.net', 'att.net', 'cox.net', 'sbcglobal.net',
  'protonmail.com', 'proton.me', 'fastmail.com', 'zoho.com'
];

// Map of Davis field IDs to their "type" for confidence calibration.
// Only fields the model can truly verify (selects with a clear mark,
// explicitly null fields) should be allowed to carry 100% confidence.
// Handwritten text, numbers, and free-text are never truly certain.
const FIELD_TYPES = {
  // Verifiable select fields — 100% is OK if clearly marked
  has_spouse: 'select', has_children: 'select', existing_advisor: 'select',
  income_range: 'select', net_worth_range: 'select', has_pension: 'select',
  social_security: 'select', cash_flow_direction: 'select', housing: 'select',
  has_other_property: 'select', has_stock_options: 'select', has_other_assets: 'select',
  wealth_arc: 'select', paying_for_college: 'select', has_529: 'select',
  protection_feel: 'select', has_will: 'select', has_poa: 'select', has_hcp: 'select',
  estate_organized: 'select', values_investing: 'select', charitable: 'select',
  involvement: 'select', tax_satisfaction: 'select',

  // Boolean checkboxes — 100% if clearly checked
  has_auto_loan: 'bool', has_student_loan: 'bool', has_personal_debt: 'bool',
  has_credit_cards: 'bool', life_insurance_has: 'bool', disability_has: 'bool',
  ltc_has: 'bool', vault_tax: 'bool', vault_investments: 'bool',
  vault_insurance: 'bool', vault_estate: 'bool', vault_benefits: 'bool',
  vault_equity: 'bool', vault_debt: 'bool', vault_ssn_statement: 'bool',

  // Numeric / structured text — cap at 95%, lower if fails validation
  phone: 'numeric', email: 'text_validated', dob: 'numeric', spouse_dob: 'numeric',
  income_primary: 'numeric', income_spouse: 'numeric', cash_flow_amount: 'numeric',
  monthly_need: 'numeric', home_value: 'numeric', mortgage_balance: 'numeric',
  mortgage_payment: 'numeric', other_property_value: 'numeric',
  other_property_mortgage: 'numeric', bank_total: 'numeric',
  retirement_total: 'numeric', taxable_total: 'numeric', crypto_total: 'numeric',
  college_savings_total: 'numeric', auto_bal: 'numeric', student_bal: 'numeric',
  personal_bal: 'numeric', cc_bal: 'numeric', life_insurance_amount: 'numeric',
  disability_amount: 'numeric', ltc_amount: 'numeric', will_updated: 'numeric',

  // Plain handwritten text — cap at 92%
  // (names, occupations, single-line freetext)
  first_name: 'text', last_name: 'text', spouse_first: 'text', spouse_last: 'text',
  occupation: 'text', spouse_occupation: 'text', investable_thoughts: 'text',
  retire_when: 'text', retire_vision: 'text', tax_advisor: 'text',
  estate_attorney: 'text', referral_source: 'text', other_property_type: 'text',

  // Longer written text (writing boxes, textareas) — cap at 88%
  other_dependents: 'longtext', pension_detail: 'longtext', future_inflows: 'longtext',
  big_expenses: 'longtext', housing_plans: 'longtext', accounts_notes: 'longtext',
  stock_options_detail: 'longtext', other_assets: 'longtext', wealth_comfort: 'longtext',
  college_feeling: 'longtext', family_money_dynamics: 'longtext', matters_most: 'longtext',
  values_detail: 'longtext', charitable_detail: 'longtext', why_now: 'longtext',
  catalyst: 'longtext',

  // Special
  children: 'children'
};

// Confidence ceilings by field type
const CONFIDENCE_CEILINGS = {
  select: 1.00,       // clear mark on a known option
  bool: 1.00,         // clear checkbox
  numeric: 0.95,      // validated numeric — still handwriting
  text_validated: 0.95, // validated text like email — passes format
  text: 0.92,         // handwritten short text (name, occupation)
  longtext: 0.88,     // handwritten paragraphs
  children: 0.92      // array of {name, age, notes}
};

function validateDavisFields(result) {
  if (!result || !result.fields) return;
  result.flags = result.flags || [];

  const fields = result.fields;

  // Step 1: apply calibrated confidence caps. Null values keep 1.0 (we're
  // genuinely certain nothing was written). Everything else gets capped
  // by field type so the reviewer never sees a fake 100% on a handwritten value.
  for (const [id, field] of Object.entries(fields)) {
    if (!field || typeof field !== 'object') continue;
    // Null/empty fields — the model is genuinely certain
    if (field.value === null || field.value === '' || field.value === undefined) {
      field.confidence = 1.0;
      continue;
    }
    // Array with zero items — same as null
    if (Array.isArray(field.value) && field.value.length === 0) {
      field.confidence = 1.0;
      continue;
    }
    const type = FIELD_TYPES[id] || 'text';
    const ceiling = CONFIDENCE_CEILINGS[type];
    const modelConf = typeof field.confidence === 'number' ? field.confidence : 0.85;
    field.confidence = Math.min(modelConf, ceiling);
  }

  // Email validation — flag if TLD is unusual or domain looks wrong
  const email = fields.email?.value;
  if (email && typeof email === 'string') {
    const emailMatch = email.match(/^[^\s@]+@([^\s@]+\.[^\s@]+)$/);
    if (!emailMatch) {
      result.flags.push(`Email "${email}" doesn't match the expected format — please verify.`);
      fields.email.confidence = Math.min(fields.email.confidence || 1, 0.5);
    } else {
      const domain = emailMatch[1].toLowerCase();
      const tld = domain.split('.').pop();
      // If the domain is short and ambiguous (like "me.com" vs "mail.com"),
      // explicitly flag it so the reviewer double-checks.
      const suspiciousShortDomains = ['me.com', 'ml.com', 'mi.com', 'ma.com'];
      if (suspiciousShortDomains.includes(domain) || !COMMON_TLDS.has(tld)) {
        result.flags.push(`Email domain "${domain}" — please double-check (handwritten emails are easy to misread).`);
        fields.email.confidence = Math.min(fields.email.confidence || 1, 0.7);
      }
    }
  }

  // Phone validation — must be 10 digits when cleaned
  const phone = fields.phone?.value;
  if (phone && typeof phone === 'string') {
    const digits = phone.replace(/\D/g, '');
    if (digits.length !== 10 && digits.length !== 11) {
      result.flags.push(`Phone "${phone}" has ${digits.length} digits — expected 10. Please verify.`);
      fields.phone.confidence = Math.min(fields.phone.confidence || 1, 0.4);
    }
  }

  // Spouse phone (if present in financial sketch)
  const spousePhone = fields.spouse_phone?.value;
  if (spousePhone && typeof spousePhone === 'string') {
    const digits = spousePhone.replace(/\D/g, '');
    if (digits.length !== 10 && digits.length !== 11) {
      result.flags.push(`Spouse phone "${spousePhone}" has ${digits.length} digits — expected 10. Please verify.`);
    }
  }

  // DOB sanity: year should be plausible (1900-2025)
  const checkDob = (field, label) => {
    const v = fields[field]?.value;
    if (!v || typeof v !== 'string') return;
    const yearMatch = v.match(/\b(19\d{2}|20\d{2}|\d{2})\b/g);
    if (!yearMatch) {
      result.flags.push(`${label} "${v}" — could not find a year. Please verify.`);
    }
  };
  checkDob('dob', 'Date of birth');
  checkDob('spouse_dob', 'Spouse DOB');

  // Margin notes that look like they might be from the masthead — flag for review
  if (Array.isArray(result.margin_notes)) {
    const mastheadKeywords = [
      'davis financial group', 'values-based', 'vbsi', 'quick start',
      'financial sketch', 'what to bring', 'strictly confidential',
      '10 bay road', 'hadley'
    ];
    result.margin_notes = result.margin_notes.filter(note => {
      const text = (note.text || '').toLowerCase();
      const looksLikeMasthead = mastheadKeywords.some(kw => text.includes(kw));
      if (looksLikeMasthead) {
        console.log(`[post-proc] dropping margin note that looks like masthead: "${note.text}"`);
        return false;
      }
      return true;
    });
    if (result.margin_notes.length === 0) delete result.margin_notes;
  }
}

// ── Multipart parser with hard total-bytes cap ──────────────────────────────
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const files = [];
    const fields = {};
    let totalBytes = 0;
    let aborted = false;

    const bb = Busboy({
      headers: req.headers,
      limits: {
        fileSize: MAX_PAYLOAD_BYTES,
        files: MAX_FILES,
        fields: 5
      }
    });

    const abortWith = (msg) => {
      if (aborted) return;
      aborted = true;
      req.unpipe(bb);
      req.destroy();
      reject(new Error(msg));
    };

    bb.on('file', (_name, stream, info) => {
      const chunks = [];
      stream.on('data', c => {
        totalBytes += c.length;
        if (totalBytes > MAX_PAYLOAD_BYTES) {
          stream.resume();
          return abortWith(`Payload too large (max ${MAX_PAYLOAD_BYTES / 1024 / 1024}MB)`);
        }
        chunks.push(c);
      });
      stream.on('limit', () => abortWith(`Payload too large (file exceeded ${MAX_PAYLOAD_BYTES / 1024 / 1024}MB)`));
      stream.on('end', () => {
        if (aborted) return;
        files.push({
          filename: info.filename || 'file',
          mediaType: info.mimeType || 'application/octet-stream',
          buffer: Buffer.concat(chunks)
        });
      });
    });
    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('finish', () => { if (!aborted) resolve({ files, mode: fields.mode }); });
    bb.on('error', err => abortWith(err.message || 'upload error'));
    req.on('aborted', () => abortWith('connection closed'));
    req.pipe(bb);
  });
}

function readBodyLimited(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > max) {
        req.destroy();
        return reject(new Error(`Payload too large (max ${max / 1024 / 1024}MB)`));
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── OpenRouter call ─────────────────────────────────────────────────────────
function callOpenRouter(files, prompt, references = []) {
  return new Promise((resolve, reject) => {
    const content = [];

    // Reference blank forms come first, with a label so the model knows these
    // are templates to compare against, not the user's upload.
    if (references.length) {
      content.push({
        type: 'text',
        text: `The next ${references.length} image${references.length > 1 ? 's are' : ' is'} BLANK reference form${references.length > 1 ? 's' : ''} from The Davis Financial Group (in order: ${references.map(r => r.label).join(', ')}). These are templates showing what clean, empty versions look like. Use them as anchors to find fields, recognize the document type, and spot anything unusual in the user's uploaded form.`
      });
      for (const ref of references) {
        const dataUrl = `data:${ref.mediaType};base64,${ref.buffer.toString('base64')}`;
        content.push({ type: 'image_url', image_url: { url: dataUrl } });
      }
      content.push({
        type: 'text',
        text: `Now here ${files.length > 1 ? 'are' : 'is'} the FILLED-IN form${files.length > 1 ? 's' : ''} from the client (${files.length} image${files.length > 1 ? 's' : ''}). Extract from these, using the blanks above as your reference:`
      });
    }

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
            // Log the upstream detail but return a generic message.
            console.error('OpenRouter error detail:', parsed.error);
            return reject(new Error('upstream-error'));
          }
          const text = parsed.choices?.[0]?.message?.content;
          if (!text) return reject(new Error('empty-response'));

          let cleaned = text.trim();
          if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
          }
          resolve(JSON.parse(cleaned));
        } catch (e) {
          // Log the raw response for debugging; return nothing specific to user.
          console.error('parse failure:', e.message);
          console.error('raw (first 500):', raw.substring(0, 500));
          reject(new Error('parse-failure'));
        }
      });
    });

    request.on('error', err => {
      console.error('OpenRouter request error:', err.message);
      reject(new Error('network-error'));
    });
    request.setTimeout(60000, () => {
      request.destroy();
      reject(new Error('upstream-timeout'));
    });
    request.write(payload);
    request.end();
  });
}

// ── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Form Reader on port ${PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Trust proxy headers: ${TRUST_PROXY}`);
  console.log(`CORS allowlist: ${ALLOW_ORIGINS.length ? ALLOW_ORIGINS.join(', ') : '(same-origin only)'}`);
  console.log(`Kill switch: ${KILL_SWITCH ? 'ON (503s)' : 'OFF'}`);
  console.log(`Rate limit: ${RATE_LIMIT_PER_IP} req/${RATE_LIMIT_WINDOW_MS / 1000}s per IP`);
  console.log(`Max payload: ${MAX_PAYLOAD_BYTES / 1024 / 1024}MB total per request`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM — shutting down');
  server.close(() => process.exit(0));
});
