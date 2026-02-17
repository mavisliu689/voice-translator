#!/bin/bash

# 語音翻譯器安裝腳本
# 自動設置前後端環境

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}   AI 語音翻譯器 - 安全版本安裝程式${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# 檢查 Node.js
echo -e "${YELLOW}檢查環境...${NC}"
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js 未安裝。請先安裝 Node.js 18 或更高版本。${NC}"
    echo "請訪問 https://nodejs.org 下載安裝"
    exit 1
fi

NODE_VERSION=$(node -v)
echo -e "${GREEN}✓ Node.js 版本: $NODE_VERSION${NC}"

# 檢查 npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}❌ npm 未安裝。${NC}"
    exit 1
fi

NPM_VERSION=$(npm -v)
echo -e "${GREEN}✓ npm 版本: $NPM_VERSION${NC}"
echo ""

# 安裝前端依賴
echo -e "${YELLOW}安裝前端依賴...${NC}"
npm install
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ 前端依賴安裝成功${NC}"
else
    echo -e "${RED}❌ 前端依賴安裝失敗${NC}"
    exit 1
fi
echo ""

# 安裝後端依賴
echo -e "${YELLOW}安裝後端依賴...${NC}"
cd server
npm install
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ 後端依賴安裝成功${NC}"
else
    echo -e "${RED}❌ 後端依賴安裝失敗${NC}"
    exit 1
fi
cd ..
echo ""

# 設定環境變數
echo -e "${YELLOW}設定環境變數...${NC}"

# 前端環境變數
if [ ! -f .env ]; then
    cp .env.example .env
    echo -e "${GREEN}✓ 已創建前端 .env 檔案${NC}"
else
    echo -e "${BLUE}ℹ 前端 .env 檔案已存在${NC}"
fi

# 後端環境變數
if [ ! -f server/.env ]; then
    cp server/.env.example server/.env
    echo -e "${GREEN}✓ 已創建後端 .env 檔案${NC}"
    echo ""
    echo -e "${RED}⚠️  重要提醒：${NC}"
    echo -e "${YELLOW}請編輯 server/.env 檔案，設定你的 Google Translation API Key${NC}"
    echo ""
    echo "步驟："
    echo "1. 開啟 server/.env 檔案"
    echo "2. 將 GOOGLE_TRANSLATE_API_KEY=your_api_key_here"
    echo "   改為 GOOGLE_TRANSLATE_API_KEY=你的實際API_KEY"
    echo ""
else
    echo -e "${BLUE}ℹ 後端 .env 檔案已存在${NC}"
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}        ✓ 安裝完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${BLUE}啟動指令：${NC}"
echo ""
echo "1. 開啟兩個終端視窗"
echo ""
echo "   終端 1 - 啟動後端："
echo -e "   ${YELLOW}cd server && npm run dev${NC}"
echo ""
echo "   終端 2 - 啟動前端："
echo -e "   ${YELLOW}npm run dev${NC}"
echo ""
echo "2. 訪問應用程式："
echo -e "   ${GREEN}http://localhost:5173${NC}"
echo ""
echo -e "${RED}⚠️  記得設定 API Key 在 server/.env${NC}"
echo ""

# 詢問是否要現在啟動
read -p "是否現在啟動服務？(y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}啟動後端服務...${NC}"
    # 在背景啟動後端
    cd server
    npm run dev &
    BACKEND_PID=$!
    cd ..
    
    # 等待後端啟動
    sleep 3
    
    echo -e "${YELLOW}啟動前端服務...${NC}"
    # 啟動前端（前景）
    npm run dev
    
    # 當前端停止時，也停止後端
    kill $BACKEND_PID 2>/dev/null
fi