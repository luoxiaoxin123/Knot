FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# mihomo 内核：用于真实延迟测试与解锁检测
FROM node:22-alpine AS core
ARG TARGETARCH
ARG MIHOMO_VERSION=v1.19.32
COPY scripts/fetch-mihomo.mjs /fetch-mihomo.mjs
RUN node /fetch-mihomo.mjs "$MIHOMO_VERSION" /mihomo

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=core /mihomo /usr/local/bin/mihomo
COPY --from=build /app/dist ./dist
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/server.js"]
