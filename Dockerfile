FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
# 版本号写进 dist/VERSION，由后端读取（见 server/src/api.ts）
ARG VERSION=dev
RUN printf '%s' "$VERSION" > dist/VERSION

# mihomo 内核：用于真实延迟测试与解锁检测
FROM node:22-alpine AS core
ARG TARGETARCH
ARG MIHOMO_VERSION=v1.19.32
COPY scripts/fetch-mihomo.mjs /fetch-mihomo.mjs
RUN node /fetch-mihomo.mjs "$MIHOMO_VERSION" /mihomo

FROM node:22-alpine
ARG VERSION=dev
WORKDIR /app
ENV KNOT_VERSION=$VERSION \
    NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=core /mihomo /usr/local/bin/mihomo
COPY --from=build /app/dist ./dist
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
# 限制 V8 堆大小：默认 GC 较“懒”，节点多时占用会涨到 200MB 左右，限制后约 100MB 且速度不变
CMD ["node", "--max-old-space-size=128", "--max-semi-space-size=2", "dist/server.js"]
