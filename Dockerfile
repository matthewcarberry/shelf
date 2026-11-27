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

# kepubify turns EPUBs into Kobo kepubs for Kobo sync (github.com/pgaskin/kepubify, MIT).
ARG KEPUBIFY_VERSION=4.0.4
ARG TARGETARCH
RUN set -eu; \
  case "${TARGETARCH:-amd64}" in \
    amd64) asset=kepubify-linux-64bit; sum=37d7628d26c5c906f607f24b36f781f306075e7073a6fe7820a751bb60431fc5 ;; \
    arm64) asset=kepubify-linux-arm64; sum=5a15b8f6f6a96216c69330601bca29638cfee50f7bf48712795cff88ae2d03a3 ;; \
    *) echo "No kepubify build for ${TARGETARCH}"; exit 1 ;; \
  esac; \
  node -e "fetch(process.argv[1]).then(async (r) => { if (!r.ok) throw new Error(r.status); require('fs').writeFileSync('/usr/local/bin/kepubify', Buffer.from(await r.arrayBuffer())); })" \
    "https://github.com/pgaskin/kepubify/releases/download/v${KEPUBIFY_VERSION}/${asset}"; \
  echo "${sum}  /usr/local/bin/kepubify" | sha256sum -c -; \
  chmod 755 /usr/local/bin/kepubify; \
  kepubify --version

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server ./server

EXPOSE 3000
VOLUME ["/library", "/data"]

CMD ["node", "server/index.js"]
