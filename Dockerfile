FROM node:20-slim

# passive 模式不需要 Chromium，跳過 Puppeteer 下載以加速建置
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

EXPOSE 10000
CMD ["node", "server.js"]
