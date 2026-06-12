import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import http from 'http';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { attachLiveTranslate } from './liveTranslate.js';
import { toTraditional } from './zhConvert.js';

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

// Live Translate (Gemini 3.5 Live) — admin kill switch + monthly spend cap.
// Defaults OFF: Live is billed per audio-minute and exposed to public embed
// visitors, so an admin must explicitly enable it in the back office. The cap
// auto-locks Live once this calendar month's Live cost reaches it.
db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('live_translate_enabled', 'false')`).run();
db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('live_cost_cap_usd', '100')`).run();

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

// --- Live Translate availability: manual switch + monthly spend cap ---------
function getLiveCostCap() {
  const v = parseFloat(getSetting.get('live_cost_cap_usd')?.value);
  return Number.isFinite(v) && v >= 0 ? v : 100;
}

const getLiveMonthCostStmt = db.prepare(`
  SELECT COALESCE(SUM(estimated_cost_usd), 0) AS cost
  FROM translations
  WHERE COALESCE(model_used, 'basic') = 'live' AND timestamp LIKE ?
`);
function getLiveMonthCost() {
  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}%`;
  return getLiveMonthCostStmt.get(monthPrefix)?.cost || 0;
}

// Live bridge handle (set once attachLiveTranslate runs at startup). Lets the
// cap check see in-flight cost, and lets settings/shutdown kill active sessions.
let liveHandle = null;
const getInFlightLiveCost = () => (liveHandle ? liveHandle.getInFlightCostUsd() : 0);

// Live is available only when: key present, admin switch on, and this month's
// Live spend (committed + in-flight) is still under the cap. Returns a reason when
// locked so the client can show exactly why (manual off vs. cost cap reached).
// Including in-flight cost is what stops many concurrent sessions from each
// slipping under a cap that only sees already-committed usage.
function getLiveStatus() {
  if (!process.env.GEMINI_API_KEY) return { enabled: false, reason: '高品質翻譯服務未設定' };
  if (getSetting.get('live_translate_enabled')?.value === 'false') {
    return { enabled: false, reason: '高品質翻譯已由管理員關閉' };
  }
  const cap = getLiveCostCap();
  if (cap > 0 && (getLiveMonthCost() + getInFlightLiveCost()) >= cap) {
    return { enabled: false, reason: `已達本月成本上限（$${cap}），高品質翻譯已自動鎖定` };
  }
  return { enabled: true };
}

// Live Translate is billed per audio-minute; log each session as model 'live'.
const insertLiveUsage = db.prepare(`
  INSERT INTO translations (source_lang, target_lang, char_count, estimated_cost_usd, model_used)
  VALUES ('auto', @target, @chars, @costUsd, 'live')
