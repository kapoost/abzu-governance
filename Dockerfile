# syntax=docker/dockerfile:1.7
# Bun-native abzu-governance agent. Multi-stage: install (cache deps) → run.

FROM oven/bun:1.3.14-alpine AS install
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.14-alpine AS runtime
WORKDIR /app

RUN addgroup -S adcp && adduser -S -G adcp -u 10001 adcp

COPY --from=install --chown=adcp:adcp /app/node_modules ./node_modules
COPY --chown=adcp:adcp package.json bun.lock tsconfig.json ./
COPY --chown=adcp:adcp src ./src

USER adcp

ENV PORT=8080 \
    NODE_ENV=production

EXPOSE 8080

CMD ["bun", "run", "src/index.ts"]
