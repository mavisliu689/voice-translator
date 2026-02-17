import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline scripts for embedded mode
  crossOriginEmbedderPolicy: false,
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
      res.json({
        success: true,
        translation: translation.translatedText,
        detectedSourceLanguage: translation.detectedSourceLanguage || source,
        source: source || translation.detectedSourceLanguage,
        target: targetLanguage,
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
});

process.on('SIGTERM', () => { console.log('SIGTERM received'); process.exit(0); });
process.on('SIGINT', () => { console.log('SIGINT received'); process.exit(0); });
