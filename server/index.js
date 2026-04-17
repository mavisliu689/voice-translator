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
  )
`);

// Prepare statements for performance
const insertTranslation = db.prepare(`
  INSERT INTO translations (source_lang, target_lang, char_count, estimated_cost_usd)
  VALUES (@source_lang, @target_lang, @char_count, @estimated_cost_usd)
`);

const app = express();
const PORT = process.env.PORT || 3001;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'frame-ancestors': ["'self'", 'https://www.tissa.tw', 'https://tissa.tw', 'https://www.cisanet.org.tw', 'https://cisanet.org.tw'],
      // Remove default script-src/style-src restrictions for embedded mode
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
app.use(express.json());

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

    if (!text || !target) {
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
// Usage tracking endpoints
// ---------------------------------------------------------------------------

// GET /api/usage/summary -- current month totals with free-tier adjustment
app.get('/api/usage/summary', (req, res) => {
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
app.get('/api/usage/history', (req, res) => {
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
app.get('/api/usage/recent', (req, res) => {
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
