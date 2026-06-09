import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// ---------------------------------------------------------------------------
// SQLite database initialization
// ---------------------------------------------------------------------------
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'usage.db'));
db.pragma('journal_mode = WAL');
// Durability for usage/billing records:
// NORMAL is safe under WAL, and a small autocheckpoint threshold keeps the
// -wal file from growing unbounded so committed rows land in the main .db
// file promptly. A stale main .db plus a huge -wal is exactly how history
// gets "wiped" — if that -wal is ever dropped, or the container is killed
// ungracefully before a checkpoint, everything since the last checkpoint is lost.
db.pragma('synchronous = NORMAL');
db.pragma('wal_autocheckpoint = 100');

db.exec(`
  CREATE TABLE IF NOT EXISTS translations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT (datetime('now')),
    source_lang TEXT,
    target_lang TEXT,
    char_count INTEGER,
    estimated_cost_usd REAL
  );

  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Add model_used column to translations if missing (idempotent migration)
const translationCols = db.prepare(`PRAGMA table_info(translations)`).all();
if (!translationCols.some(c => c.name === 'model_used')) {
  db.exec(`ALTER TABLE translations ADD COLUMN model_used TEXT DEFAULT 'basic'`);
}

// Bootstrap default active_model setting if not present
db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('active_model', 'basic')`).run();

// Prepare statements for performance
const insertTranslation = db.prepare(`
  INSERT INTO translations (source_lang, target_lang, char_count, estimated_cost_usd, model_used)
  VALUES (@source_lang, @target_lang, @char_count, @estimated_cost_usd, @model_used)
`);

const getSetting = db.prepare(`SELECT value FROM settings WHERE key = ?`);
const upsertSetting = db.prepare(`
  INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
`);

// Valid translation model identifiers — keep in sync with /api/settings validation and frontend
const VALID_MODELS = new Set(['basic', 'premium']);

function getActiveModel() {
  const row = getSetting.get('active_model');
  const value = row?.value;
  return VALID_MODELS.has(value) ? value : 'basic';
}

// ---------------------------------------------------------------------------
// Auth: bootstrap initial admin, JWT helpers, auth middleware
// ---------------------------------------------------------------------------
const IS_PROD = process.env.NODE_ENV === 'production';

// Fail-fast on missing critical secrets in production — a leaked default JWT
// secret would let anyone mint admin tokens.
if (IS_PROD && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET must be set in production');
  process.exit(1);
}
if (IS_PROD && !process.env.GOOGLE_TRANSLATE_API_KEY) {
  console.error('FATAL: GOOGLE_TRANSLATE_API_KEY must be set in production');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';
const JWT_EXPIRES_IN = '12h';
const BCRYPT_ROUNDS = 12;

// Supported language codes — keep in sync with /api/languages and frontend `languages`
const SUPPORTED_LANGS = new Set([
  'zh-TW', 'en', 'ja', 'ko', 'es', 'fr', 'de',
  'pt', 'ru', 'ar', 'hi', 'th', 'vi', 'id', 'it',
]);

function hashPassword(plain) {
  return bcrypt.hashSync(plain, BCRYPT_ROUNDS);
}

function bootstrapAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  if (count > 0) return;
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    console.warn('⚠️  尚無管理員且未設定 ADMIN_USERNAME / ADMIN_PASSWORD，後台將無法登入。請於 .env 設定後重啟。');
    return;
  }
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')
    .run(username, hashPassword(password));
  console.log(`👤 已建立初始管理員: ${username}`);
}
bootstrapAdmin();

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: '未授權，請先登入' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Confirm the admin still exists (handles deleted accounts)
    const admin = db.prepare('SELECT id, username FROM admins WHERE id = ?').get(payload.sub);
    if (!admin) return res.status(401).json({ error: '帳號已不存在，請重新登入' });
    req.admin = admin;
    next();
  } catch {
    return res.status(401).json({ error: '登入已過期，請重新登入' });
  }
}

const app = express();
const PORT = process.env.PORT || 3001;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'frame-ancestors': ["'self'", 'https://www.tissa.tw', 'https://tissa.tw', 'https://www.cisanet.org.tw', 'https://cisanet.org.tw', 'https://www.cisa.tw', 'https://cisa.tw'],
      // Setting to null removes these directives so browsers fall back to default-src 'self'.
      // (helmet defaults add `https:` to script-src/style-src, which we don't need for a bundled SPA.)
      'script-src': null,
      'style-src': null,
    },
  },
  crossOriginEmbedderPolicy: false,
  frameguard: false, // Disable X-Frame-Options — using CSP frame-ancestors instead
}));

