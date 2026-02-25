FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY tsconfig.json ./
COPY src ./src
RUN npm install -D typescript ts-node && npx tsc

# ---- runtime ----
FROM node:20-alpine

# 安装 ffmpeg 和 Chromium
RUN apk add --no-cache ffmpeg chromium

ENV CHROME_PATH=/usr/bin/chromium-browser
ENV NODE_ENV=production

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./

EXPOSE 8080
ENV PORT=8080

CMD ["node", "dist/index.js"]
