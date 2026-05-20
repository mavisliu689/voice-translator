# CLAUDE.md

本文件提供 Claude Code（claude.ai/code）在此 repository 工作時的指引。

## 專案概述

**AI 即時語音翻譯工具** — 一個使用 Google Cloud Translation API 的語音/文字翻譯 Web 應用，採用「前端 + 後端代理」架構，避免 API Key 暴露於瀏覽器端。已具備 iframe 嵌入模式（`?mode=embed`）以供合作網站（如 tissa.tw、cisanet.org.tw）嵌入使用。

## 技術架構

### 前端（`/src`）
- **框架**：React 19 + TypeScript + Vite 7
- **樣式**：Tailwind CSS 3（含 PostCSS / Autoprefixer）
- **圖示**：`lucide-react`
- **核心檔案**：`src/App.tsx`（整個翻譯器 UI 與邏輯，~50KB 單檔元件）
- **瀏覽器 API**：Web Speech API（`SpeechRecognition`、`speechSynthesis`）
- **入口**：`src/main.tsx` → `App.tsx` 中的 `VoiceTranslator`

### 後端（`/server`）
- **執行環境**：Node.js 22（ESM，`"type": "module"`）
- **框架**：Express 4
- **資料庫**：`better-sqlite3`（存放於 `server/data/usage.db`，WAL 模式；**已 gitignore，不入版控**）
- **安全/中介**：`helmet`、`cors`、`express-rate-limit`、`morgan`
- **認證**：`bcryptjs` + `jsonwebtoken`（JWT Bearer Token，12h 過期）
- **主檔**：`server/index.js`
- **公開 API**：
  - `POST /api/translate` — 翻譯（支援 source 留空自動偵測；驗證語言 code 白名單）
  - `GET  /api/languages` — 支援語言列表
  - `GET  /health` — 健康檢查
- **認證 API**：
  - `POST /api/auth/login` — 帳號密碼登入，回傳 JWT（rate limit: 10 次/15 分）
  - `GET  /api/auth/me` — 取得當前管理員資訊（需 Bearer Token）
- **管理員 API（需 auth）**：
  - `GET    /api/admins`、`POST /api/admins`、`DELETE /api/admins/:id`
- **用量追蹤 API（需 auth）**：
  - `GET /api/usage/summary` — 當月總計（含免費額度計算）
  - `GET /api/usage/history?from=&to=` — 每日用量
  - `GET /api/usage/recent` — 最近 50 筆

### 部署
- **單一映像檔**：`Dockerfile`（多階段建置）將前端建置產物放入 `dist/`，由 Node server 同時提供靜態前端與 API（port `5876`）。
- **Compose**：`docker-compose.yml`（基本服務）、`docker-compose.full.yml`（含完整設定）。
- **建置腳本**：`docker-build.sh`、`setup.sh`。

## 常用指令

### 本機開發（前端 + 後端分離）
```bash
# 後端（terminal 1）
cd server && npm install && npm run dev   # 監聽 :3001（node --watch）

# 前端（terminal 2）
npm install && npm run dev                # 監聽 :5173，已透過 vite.config.ts proxy /api 與 /health 至 :3001
```

### 建置與檢查
```bash
npm run build         # tsc -b && vite build → 輸出 dist/
npm run lint          # ESLint（eslint.config.js，含 typescript-eslint + react hooks/refresh）
npm run format        # Prettier --write 全專案
npm run format:check  # Prettier 檢查（CI 用）
npm test              # Vitest run（前端，jsdom）
npm run test:watch
npm run preview       # vite preview

# 後端測試（Node env，pool=forks 避開 better-sqlite3 native module 段錯誤）
cd server && npm test
```

### Docker
```bash
docker compose up -d --build              # 使用根目錄 docker-compose.yml，曝露 :5876
docker compose -f docker-compose.full.yml up -d
./docker-build.sh                         # 包裝過的建置流程
```

> 測試覆蓋率仍低（僅 `src/lib/languages.test.ts` 與 `server/index.test.js` 的 smoke）。新測試請放在 `src/**/*.test.ts(x)` 或 `server/*.test.js`。

## 環境變數