// CORS - allow all origins by default for iframe embedding
// Set ALLOWED_ORIGINS env var to restrict (comma-separated), e.g. "https://example.com,https://other.com"
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['*'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (same-origin, curl, mobile apps, etc.)
    if (!origin) return callback(null, true);
    // Allow all origins
    if (allowedOrigins.includes('*')) return callback(null, true);
    // Check specific allowed origins
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false, // No cookies/sessions needed; false allows wildcard origin
}));

app.use(morgan('combined'));
// Translation payload is capped at 5000 chars (~20KB UTF-8); 64KB leaves headroom
// for auth/admin payloads while preventing oversized requests from reaching us.
app.use(express.json({ limit: '64kb' }));

// Rate limiting
// Always respond with JSON ({ error }) so the frontend can surface the real
// reason — the default handler sends plain text, which the client's res.json()
// fails to parse and then falls back to a generic "翻譯請求失敗".
function rateLimitJson(message) {
  return (req, res) => res.status(429).json({ error: message });
}

// NOTE: behind Docker's port-forward (and most reverse proxies without a
// trusted X-Forwarded-For) every client appears as the same upstream IP, so
// these limits are effectively shared across all users. Keep them generous
// enough for legitimate continuous dictation by several concurrent users while
// still capping abuse. For true per-user limits, put an HTTP reverse proxy in
// front that sets X-Forwarded-For and enable Express `trust proxy`.
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 200,
  handler: rateLimitJson('請求過於頻繁，請稍後再試'),
  standardHeaders: true,
  legacyHeaders: false,
});

const translationLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  handler: rateLimitJson('翻譯請求過於頻繁，請稍候再試'),
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
});

app.use('/api', limiter);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'voice-translator-backend'
  });
});

// ---------------------------------------------------------------------------
// Translation engines — basic (Google Translate v2) and premium (Gemini Flash)
// Both return: { translation, detectedSourceLanguage }
// ---------------------------------------------------------------------------

class TranslateError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const LANG_NAMES = {
  'zh-TW': 'Traditional Chinese (zh-TW)',
  en: 'English', ja: 'Japanese', ko: 'Korean', es: 'Spanish', fr: 'French',
  de: 'German', pt: 'Portuguese', ru: 'Russian', ar: 'Arabic', hi: 'Hindi',
  th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', it: 'Italian',
};

async function translateWithGoogleV2(text, source, target) {
  const API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!API_KEY) throw new TranslateError(500, '翻譯服務暫時不可用，請稍後再試');

  const requestBody = { q: text, target, format: 'text' };
  if (source) requestBody.source = source;

  const response = await fetch(
    `https://translation.googleapis.com/language/translate/v2?key=${API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('Google API 錯誤:', errorData);
    if (response.status === 403) throw new TranslateError(403, 'API 權限錯誤，請聯繫管理員');
    if (response.status === 429) throw new TranslateError(429, 'API 請求限制，請稍後再試');
    throw new TranslateError(500, errorData.error?.message || '翻譯請求失敗');
  }

  const data = await response.json();
  const t = data.data?.translations?.[0];
  if (!t?.translatedText) throw new TranslateError(500, '無法取得翻譯結果');

  return {
    translation: t.translatedText,
    detectedSourceLanguage: t.detectedSourceLanguage || source || null,
  };
}

async function translateWithGemini(text, source, target) {
  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) throw new TranslateError(500, '高品質翻譯服務未設定，請聯繫管理員');

  const sourceHint = source
    ? `The source language is ${LANG_NAMES[source] || source}.`
    : 'Auto-detect the source language.';
  const targetName = LANG_NAMES[target] || target;

  const prompt = `You are a faithful translator. Translate the user's text into ${targetName}. ${sourceHint}

CRITICAL RULES — follow strictly:
1. Translate FAITHFULLY. Do NOT paraphrase, embellish, summarize, or "improve" the source.
2. Preserve the exact meaning, including nuance, hedging, vagueness, and informality. If the source is casual, the translation must be casual. If the source is fragmented or awkward, keep it fragmented or awkward.
3. Do NOT add information that is not in the source. Do NOT remove information that is in the source.
4. Do NOT correct apparent typos, grammar mistakes, or speech-recognition errors — translate them as-is.
5. Preserve all punctuation, line breaks, numbers, and proper nouns. Do not transliterate proper nouns unless a standard translation exists.
6. If the source contains filler words ("呃", "那個", "um"), translate them with equivalent fillers.
7. Output ONLY the translation. No quotes, no labels, no explanations, no alternatives.

Source text (translate exactly what is between the triple backticks):
\`\`\`
${text}
\`\`\``;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          topP: 0.1,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'object',
            properties: {
              translation: { type: 'string' },
              detected_source_language: { type: 'string', description: 'BCP-47 code like en, ja, zh-TW' },
            },
            required: ['translation', 'detected_source_language'],
          },
        },
        // Disable safety blocks so we don't lose translations for benign edge cases
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
      }),
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('Gemini API 錯誤:', errorData);
    if (response.status === 403) throw new TranslateError(403, 'Gemini API 權限錯誤，請聯繫管理員');
    if (response.status === 429) throw new TranslateError(429, 'API 請求限制，請稍後再試');
    throw new TranslateError(500, errorData.error?.message || '翻譯請求失敗');
  }

  const data = await response.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new TranslateError(500, '無法取得翻譯結果');

  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new TranslateError(500, '翻譯結果格式錯誤'); }
  if (!parsed.translation) throw new TranslateError(500, '無法取得翻譯結果');

  // Normalize detected language to our supported set (Gemini may return e.g. "zh" instead of "zh-TW")
  let detected = parsed.detected_source_language || source || null;
  if (detected && !SUPPORTED_LANGS.has(detected)) {
    const lower = detected.toLowerCase();
    if (lower.startsWith('zh')) detected = 'zh-TW';
    else if (SUPPORTED_LANGS.has(lower.slice(0, 2))) detected = lower.slice(0, 2);
  }

  return { translation: parsed.translation, detectedSourceLanguage: detected };
}

