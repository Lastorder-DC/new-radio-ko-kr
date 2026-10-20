FROM node:24-bookworm-slim
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN apt-get update \
    && apt-get install -y --no-install-recommends util-linux ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# The renderer must always read the hourly local snapshot, never fetch public JSON itself.
ENV VITE_DATA_FROM=""
RUN npm run build && npm prune --omit=dev --no-audit --no-fund
CMD ["npm", "run", "bot"]
