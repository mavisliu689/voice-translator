# Stage 1: Build frontend
FROM node:22-alpine AS frontend-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV VITE_BACKEND_URL=""
RUN npm run build

# Stage 2: Production - Node.js serves both frontend + backend API
FROM node:22-alpine
WORKDIR /app

# Copy server
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

COPY server/ ./server/

# Copy built frontend
COPY --from=frontend-builder /app/dist ./dist

EXPOSE 5876

ENV NODE_ENV=production
ENV PORT=5876

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:5876/health || exit 1

CMD ["node", "server/index.js"]
