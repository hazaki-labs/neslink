FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core ./packages/core
COPY packages/nes-wasm/package.json ./packages/nes-wasm/package.json
COPY packages/relay-auth ./packages/relay-auth
COPY apps/relay ./apps/relay
RUN corepack pnpm install --frozen-lockfile --filter @neslink/relay...
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=8788 RELAY_REPLAY_DB=/app/data/relay-tickets.sqlite
EXPOSE 8788
CMD ["corepack", "pnpm", "--filter", "@neslink/relay", "start"]
