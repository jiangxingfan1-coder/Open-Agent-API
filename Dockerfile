# syntax=docker/dockerfile:1
#
# Open Agent API gateway image. Build from the repository root:
#   docker build -t open-agent-api .
#   docker run --init -p 127.0.0.1:8787:8787 -v oaa-data:/data open-agent-api
# docker-compose.yml wraps the same thing. See docs/install.md ("Docker") for what this image can and
# cannot run: it has no Codex / Claude Code CLI inside; use built-in agents with your own model key,
# ACP / A2A remote agents, or execution nodes that connect in.
#
# The proprietary @anthropic-ai/claude-agent-sdk is a dev dependency of this project, so the
# production install below never contains it (the Claude native engine then reports
# adapter_unavailable with install instructions, as in the desktop packages).

# ---- build: compile TypeScript (needs the dev dependencies) ----
FROM node:24-slim AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts
# tsconfig.json compiles src, test, examples and bench together, so all four are needed to build.
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY examples ./examples
COPY bench ./bench
RUN npm run build

# ---- deps: production dependencies only ----
# --omit=optional is spelled out: a command-line --omit replaces the omit=optional in .npmrc, and the
# optional packages (a Windows sandbox SDK, node-pty, koffi) are about 170 MB the gateway never loads on Linux.
FROM node:24-slim AS deps
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts \
 && npm cache clean --force \
 && test ! -e node_modules/@anthropic-ai/claude-agent-sdk \
 && test ! -e node_modules/typescript \
 && find node_modules -name '*.map' -type f -delete \
 && rm -rf node_modules/lucide/dist/esm node_modules/lucide/dist/cjs

# ---- runtime ----
FROM node:24-slim AS runtime
LABEL org.opencontainers.image.title="Open Agent API" \
      org.opencontainers.image.description="Publish agents as OpenAI / Claude / Gemini compatible APIs" \
      org.opencontainers.image.source="https://github.com/jiangxingfan1-coder/Open-Agent-API" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    OAA_DATA_DIR=/data/.oaa \
    OAA_HOST=0.0.0.0 \
    OAA_PORT=8787
WORKDIR /app
# package.json carries "type": "module": without it dist/src/*.js is not loaded as ES modules.
COPY package.json LICENSE NOTICE THIRD_PARTY_NOTICES.md ./
COPY licenses ./licenses
COPY --from=deps /src/node_modules ./node_modules
COPY --from=build /src/dist/src ./dist/src
COPY web ./web
COPY examples/sample-agent.mjs examples/sample-agent.json examples/research.agent.json ./examples/
COPY examples/*.oaa ./examples/
COPY scripts/docker-entrypoint.mjs ./docker-entrypoint.mjs
# `oaa` inside the container (docker exec CONTAINER oaa doctor); /data is the working directory,
# so the CLI's default data directory .oaa is the gateway's /data/.oaa.
RUN printf '#!/bin/sh\nexec node /app/dist/src/cli.js "$@"\n' > /usr/local/bin/oaa \
 && chmod 755 /usr/local/bin/oaa \
 && mkdir -p /data \
 && chown node:node /data
USER node
WORKDIR /data
# Declared after the chown above so a new named volume starts out owned by the node user.
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.OAA_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "/app/docker-entrypoint.mjs"]