`);

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

// Per-user rate limiting key.
// This service sits behind a Cloudflare Tunnel, so the socket source IP the
// container sees is always the Docker gateway (limits would otherwise be shared
// across ALL users). Cloudflare sets CF-Connecting-IP to the true visitor IP and
// strips any client-supplied copy at its edge, so we key on it (normalised for
// IPv6) to get genuine per-user limits. Falls back to the socket IP for direct/
// local access without the header.
// SECURITY: this is only spoof-proof while :5876 is reachable ONLY via the
// Cloudflare Tunnel. Do not expose :5876 publicly, or a client could send a
// forged CF-Connecting-IP to dodge the limit.
const rateLimitKey = (req) => ipKeyGenerator(req.headers['cf-connecting-ip'] || req.ip || 'unknown');

// We intentionally read CF-Connecting-IP instead of enabling a permissive
// `trust proxy`, so silence the X-Forwarded-For trust-proxy validation warning.
const rateLimitValidate = { xForwardedForHeader: false };

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  keyGenerator: rateLimitKey,
  handler: rateLimitJson('請求過於頻繁，請稍後再試'),
  standardHeaders: true,
  legacyHeaders: false,
  validate: rateLimitValidate,
});

const translationLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  keyGenerator: rateLimitKey,
  handler: rateLimitJson('翻譯請求過於頻繁，請稍候再試'),
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  validate: rateLimitValidate,
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
// Customer-facing prices per char (100× markup over raw provider cost, matching
// the Live engine). Raw: Google v2 ~$0.00002/char, Gemini ~$0.000004/char.
const MODEL_COSTS = {
  basic:   0.00002 * 100,    // $0.002/char  (Google Translate v2, marked up)
  premium: 0.000004 * 100,   // $0.0004/char (Gemini 2.5 Flash, marked up)
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

    // Enforce Traditional Chinese — never surface Simplified for a zh-TW target,
    // even if the upstream engine slips (the app is Traditional-only).
    if (target === 'zh-TW' && result.translation) {
      result.translation = toTraditional(result.translation);
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

// Public Live Translate availability — the embed/translate UI (no auth) needs
// to know whether to offer the "高品質" toggle, and why it's locked if so.
app.get('/api/live/status', (req, res) => {
  const status = getLiveStatus();
  res.json({ available: status.enabled, reason: status.enabled ? null : status.reason });
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
  keyGenerator: rateLimitKey,
  handler: rateLimitJson('登入嘗試次數過多，請 15 分鐘後再試'),
  standardHeaders: true,
  legacyHeaders: false,
  validate: rateLimitValidate,
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
  const liveStatus = getLiveStatus();
  res.json({
    active_model,
    gemini_configured,
    available_models: Array.from(VALID_MODELS),
    // Live Translate (Gemini 3.5 Live) controls
    live_translate_enabled: getSetting.get('live_translate_enabled')?.value !== 'false',
    live_cost_cap_usd: getLiveCostCap(),
    live_month_cost_usd: getLiveMonthCost(),
    live_available: liveStatus.enabled,
    live_locked_reason: liveStatus.enabled ? null : liveStatus.reason,
  });
});

app.put('/api/settings', requireAuth, (req, res) => {
  const body = req.body || {};
  const updates = {};

  // Text translation engine (basic / premium) — unchanged behaviour
  if (body.active_model !== undefined) {
    if (!VALID_MODELS.has(body.active_model)) {
      return res.status(400).json({ error: `無效的翻譯引擎，可選: ${Array.from(VALID_MODELS).join(', ')}` });
    }
    if (body.active_model === 'premium' && !process.env.GEMINI_API_KEY) {
      return res.status(400).json({ error: '高品質模式未設定 GEMINI_API_KEY，無法啟用' });
    }
    upsertSetting.run('active_model', body.active_model);
    updates.active_model = body.active_model;
  }

  // Live Translate manual kill switch
  if (body.live_translate_enabled !== undefined) {
    const val = body.live_translate_enabled ? 'true' : 'false';
    upsertSetting.run('live_translate_enabled', val);
    updates.live_translate_enabled = val === 'true';
  }

  // Live Translate monthly spend cap (USD); 0 disables the cap
  if (body.live_cost_cap_usd !== undefined) {
    const cap = Number(body.live_cost_cap_usd);
    if (!Number.isFinite(cap) || cap < 0) {
      return res.status(400).json({ error: '成本上限需為 0 或正數' });
    }
    upsertSetting.run('live_cost_cap_usd', String(cap));
    updates.live_cost_cap_usd = cap;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: '沒有可更新的設定' });
  }

  // If a Live setting change just locked Live (kill switch off, or cap lowered
  // below current spend), immediately end any in-progress sessions — "後台直接鎖住"
  // must stop billing now, not wait for each session's 10-minute timer.
  if (body.live_translate_enabled !== undefined || body.live_cost_cap_usd !== undefined) {
    const liveStatus = getLiveStatus();
    if (!liveStatus.enabled) liveHandle?.closeAllLiveSessions(liveStatus.reason);
  }

  console.log(`⚙️  設定更新（by ${req.admin.username}）:`, updates);
  res.json(updates);
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

    const by_model = {
      basic:   { chars: 0, cost: 0, requests: 0 },
      premium: { chars: 0, cost: 0, requests: 0 },
      live:    { chars: 0, cost: 0, requests: 0 },
    };
    for (const r of perModel) {
      const key = by_model[r.model] ? r.model : 'basic';
      by_model[key].chars    += r.chars;
      by_model[key].cost     += r.cost;
      by_model[key].requests += r.requests;
    }

    const totalChars     = by_model.basic.chars + by_model.premium.chars + by_model.live.chars;
    const totalCostEst   = by_model.basic.cost  + by_model.premium.cost  + by_model.live.cost;
    const totalRequests  = by_model.basic.requests + by_model.premium.requests + by_model.live.requests;

    const freeTierLimit  = 500000; // applies only to basic
    const basicChars     = by_model.basic.chars;
    const freeRemaining  = Math.max(0, freeTierLimit - basicChars);
    const basicActualCost = basicChars <= freeTierLimit
      ? 0
      : (basicChars - freeTierLimit) * MODEL_COSTS.basic;
    // Premium (Gemini text) and Live (Gemini audio, per-minute) are billed from $0.
    const actualCost     = basicActualCost + by_model.premium.cost + by_model.live.cost;

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

// HTTP server wraps Express so we can also host the Live Translate WebSocket
// on the same port (required for the single-image / Cloudflare-tunnel deploy).
const server = http.createServer(app);

liveHandle = attachLiveTranslate(server, {
  supportedLangs: SUPPORTED_LANGS,
  allowedOrigins,
  getLiveStatus,
  logUsage: ({ target, chars, costUsd }) => {
    try { insertLiveUsage.run({ target, chars, costUsd }); }
    catch (e) { console.error('Live usage insert error:', e); }
  },
});

server.listen(PORT, () => {
  console.log(`🚀 後端伺服器運行在 http://localhost:${PORT}`);
  console.log(`📝 環境: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔑 Google API Key: ${process.env.GOOGLE_TRANSLATE_API_KEY ? '已設定' : '未設定'}`);
  console.log(`🔑 Gemini API Key: ${process.env.GEMINI_API_KEY ? '已設定' : '未設定（premium / Live 模式不可用）'}`);
  console.log(`⚙️  目前翻譯引擎: ${getActiveModel()}`);
  console.log(`🎙️  Live Translate: ${getLiveStatus().enabled ? '可用' : '停用（' + getLiveStatus().reason + '）'}（月上限 $${getLiveCostCap()}）`);
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
  // End in-progress Live sessions first — teardown() bills their elapsed minutes
  // synchronously, so usage lands in the DB before we close it (otherwise every
  // restart silently loses in-flight Live cost and under-counts the cap).
  try { liveHandle?.closeAllLiveSessions('伺服器即將重啟'); } catch (e) { console.error('closeAll error:', e); }
  db.close(); // checkpoints and truncates the WAL as the last connection closes
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