// Per-model cost estimate ($/char). Gemini Flash is billed by token but
// char-rate is a stable proxy for usage tracking — Chinese ~1 token/char,
// Latin ~0.25 token/char; we use a conservative blended rate.
const MODEL_COSTS = {
  basic:   0.00002,    // Google Translate v2 standard tier
  premium: 0.000004,   // Gemini 2.5 Flash estimate (rough; per-token in reality)
};

// Translation API - dispatches to active model
app.post('/api/translate', translationLimiter, async (req, res) => {
  try {
    const { text, source, target } = req.body;

    if (typeof text !== 'string' || !text.trim() || typeof target !== 'string') {
      return res.status(400).json({ error: '缺少必要參數', required: ['text', 'target'] });
    }
    if (text.length > 5000) {
      return res.status(400).json({ error: '文字過長，最多支援 5000 個字元' });
    }
    if (!SUPPORTED_LANGS.has(target)) {
      return res.status(400).json({ error: `不支援的目標語言: ${target}` });
    }
    if (source && !SUPPORTED_LANGS.has(source)) {
      return res.status(400).json({ error: `不支援的來源語言: ${source}` });
    }

    const model = getActiveModel();
    console.log(`翻譯請求 [${model}]: ${source || 'auto'} -> ${target}, 文字長度: ${text.length}`);

    let result;
    try {
      result = model === 'premium'
        ? await translateWithGemini(text, source, target)
        : await translateWithGoogleV2(text, source, target);
    } catch (err) {
      if (err instanceof TranslateError) {
        return res.status(err.status).json({ error: err.message });
      }
      throw err;
    }

    const char_count = text.length;
    const estimated_cost_usd = char_count * (MODEL_COSTS[model] ?? MODEL_COSTS.basic);

    try {
      insertTranslation.run({
        source_lang: source || result.detectedSourceLanguage,
        target_lang: target,
        char_count,
        estimated_cost_usd,
        model_used: model,
      });
    } catch (dbErr) {
      console.error('DB insert error:', dbErr);
    }

    res.json({
      success: true,
      translation: result.translation,
      detectedSourceLanguage: result.detectedSourceLanguage,
      source: source || result.detectedSourceLanguage,
      target,
      model,
      char_count,
      estimated_cost_usd,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('翻譯錯誤:', error);
    res.status(500).json({
      error: '翻譯服務發生錯誤',
      message: process.env.NODE_ENV === 'development' ? error.message : '請稍後再試'
    });
  }
});

// Languages endpoint
app.get('/api/languages', (req, res) => {
  res.json({
    languages: [
      { code: 'zh-TW', name: '繁體中文' },
      { code: 'en', name: 'English' },
      { code: 'ja', name: '日本語' },
      { code: 'ko', name: '한국어' },
      { code: 'es', name: 'Español' },
      { code: 'fr', name: 'Français' },
      { code: 'de', name: 'Deutsch' },
      { code: 'pt', name: 'Português' },
      { code: 'ru', name: 'Русский' },
      { code: 'ar', name: 'العربية' },
      { code: 'hi', name: 'हिन्दी' },
      { code: 'th', name: 'ไทย' },
      { code: 'vi', name: 'Tiếng Việt' },
      { code: 'id', name: 'Bahasa Indonesia' },
      { code: 'it', name: 'Italiano' }
    ]
  });
});

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  handler: rateLimitJson('登入嘗試次數過多，請 15 分鐘後再試'),
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '請輸入帳號與密碼' });
  }
  const admin = db.prepare('SELECT id, username, password_hash FROM admins WHERE username = ?').get(username);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }
  const token = jwt.sign({ sub: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  res.json({ token, username: admin.username });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ username: req.admin.username, id: req.admin.id });
});

