FROM oven/bun:1.3-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-slim
WORKDIR /app

# The state file is the whole point of the guard surviving a restart. Mount a volume here.
RUN mkdir -p /var/lib/guard && chown bun:bun /var/lib/guard
VOLUME ["/var/lib/guard"]

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

ENV GUARD_PORT=3000 \
    GUARD_STATE=/var/lib/guard/guard.sqlite \
    NODE_ENV=production

USER bun
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.GUARD_PORT ?? 3000) + '/_guard/health'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "run", "src/index.ts"]
