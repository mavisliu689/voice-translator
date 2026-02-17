# 🔒 安全後端設置指南

本專案已升級為前後端分離架構，API Key 安全地保存在後端，前端通過後端 API 進行翻譯。

## 🏗️ 架構說明

```
┌─────────────┐     HTTPS      ┌─────────────┐     API Key     ┌──────────────┐
│   瀏覽器     │ ───────────▶ │   後端 API   │ ────────────▶ │ Google Cloud │
│  (前端應用)  │ ◀─────────── │  (Node.js)   │ ◀──────────── │ Translation  │
└─────────────┘   翻譯結果     └─────────────┘    翻譯結果     └──────────────┘
```

## 📦 快速開始

### 1. 安裝後端依賴

```bash
cd server
npm install
```

### 2. 設定環境變數

創建 `server/.env` 檔案：

```bash
cp server/.env.example server/.env
```

編輯 `server/.env` 並設定你的 Google API Key：

```env
# Google Translation API Key (必須)
GOOGLE_TRANSLATE_API_KEY=你的_API_KEY

# 其他配置
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
```

### 3. 啟動服務

#### 開發環境

分別啟動前後端：

```bash
# 終端 1：啟動後端
cd server
npm run dev

# 終端 2：啟動前端
npm run dev
```

#### 生產環境 (Docker)

使用 Docker Compose 一鍵啟動：

```bash
# 設定 API Key
export GOOGLE_TRANSLATE_API_KEY="你的_API_KEY"

# 啟動完整服務
docker-compose -f docker-compose.full.yml up -d
```

## 🔑 Google Cloud 設定

### 1. 啟用 Translation API

1. 前往 [Google Cloud Console](https://console.cloud.google.com)
2. 選擇或創建專案
3. 啟用 Cloud Translation API
4. 創建 API Key

### 2. 保護 API Key

在 Google Cloud Console 中限制 API Key：

- **API 限制**：僅允許 Cloud Translation API
- **IP 限制**：僅允許你的伺服器 IP（生產環境）
- **配額限制**：設定每日使用上限

## 🚀 部署選項

### 選項 1：本地開發

```bash
# 後端
cd server
npm run dev

# 前端
npm run dev
```

訪問：
- 前端：http://localhost:5173
- 後端：http://localhost:3001

### 選項 2：Docker 部署

```bash
# 使用環境變數檔案
echo "GOOGLE_TRANSLATE_API_KEY=你的_API_KEY" > .env

# 啟動服務
docker-compose -f docker-compose.full.yml up -d

# 查看日誌
docker-compose -f docker-compose.full.yml logs -f
```

訪問：http://localhost:8080

### 選項 3：雲端部署

#### Vercel (前端) + Railway (後端)

1. **後端部署到 Railway**：
   ```bash
   # 安裝 Railway CLI
   npm install -g @railway/cli
   
   # 登入並部署
   railway login
   railway init
   railway add
   railway up
   ```

2. **前端部署到 Vercel**：
   ```bash
   # 安裝 Vercel CLI
   npm install -g vercel
   
   # 部署
   vercel
   
   # 設定環境變數
   vercel env add VITE_BACKEND_URL
   ```

#### Heroku 部署

```bash
# 創建 Heroku 應用
heroku create voice-translator-backend

# 設定環境變數
heroku config:set GOOGLE_TRANSLATE_API_KEY="你的_API_KEY"

# 部署
git push heroku main
```

## 🛡️ 安全功能

後端已實施以下安全措施：

- ✅ **API Key 隔離**：Key 只存在後端，前端無法訪問
- ✅ **速率限制**：防止 API 濫用（每分鐘 20 次翻譯請求）
- ✅ **CORS 保護**：只允許指定的前端域名訪問
- ✅ **請求驗證**：檢查必要參數和文字長度限制
- ✅ **錯誤處理**：不暴露敏感的內部錯誤訊息
- ✅ **HTTPS 支援**：生產環境建議使用 SSL

## 📊 監控和日誌

### 查看後端日誌

```bash
# 本地開發
npm run dev

# Docker
docker logs voice-translator-backend -f
```

### 健康檢查

```bash
# 檢查後端狀態
curl http://localhost:3001/health

# 回應範例
{
  "status": "ok",
  "timestamp": "2024-09-24T09:00:00.000Z",
  "service": "voice-translator-backend"
}
```

## 🔧 故障排除

### 問題：前端無法連接後端

1. 確認後端正在運行：
   ```bash
   curl http://localhost:3001/health
   ```

2. 檢查 CORS 設定是否正確

3. 確認前端的 `VITE_BACKEND_URL` 環境變數

### 問題：API Key 錯誤

1. 確認 API Key 已正確設定：
   ```bash
   echo $GOOGLE_TRANSLATE_API_KEY
   ```

2. 檢查 Google Cloud Console：
   - API 是否啟用
   - Key 是否有效
   - 配額是否用完

### 問題：速率限制錯誤

- 預設限制：每分鐘 20 次翻譯請求
- 可在 `server/index.js` 調整限制

## 📈 效能優化

### 1. 添加快取（Redis）

```javascript
// server/cache.js
import redis from 'redis';

const cache = redis.createClient();

export const getCached = async (key) => {
  return await cache.get(key);
};

export const setCached = async (key, value, ttl = 3600) => {
  await cache.setex(key, ttl, value);
};
```

### 2. 添加請求批次處理

```javascript
// 批次翻譯多個文字
app.post('/api/translate/batch', async (req, res) => {
  const { texts, source, target } = req.body;
  // 實作批次翻譯邏輯
});
```

## 📝 API 文檔

### POST /api/translate

翻譯單一文字。

**請求**：
```json
{
  "text": "你好世界",
  "source": "zh-TW",
  "target": "en"
}
```

**回應**：
```json
{
  "success": true,
  "translation": "Hello World",
  "source": "zh-TW",
  "target": "en",
  "timestamp": "2024-09-24T09:00:00.000Z"
}
```

### GET /api/languages

取得支援的語言列表。

**回應**：
```json
{
  "languages": [
    { "code": "zh-TW", "name": "繁體中文" },
    { "code": "en", "name": "English" },
    { "code": "ja", "name": "日本語" }
  ]
}
```

## 🤝 支援

如有問題，請參考：
- [SECURE_DEPLOYMENT.md](./SECURE_DEPLOYMENT.md) - 安全部署指南
- [README.md](./README.md) - 專案總覽
- GitHub Issues - 回報問題