// ---------------------------------------------------------------------------
// Admin management (protected)
// ---------------------------------------------------------------------------
app.get('/api/admins', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, username, created_at FROM admins ORDER BY id ASC').all();
  res.json({ admins: rows });
});

app.post('/api/admins', requireAuth, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '請輸入帳號與密碼' });
  }
  if (username.length < 3 || username.length > 32) {
    return res.status(400).json({ error: '帳號長度需介於 3 到 32 字元' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密碼至少 6 個字元' });
  }
  try {
    const info = db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')
      .run(username, hashPassword(password));
    res.json({ id: info.lastInsertRowid, username });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: '帳號已存在' });
    }
    console.error('Create admin error:', err);
    res.status(500).json({ error: '新增管理員失敗' });
  }
});

app.delete('/api/admins/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: '無效的管理員 ID' });
  const total = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  if (total <= 1) return res.status(400).json({ error: '無法刪除最後一位管理員' });
  if (id === req.admin.id) return res.status(400).json({ error: '無法刪除自己的帳號，請改由其他管理員操作' });
  const info = db.prepare('DELETE FROM admins WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: '找不到該管理員' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Settings endpoints (protected — admin can toggle active translation model)
// ---------------------------------------------------------------------------
app.get('/api/settings', requireAuth, (req, res) => {
  const active_model = getActiveModel();
  const gemini_configured = Boolean(process.env.GEMINI_API_KEY);
  res.json({ active_model, gemini_configured, available_models: Array.from(VALID_MODELS) });
});

app.put('/api/settings', requireAuth, (req, res) => {
  const { active_model } = req.body || {};
  if (!VALID_MODELS.has(active_model)) {
    return res.status(400).json({ error: `無效的翻譯引擎，可選: ${Array.from(VALID_MODELS).join(', ')}` });
  }
  if (active_model === 'premium' && !process.env.GEMINI_API_KEY) {
    return res.status(400).json({ error: '高品質模式未設定 GEMINI_API_KEY，無法啟用' });
  }
  upsertSetting.run('active_model', active_model);
  console.log(`⚙️  翻譯引擎切換為: ${active_model}（by ${req.admin.username}）`);
  res.json({ active_model });
});

// ---------------------------------------------------------------------------
// Usage tracking endpoints (protected)
// ---------------------------------------------------------------------------

// GET /api/usage/summary -- current month totals with free-tier adjustment
// Free tier (500K chars/month, $0/char) only applies to the basic engine.
// Premium (Gemini) is billed from the first character.
app.get('/api/usage/summary', requireAuth, (req, res) => {
  try {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthPrefix = month + '%';

    const perModel = db.prepare(`
      SELECT
        COALESCE(model_used, 'basic')         AS model,
        COALESCE(SUM(char_count), 0)          AS chars,
        COALESCE(SUM(estimated_cost_usd), 0)  AS cost,
        COUNT(*)                                AS requests
      FROM translations
      WHERE timestamp LIKE @monthPrefix
      GROUP BY COALESCE(model_used, 'basic')
    `).all({ monthPrefix });

    const by_model = { basic: { chars: 0, cost: 0, requests: 0 }, premium: { chars: 0, cost: 0, requests: 0 } };
    for (const r of perModel) {
      const key = by_model[r.model] ? r.model : 'basic';
      by_model[key].chars    += r.chars;
      by_model[key].cost     += r.cost;
      by_model[key].requests += r.requests;
    }

    const totalChars     = by_model.basic.chars + by_model.premium.chars;
    const totalCostEst   = by_model.basic.cost  + by_model.premium.cost;
    const totalRequests  = by_model.basic.requests + by_model.premium.requests;

    const freeTierLimit  = 500000; // applies only to basic
    const basicChars     = by_model.basic.chars;
    const freeRemaining  = Math.max(0, freeTierLimit - basicChars);
    const basicActualCost = basicChars <= freeTierLimit
      ? 0
      : (basicChars - freeTierLimit) * MODEL_COSTS.basic;
    const actualCost     = basicActualCost + by_model.premium.cost;

    res.json({
      total_chars: totalChars,
      total_cost_estimated: totalCostEst,
      actual_cost: actualCost,
      total_requests: totalRequests,
      free_remaining: freeRemaining,
      free_tier_limit: freeTierLimit,
      by_model,
      month,
    });
  } catch (error) {
    console.error('Usage summary error:', error);
    res.status(500).json({ error: 'Failed to retrieve usage summary' });
  }
});

// GET /api/usage/history?from=YYYY-MM-DD&to=YYYY-MM-DD -- daily breakdown
app.get('/api/usage/history', requireAuth, (req, res) => {
  try {
    const now = new Date();
    const defaultFrom = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const defaultTo = now.toISOString().slice(0, 10);

    const from = req.query.from || defaultFrom;
    const to = req.query.to || defaultTo;

    const daily = db.prepare(`
      SELECT
        substr(timestamp, 1, 10)              AS date,
        SUM(char_count)                        AS total_chars,
        SUM(estimated_cost_usd)                AS total_cost,
        COUNT(*)                                AS request_count
      FROM translations
      WHERE substr(timestamp, 1, 10) >= @from
        AND substr(timestamp, 1, 10) <= @to
      GROUP BY substr(timestamp, 1, 10)
      ORDER BY date ASC
    `).all({ from, to });

    res.json({ from, to, daily });
  } catch (error) {
    console.error('Usage history error:', error);
    res.status(500).json({ error: 'Failed to retrieve usage history' });
  }
});

// GET /api/usage/recent -- last 50 translation records
app.get('/api/usage/recent', requireAuth, (req, res) => {
  try {
    const records = db.prepare(`
      SELECT id, timestamp, source_lang, target_lang, char_count, estimated_cost_usd,
             COALESCE(model_used, 'basic') AS model_used
      FROM translations
      ORDER BY timestamp DESC
      LIMIT 50
    `).all();

    res.json({ records });
  } catch (error) {
    console.error('Usage recent error:', error);
    res.status(500).json({ error: 'Failed to retrieve recent records' });
  }
});

// ---------------------------------------------------------------------------
// Static files & SPA fallback
// ---------------------------------------------------------------------------

// Serve static frontend files in production
const publicPath = path.join(__dirname, '..', 'dist');
app.use(express.static(publicPath));

// SPA fallback - serve index.html for non-API routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: '找不到請求的資源', path: req.path });
  }
  res.sendFile(path.join(publicPath, 'index.html'));
});

