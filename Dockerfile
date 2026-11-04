# One container serves one person: mount their config.toml and data/ (see compose.yaml).
FROM node:24.21.0-slim

WORKDIR /app
ENV NODE_ENV=production COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# pnpm at the version pinned in package.json's packageManager.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod && rm -rf /root/.cache /root/.local

COPY tsconfig.json ./
COPY src ./src
RUN mkdir -p data && chown node:node data

USER node
STOPSIGNAL SIGTERM
# Node itself, not pnpm or the tsx CLI, so it is pid 1 and gets SIGTERM directly.
CMD ["node", "--import", "tsx", "src/index.ts"]
