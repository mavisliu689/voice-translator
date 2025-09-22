# 階段 1: 建構階段
FROM node:20-alpine AS builder

# 設定工作目錄
WORKDIR /app

# 複製 package.json 和 package-lock.json
COPY package*.json ./

# 安裝依賴
RUN npm ci

# 複製源代碼
COPY . .

# 建構應用程式
RUN npm run build

# 階段 2: 生產階段
FROM nginx:alpine

# 從建構階段複製建構好的檔案
COPY --from=builder /app/dist /usr/share/nginx/html

# 複製自定義 nginx 配置（用於 SPA 路由）
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 暴露端口
EXPOSE 80

# 健康檢查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost || exit 1

# 啟動 nginx
CMD ["nginx", "-g", "daemon off;"]