// Error handling
app.use((err, req, res, next) => {
  console.error('伺服器錯誤:', err);
  res.status(500).json({
    error: '伺服器內部錯誤',
    message: process.env.NODE_ENV === 'development' ? err.message : '請稍後再試'
  });
});

app.listen(PORT, () => {
  console.log(`🚀 後端伺服器運行在 http://localhost:${PORT}`);
  console.log(`📝 環境: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔑 Google API Key: ${process.env.GOOGLE_TRANSLATE_API_KEY ? '已設定' : '未設定'}`);
  console.log(`🔑 Gemini API Key: ${process.env.GEMINI_API_KEY ? '已設定' : '未設定（premium 模式不可用）'}`);
  console.log(`⚙️  目前翻譯引擎: ${getActiveModel()}`);
  console.log(`📊 Usage DB: ${path.join(dataDir, 'usage.db')}`);
});

// Flush the WAL into the main .db file every 5 minutes so an ungraceful kill
// (SIGKILL skips the graceful db.close() below) loses at most a few minutes of
// usage/billing records instead of everything since the last checkpoint.
const walCheckpointTimer = setInterval(() => {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); }
  catch (err) { console.error('WAL checkpoint 失敗:', err); }
}, 5 * 60 * 1000);
walCheckpointTimer.unref();

function shutdown(signal) {
  console.log(`${signal} received`);
  clearInterval(walCheckpointTimer);
  db.close(); // checkpoints and truncates the WAL as the last connection closes
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
