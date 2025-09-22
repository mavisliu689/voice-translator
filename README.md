# AI 即時語音翻譯工具

一個支援語音輸入和即時翻譯的網頁應用程式，使用 Google Cloud Translation API 提供高品質的翻譯服務。

## 功能特色

- 🎤 **語音輸入**：支援即時語音識別（繁體中文、英文、日文）
- 🌍 **即時翻譯**：使用 Google Cloud Translation API
- 🔊 **語音朗讀**：可朗讀原文和翻譯結果
- 📱 **響應式設計**：完美適配手機、平板和桌面裝置
- 🔄 **語言切換**：快速交換來源語言和目標語言
- 📋 **複製功能**：一鍵複製翻譯結果

## 技術架構

- React 18
- Vite
- Tailwind CSS
- Google Cloud Translation API
- Web Speech API

## 安裝步驟

### 1. 克隆專案

```bash
git clone [repository-url]
cd voice-translator
```

### 2. 安裝依賴

```bash
npm install
```

### 3. 設定 Google Cloud Translation API

#### 3.1 取得 API Key

1. 前往 [Google Cloud Console](https://console.cloud.google.com)
2. 建立新專案或選擇現有專案
3. 啟用 **Cloud Translation API**：
   - 在側邊欄選擇「APIs & Services」→「Library」
   - 搜尋「Cloud Translation API」
   - 點擊「Enable」啟用 API

4. 建立 API 金鑰：
   - 前往「APIs & Services」→「Credentials」
   - 點擊「Create Credentials」→「API Key」
   - 複製產生的 API Key

5. （建議）限制 API Key 的使用範圍：
   - 點擊剛建立的 API Key
   - 在「API restrictions」中選擇「Restrict key」
   - 選擇「Cloud Translation API」
   - 在「Website restrictions」中加入你的網域

#### 3.2 配置環境變數

1. 複製環境變數範本：

```bash
cp .env.example .env
```

2. 編輯 `.env` 檔案，加入你的 API Key：

```
VITE_GOOGLE_TRANSLATE_API_KEY=你的_API_金鑰
```

### 4. 啟動開發伺服器

```bash
npm run dev
```

應用程式將在 http://localhost:5173 啟動

## 使用說明

1. **語音輸入**：
   - 點擊「開始語音輸入」按鈕
   - 首次使用需允許麥克風權限
   - 開始說話，系統會即時識別並翻譯

2. **文字輸入**：
   - 直接在左側文字框輸入或貼上文字
   - 系統會自動翻譯

3. **語言切換**：
   - 使用上方的下拉選單選擇來源和目標語言
   - 點擊中間的交換按鈕快速切換語言

4. **朗讀功能**：
   - 點擊喇叭圖標可朗讀文字內容

5. **複製結果**：
   - 點擊複製按鈕將翻譯結果複製到剪貼簿

## 支援語言

- 繁體中文 (zh-TW)
- 英文 (en)
- 日文 (ja)

## 瀏覽器支援

- Chrome (推薦)
- Edge
- Safari (macOS/iOS)
- Firefox (部分功能)

## 建置生產版本

```bash
npm run build
```

建置檔案會輸出到 `dist` 資料夾

## 部署注意事項

### 安全性考量

⚠️ **重要**：前端直接使用 API Key 存在安全風險。生產環境建議：

1. **使用後端代理**：
   - 建立後端 API 來處理翻譯請求
   - 將 API Key 保存在後端環境變數中
   - 前端透過後端 API 進行翻譯

2. **限制 API Key**：
   - 在 Google Cloud Console 中限制 API Key 的使用範圍
   - 設定允許的網域/IP
   - 設定配額限制

3. **使用環境變數**：
   - 確保 `.env` 檔案不被提交到版本控制
   - 使用 CI/CD 的環境變數功能

### HTTPS 要求

語音識別功能需要在 HTTPS 環境下運行。本機開發可使用 localhost，但部署時需確保：

- 使用 HTTPS 協議
- 有效的 SSL 證書

## 費用說明

Google Cloud Translation API 採用按使用量計費：

- 每月前 500,000 個字元免費
- 超過後每百萬字元約 $20 USD
- 詳細價格請參考 [官方定價頁面](https://cloud.google.com/translate/pricing)

## 故障排除

### 麥克風權限問題

如果無法使用語音輸入：

1. 檢查瀏覽器是否支援 Web Speech API
2. 確認已允許麥克風權限
3. 檢查是否使用 HTTPS（或 localhost）
4. 嘗試重新整理頁面

### API Key 錯誤

如果翻譯功能無法使用：

1. 確認 `.env` 檔案中的 API Key 正確
2. 檢查 Google Cloud Console 中 API 是否已啟用
3. 確認 API Key 沒有被限制或超過配額
4. 重新啟動開發伺服器

## 授權

MIT License