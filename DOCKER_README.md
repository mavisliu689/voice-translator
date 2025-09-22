# Docker 部署指南

本文檔說明如何使用 Docker 部署 AI 即時語音翻譯工具。

## 📦 檔案說明

- **Dockerfile** - 生產環境映像（不包含 API Key）
- **Dockerfile.dev** - 開發環境映像（可內建 API Key）
- **docker-compose.yml** - Docker Compose 配置
- **nginx.conf** - Nginx 伺服器配置
- **.dockerignore** - Docker 建構時忽略的檔案
- **docker-build.sh** - 自動化建構腳本

## 🚀 快速開始

### 方法 1：使用自動化腳本

```bash
# 建構映像
./docker-build.sh build

# 執行容器
./docker-build.sh run

# 應用程式將在 http://localhost:8080 運行
```

### 方法 2：使用 Docker Compose

```bash
# 啟動服務
docker-compose up -d

# 停止服務
docker-compose down
```

### 方法 3：手動 Docker 命令

```bash
# 建構映像
docker build -t voice-translator:latest .

# 執行容器
docker run -d \
  --name voice-translator \
  -p 8080:80 \
  --restart unless-stopped \
  voice-translator:latest
```

## 🔑 API Key 配置

### 選項 1：建構時嵌入 API Key（開發環境）

```bash
# 使用腳本
./docker-build.sh build-dev YOUR_API_KEY_HERE

# 或手動建構
docker build \
  --build-arg VITE_GOOGLE_TRANSLATE_API_KEY="YOUR_API_KEY_HERE" \
  -f Dockerfile.dev \
  -t voice-translator:dev .
```

### 選項 2：使用後端代理（推薦用於生產環境）

建議建立一個後端服務來處理 API 請求，避免在前端暴露 API Key。

## 📝 腳本命令

```bash
# 查看所有可用命令
./docker-build.sh

# 建構映像
./docker-build.sh build

# 建構開發版（包含 API Key）
./docker-build.sh build-dev YOUR_API_KEY

# 執行容器
./docker-build.sh run

# 停止容器
./docker-build.sh stop

# 重啟容器
./docker-build.sh restart

# 查看日誌
./docker-build.sh logs

# 清理容器和映像
./docker-build.sh clean

# 使用 docker-compose 啟動
./docker-build.sh compose-up

# 使用 docker-compose 停止
./docker-build.sh compose-down
```

## 🔧 自定義配置

### 修改端口

編輯 `docker-compose.yml`：

```yaml
services:
  voice-translator:
    ports:
      - "3000:80"  # 改為你想要的端口
```

或在手動執行時：

```bash
docker run -d -p 3000:80 voice-translator:latest
```

### 修改 Nginx 配置

編輯 `nginx.conf` 檔案以自定義伺服器行為：
- 快取設定
- 安全標頭
- 代理設定
- 壓縮選項

## 🏭 生產環境部署

### 1. 使用環境變數

建立 `.env` 檔案：

```env
GOOGLE_TRANSLATE_API_KEY=your_api_key_here
PORT=8080
```

### 2. 使用 Docker Secrets（Docker Swarm）

```bash
echo "YOUR_API_KEY" | docker secret create google_api_key -
```

### 3. 使用雲端服務

#### Google Cloud Run

```bash
# 建構並推送到 GCR
gcloud builds submit --tag gcr.io/YOUR_PROJECT/voice-translator

# 部署到 Cloud Run
gcloud run deploy voice-translator \
  --image gcr.io/YOUR_PROJECT/voice-translator \
  --platform managed \
  --allow-unauthenticated
```

#### AWS ECS

```bash
# 推送到 ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin YOUR_ECR_URI
docker tag voice-translator:latest YOUR_ECR_URI/voice-translator:latest
docker push YOUR_ECR_URI/voice-translator:latest
```

#### Azure Container Instances

```bash
# 推送到 ACR
az acr build --registry YOUR_REGISTRY --image voice-translator .
```

## 🔒 安全性建議

1. **不要在前端硬編碼 API Key**
   - 使用環境變數
   - 建立後端代理服務

2. **使用 HTTPS**
   - 在生產環境配置 SSL 證書
   - 使用反向代理（如 Traefik、Nginx）

3. **限制 API Key 使用**
   - 在 Google Cloud Console 限制 API Key
   - 設定允許的網域/IP

4. **定期更新基礎映像**
   ```bash
   docker pull node:20-alpine
   docker pull nginx:alpine
   ```

## 🐛 故障排除

### 容器無法啟動

```bash
# 查看容器日誌
docker logs voice-translator

# 檢查容器狀態
docker ps -a
```

### 應用程式無法訪問

1. 檢查端口是否被占用：
   ```bash
   lsof -i :8080
   ```

2. 檢查防火牆設定

3. 確認容器正在運行：
   ```bash
   docker ps
   ```

### 建構失敗

1. 清理 Docker 快取：
   ```bash
   docker system prune -a
   ```

2. 檢查 Node.js 依賴：
   ```bash
   npm ci
   ```

## 📊 監控和日誌

### 查看容器日誌

```bash
# 即時日誌
docker logs -f voice-translator

# 最近 100 行
docker logs --tail 100 voice-translator
```

### 容器資源使用

```bash
docker stats voice-translator
```

### 健康檢查

```bash
docker inspect --format='{{json .State.Health}}' voice-translator | jq
```

## 🔄 更新部署

```bash
# 1. 拉取最新代碼
git pull

# 2. 重新建構映像
./docker-build.sh build

# 3. 停止舊容器
./docker-build.sh stop

# 4. 啟動新容器
./docker-build.sh run
```

## 📦 備份和恢復

### 導出映像

```bash
docker save voice-translator:latest | gzip > voice-translator.tar.gz
```

### 導入映像

```bash
docker load < voice-translator.tar.gz
```

## 🤝 支援

如有問題，請參考主要的 README.md 或提交 Issue。