### 根目錄 `.env`（被 `.gitignore` 忽略）
```
VITE_BACKEND_URL=http://localhost:3001       # 前端呼叫後端的 URL（生產環境若同源可留空字串）
GOOGLE_TRANSLATE_API_KEY=...                 # 由 Docker compose 注入到 container（後端使用）
```
- 前端**不應**再使用 `VITE_GOOGLE_TRANSLATE_API_KEY`（舊版直連模式，已改為走後端代理）。

### `server/.env`（本機後端執行用，範本見 `server/.env.example`）
```
GOOGLE_TRANSLATE_API_KEY=...                 # production 缺失會直接 exit(1)
PORT=3001
NODE_ENV=development
ALLOWED_ORIGINS=*                            # 以逗號分隔；預設 * 允許 iframe 嵌入

# 認證相關（首次啟動會用 ADMIN_USERNAME/PASSWORD 建立初始管理員）
JWT_SECRET=<隨機長字串>                       # production 缺失會直接 exit(1)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<請改成強密碼>
```

> ⚠️ **絕對不要將真實 API Key 寫入版本控制**。`.env` 已在 `.gitignore`，若使用者貼出 key 請提醒輪替。

## 關鍵設計與行為

### 嵌入模式
- 透過 URL `?mode=embed` 切換為精簡介面，供 iframe 嵌入。
- 後端 `helmet` 設定了 `frame-ancestors`（允許 tissa.tw、cisanet.org.tw 等網域），`X-Frame-Options` 已關閉（改用 CSP `frame-ancestors`）。**新增嵌入網域時需同步修改 `server/index.js` 的 helmet 設定。**
- CORS `origin` 預設 `*`，可由 `ALLOWED_ORIGINS` 收緊。`credentials: false`（保留使用 `*` 的能力）。

### 用量追蹤（SQLite）
- 每筆成功翻譯寫入 `translations` table（時間、源/目標語言、字元數、估算成本）。
- 免費額度：每月前 500,000 字元免費；超出後 `$0.00002 / 字元`。
- DB 寫入失敗**不會**中斷翻譯回應（包在 try/catch 內，僅 log）。

### Rate Limiting
- 全域 `/api` 每分鐘 30 次；`/api/translate` 每分鐘 20 次。
- 訊息為繁體中文，調整時請保持語氣一致。

### 語言支援
- 前端 `languages` 陣列（`src/App.tsx`）與後端 `/api/languages` 列表是**兩份各自維護的清單**。新增語言時兩邊都要改。
- `speechLangMap` 將語言 code 對應到 `SpeechRecognition.lang`（如 `en` → `en-US`）。
- 來源語言可設為 `'auto'`（前端傳入時轉為空字串，後端依此走 Google 自動偵測）。

### UI 風格
- 近期 commit 顯示已**統一改為「暖色文藝風格」並移除所有藍/紫色**（commit `7ec32db`）。修改 UI 時請延續此色系，**不要**引入藍紫色。
- 不使用 emoji 於 UI 文案，除非使用者明確要求。

## 撰寫風格與注意事項

- **語言**：使用者溝通與面向使用者文案、commit message、錯誤訊息皆使用**繁體中文**。程式碼註解可使用英文（如 `server/index.js` 既有風格）。
- **單檔元件**：`App.tsx` 為單一大型元件。在重構成多檔案前請先與使用者確認；目前狀態雖大但可控。
- **不要**直接重新引入前端對 Google API 的直連邏輯——這違反專案安全前提。
- **不要**將 `.env` 或 `server/data/usage.db` 提交至 git。
- 修改 helmet / CORS / CSP 時請特別小心，會影響嵌入網站運作。

## 主要文件

- `README.md` — 使用者面向的安裝與功能說明（含舊版前端直連流程，已過時，主流程改走後端）
- `BACKEND_SETUP.md` — 後端設定細節
- `DOCKER_README.md` — Docker 部署說明
- `SECURE_DEPLOYMENT.md` — 安全部署檢查清單

> 若修改的功能與上述任何 .md 衝突，請同步更新該文件。

## Git 慣例

從近期 commit 可看出採用 Conventional Commits（`fix:` / `feat:` 等前綴）：
```
fix: update Content-Security-Policy to include additional frame-ancestors
fix: remove unused langRegion and change docker port to 5876
```
主分支為 `master`。
