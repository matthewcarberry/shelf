FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    LIBRARY_DIR=/library \
    ONLINE_DICTIONARY=true \
    AUTH_ENABLED=false \
    TRUST_PROXY=false

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    calibre \
    fonts-dejavu \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server ./server

EXPOSE 3000
VOLUME ["/library", "/data"]

CMD ["node", "server/index.js"]
