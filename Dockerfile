FROM oven/bun:1.2.20@sha256:78f46b81b82d767ee8d729411f6f95089a403c21f17c20a5789df00263d7c5b5 AS base
WORKDIR /app

FROM base AS install

RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

FROM base AS build
COPY --from=install /temp/dev/node_modules node_modules
COPY . .
RUN bun run contracts:check && bun run typecheck && bun run build

FROM base AS release

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg util-linux \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=bun:bun --from=install /temp/prod/node_modules node_modules
COPY --chown=bun:bun --from=build /app/dist ./dist
COPY --chown=bun:bun --from=build /app/package.json .

ENV NODE_ENV=production
USER bun
EXPOSE 6701
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:6701/health');process.exit(r.ok?0:1)"]
ENTRYPOINT ["bun", "dist/index.js"]
