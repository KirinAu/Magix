FROM node:20-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ---- runtime ----
FROM node:20-slim

# 安装 ffmpeg 和 Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    chromium \
    ca-certificates \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
  && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY libs ./libs

EXPOSE 8080
ENV PORT=8080

CMD ["node", "dist/index.js"]
