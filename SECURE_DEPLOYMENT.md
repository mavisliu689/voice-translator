# 🔒 安全部署指南

## 為什麼 dev 版本不安全？

將 API Key 直接嵌入前端應用程式會暴露在：
- 瀏覽器開發者工具
- JavaScript 原始碼
- 網路請求中

## 推薦的安全架構

### 方案 1：使用環境變數 + 後端代理（推薦）

```javascript
// 後端 API 伺服器 (Node.js/Express 範例)
const express = require('express');
const app = express();

app.post('/api/translate', async (req, res) => {
  const { text, source, target } = req.body;
  
  // API Key 保存在後端環境變數
  const API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY;
  
  try {
    const response = await fetch(
      `https://translation.googleapis.com/language/translate/v2?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, source, target })
      }
    );
    
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Translation failed' });
  }
});
```

### 方案 2：使用 Vercel/Netlify Functions

```javascript
// api/translate.js (Vercel 函數)
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text, source, target } = req.body;
  const API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY;

  // 翻譯邏輯...
}
```

### 方案 3：使用 Firebase Functions

```javascript
// Firebase Cloud Function
const functions = require('firebase-functions');

exports.translate = functions.https.onRequest(async (req, res) => {
  // API Key 從 Firebase 設定讀取
  const apiKey = functions.config().google.translate_key;
  
  // 處理翻譯請求...
});
```

## Google Cloud API Key 安全設定

### 1. 限制 API Key 使用範圍

在 Google Cloud Console 中：

```bash
# 僅允許特定 API
- APIs & Services > Credentials
- 選擇你的 API Key
- API restrictions > Restrict key
- 僅選擇 Cloud Translation API

# 設定應用程式限制
- Application restrictions
- HTTP referrers (網站)
- 添加允許的網域：
  - https://yourdomain.com/*
  - http://localhost:*/* (開發用)
```

### 2. 設定配額限制

```bash
# 防止異常使用
- APIs & Services > Cloud Translation API
- Quotas & System Limits
- 設定每日請求上限（如 10,000 次）
- 設定每分鐘請求上限（如 100 次）
```

### 3. 監控和警報

```bash
# 設定預算警報
- Billing > Budgets & alerts
- Create budget
- 設定月度預算（如 $10）
- 設定警報閾值（50%, 90%, 100%）
```

## 緊急應變措施

如果懷疑 API Key 被盜用：

### 立即行動：
1. **停用現有 Key**
   ```bash
   gcloud services api-keys delete KEY_ID
   ```

2. **生成新 Key**
   ```bash
   gcloud services api-keys create --display-name="new-key"
   ```

3. **檢查使用記錄**
   - Cloud Console > APIs & Services > Metrics
   - 查看異常流量來源

4. **啟用更嚴格限制**
   - IP 白名單
   - 降低配額
   - 暫時停用 API

## 開發環境安全建議

### 本地開發：
```bash
# 使用 .env.local（不要提交到 Git）
VITE_GOOGLE_TRANSLATE_API_KEY=your-dev-key-here

# .gitignore 確保包含
.env.local
.env*.local
```

### Docker 開發：
```bash
# 使用 Docker secrets（不要用 build-args）
docker run -e GOOGLE_API_KEY=$GOOGLE_API_KEY voice-translator

# 或使用 docker-compose
version: '3.8'
services:
  app:
    environment:
      - GOOGLE_API_KEY=${GOOGLE_API_KEY}
```

## 檢查清單

在部署前確認：

- [ ] API Key 未硬編碼在程式碼中
- [ ] 使用後端代理處理 API 請求
- [ ] API Key 有適當的使用限制
- [ ] 設定了預算警報
- [ ] 有監控異常使用的機制
- [ ] 準備了緊急應變計劃
- [ ] .env 檔案已加入 .gitignore
- [ ] Docker 映像不包含 API Key

## 結論

**永遠不要在生產環境中將 API Key 放在前端！**

使用後端代理是最安全且最專業的做法。這不僅保護你的 API Key，也讓你能夠：
- 添加速率限制
- 實施快取機制
- 記錄使用情況
- 添加用戶認證
- 過濾惡意請求