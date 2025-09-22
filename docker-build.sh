#!/bin/bash

# Docker 建構和部署腳本
# 使用方式: ./docker-build.sh [選項]

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 預設值
IMAGE_NAME="voice-translator"
IMAGE_TAG="latest"
CONTAINER_NAME="voice-translator-app"
PORT=8080

# 顯示使用說明
show_help() {
    echo "使用方式: ./docker-build.sh [選項]"
    echo ""
    echo "選項:"
    echo "  build       - 建構 Docker 映像"
    echo "  build-dev   - 建構包含 API Key 的開發版映像"
    echo "  run         - 執行容器"
    echo "  stop        - 停止容器"
    echo "  restart     - 重啟容器"
    echo "  logs        - 查看容器日誌"
    echo "  clean       - 清理容器和映像"
    echo "  compose-up  - 使用 docker-compose 啟動"
    echo "  compose-down- 使用 docker-compose 停止"
    echo ""
    echo "範例:"
    echo "  ./docker-build.sh build"
    echo "  ./docker-build.sh build-dev YOUR_API_KEY"
    echo "  ./docker-build.sh run"
}

# 建構映像
build_image() {
    echo -e "${GREEN}正在建構 Docker 映像...${NC}"
    docker build -t ${IMAGE_NAME}:${IMAGE_TAG} .
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ 映像建構成功！${NC}"
        docker images | grep ${IMAGE_NAME}
    else
        echo -e "${RED}✗ 映像建構失敗！${NC}"
        exit 1
    fi
}

# 建構開發版映像（包含 API Key）
build_dev_image() {
    if [ -z "$1" ]; then
        echo -e "${YELLOW}請提供 Google Translation API Key！${NC}"
        echo "使用方式: ./docker-build.sh build-dev YOUR_API_KEY"
        exit 1
    fi
    
    echo -e "${GREEN}正在建構包含 API Key 的開發版映像...${NC}"
    docker build \
        --build-arg VITE_GOOGLE_TRANSLATE_API_KEY="$1" \
        -f Dockerfile.dev \
        -t ${IMAGE_NAME}:dev .
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ 開發版映像建構成功！${NC}"
    else
        echo -e "${RED}✗ 開發版映像建構失敗！${NC}"
        exit 1
    fi
}

# 執行容器
run_container() {
    echo -e "${GREEN}正在啟動容器...${NC}"
    
    # 檢查是否已有同名容器在執行
    if [ "$(docker ps -q -f name=${CONTAINER_NAME})" ]; then
        echo -e "${YELLOW}容器已在執行中！${NC}"
        return
    fi
    
    # 移除已停止的同名容器
    if [ "$(docker ps -aq -f name=${CONTAINER_NAME})" ]; then
        docker rm ${CONTAINER_NAME}
    fi
    
    # 執行容器
    docker run -d \
        --name ${CONTAINER_NAME} \
        -p ${PORT}:80 \
        --restart unless-stopped \
        ${IMAGE_NAME}:${IMAGE_TAG}
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ 容器啟動成功！${NC}"
        echo -e "${GREEN}應用程式現在可以通過 http://localhost:${PORT} 訪問${NC}"
    else
        echo -e "${RED}✗ 容器啟動失敗！${NC}"
        exit 1
    fi
}

# 停止容器
stop_container() {
    echo -e "${YELLOW}正在停止容器...${NC}"
    docker stop ${CONTAINER_NAME}
    echo -e "${GREEN}✓ 容器已停止${NC}"
}

# 重啟容器
restart_container() {
    stop_container
    run_container
}

# 查看日誌
show_logs() {
    docker logs -f ${CONTAINER_NAME}
}

# 清理
clean_up() {
    echo -e "${YELLOW}正在清理容器和映像...${NC}"
    
    # 停止並移除容器
    docker stop ${CONTAINER_NAME} 2>/dev/null
    docker rm ${CONTAINER_NAME} 2>/dev/null
    
    # 移除映像
    docker rmi ${IMAGE_NAME}:${IMAGE_TAG} 2>/dev/null
    docker rmi ${IMAGE_NAME}:dev 2>/dev/null
    
    echo -e "${GREEN}✓ 清理完成${NC}"
}

# 使用 docker-compose 啟動
compose_up() {
    echo -e "${GREEN}使用 docker-compose 啟動服務...${NC}"
    docker-compose up -d
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ 服務啟動成功！${NC}"
        echo -e "${GREEN}應用程式現在可以通過 http://localhost:8080 訪問${NC}"
    else
        echo -e "${RED}✗ 服務啟動失敗！${NC}"
        exit 1
    fi
}

# 使用 docker-compose 停止
compose_down() {
    echo -e "${YELLOW}停止 docker-compose 服務...${NC}"
    docker-compose down
    echo -e "${GREEN}✓ 服務已停止${NC}"
}

# 主程式
case "$1" in
    build)
        build_image
        ;;
    build-dev)
        build_dev_image "$2"
        ;;
    run)
        run_container
        ;;
    stop)
        stop_container
        ;;
    restart)
        restart_container
        ;;
    logs)
        show_logs
        ;;
    clean)
        clean_up
        ;;
    compose-up)
        compose_up
        ;;
    compose-down)
        compose_down
        ;;
    *)
        show_help
        ;;
esac