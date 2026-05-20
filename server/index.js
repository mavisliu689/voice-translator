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
`);

// Prepare statements for performance
const insertTranslation = db.prepare(`
  INSERT INTO translations (source_lang, target_lang, char_count, estimated_cost_usd)
  VALUES (@source_lang, @target_lang, @char_count, @estimated_cost_usd)
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
  'zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'es', 'fr', 'de',
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
      'frame-ancestors': ["'self'", 'https://www.tissa.tw', 'https://tissa.tw', 'https://www.cisanet.org.tw', 'https://cisanet.org.tw'],
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
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: '請求過於頻繁，請稍後再試',
  standardHeaders: true,
  legacyHeaders: false,
});

const translationLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  message: '翻譯請求過於頻繁，請稍後再試',
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

// Translation API - supports auto-detect (source can be empty)
app.post('/api/translate', translationLimiter, async (req, res) => {
  try {
    const { text, source, target } = req.body;

    if (typeof text !== 'string' || !text.trim() || typeof target !== 'string') {
      return res.status(400).json({
        error: '缺少必要參數',
        required: ['text', 'target']
      });
    }

    if (text.length > 5000) {
      return res.status(400).json({
        error: '文字過長，最多支援 5000 個字元'
      });
    }

    if (!SUPPORTED_LANGS.has(target)) {
      return res.status(400).json({ error: `不支援的目標語言: ${target}` });
    }
    if (source && !SUPPORTED_LANGS.has(source)) {
      return res.status(400).json({ error: `不支援的來源語言: ${source}` });
    }

    const API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY;
    if (!API_KEY) {
      console.error('Google Translation API Key 未設定');
      return res.status(500).json({
        error: '翻譯服務暫時不可用，請稍後再試'
      });
    }

    const targetLanguage = target;

    // Build request body - omit source for auto-detect
    const requestBody = {
      q: text,
      target: targetLanguage,
      format: 'text'
    };

    if (source) {
      requestBody.source = source;
    }

    console.log(`翻譯請求: ${source || 'auto'} -> ${targetLanguage}, 文字長度: ${text.length}`);

    const response = await fetch(
      `https://translation.googleapis.com/language/translate/v2?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Google API 錯誤:', errorData);

      if (response.status === 403) {
        return res.status(403).json({ error: 'API 權限錯誤，請聯繫管理員' });
      }
      if (response.status === 429) {
        return res.status(429).json({ error: 'API 請求限制，請稍後再試' });
      }

      throw new Error(errorData.error?.message || '翻譯請求失敗');
    }

    const data = await response.json();

    if (data.data?.translations?.[0]?.translatedText) {
      const translation = data.data.translations[0];
      const char_count = text.length;
      const estimated_cost_usd = char_count * 0.00002;

      // Record usage in SQLite (non-blocking -- errors must not break the response)
      try {
        insertTranslation.run({
          source_lang: source || translation.detectedSourceLanguage,
          target_lang: targetLanguage,
          char_count,
          estimated_cost_usd,
        });
      } catch (dbErr) {
        console.error('DB insert error:', dbErr);
      }

      res.json({
        success: true,
        translation: translation.translatedText,
        detectedSourceLanguage: translation.detectedSourceLanguage || source,
        source: source || translation.detectedSourceLanguage,
        target: targetLanguage,
        char_count,
        estimated_cost_usd,
        timestamp: new Date().toISOString()
      });
    } else {
      throw new Error('無法取得翻譯結果');
    }

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
      { code: 'zh-CN', name: '简体中文' },
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
  message: '登入嘗試次數過多，請 15 分鐘後再試',
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
// Usage tracking endpoints (protected)
// ---------------------------------------------------------------------------

// GET /api/usage/summary -- current month totals with free-tier adjustment
app.get('/api/usage/summary', requireAuth, (req, res) => {
  try {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthPrefix = month + '%';

    const row = db.prepare(`
      SELECT
        COALESCE(SUM(char_count), 0)          AS total_chars,
        COALESCE(SUM(estimated_cost_usd), 0)  AS total_cost_estimated,
        COUNT(*)                                AS total_requests
      FROM translations
      WHERE timestamp LIKE @monthPrefix
    `).get({ monthPrefix });

    const totalChars = row.total_chars;
    const freeTierLimit = 500000;
    const freeRemaining = Math.max(0, freeTierLimit - totalChars);
    const actualCost = totalChars <= freeTierLimit
      ? 0
      : (totalChars - freeTierLimit) * 0.00002;

    res.json({
      total_chars: totalChars,
      total_cost_estimated: row.total_cost_estimated,
      actual_cost: actualCost,
      total_requests: row.total_requests,
      free_remaining: freeRemaining,
      free_tier_limit: freeTierLimit,
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
      SELECT id, timestamp, source_lang, target_lang, char_count, estimated_cost_usd
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
  console.log(`🔑 API Key 狀態: ${process.env.GOOGLE_TRANSLATE_API_KEY ? '已設定' : '未設定'}`);
  console.log(`📊 Usage DB: ${path.join(dataDir, 'usage.db')}`);
});

process.on('SIGTERM', () => { console.log('SIGTERM received'); db.close(); process.exit(0); });
process.on('SIGINT', () => { console.log('SIGINT received'); db.close(); process.exit(0); });
