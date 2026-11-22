# syntax=docker/dockerfile:1.7
FROM oven/bun:1.3.14 AS manifests
WORKDIR /app

# All workspace manifests are required to resolve the checked-in lock faithfully.
# Never substitute an unfrozen install or --no-verify for a missing/outdated lock.
COPY package.json bun.lock ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/nf-connector/package.json ./packages/nf-connector/package.json

FROM manifests AS production-dependencies
RUN bun install --frozen-lockfile --production --filter @nf-hub/server

FROM manifests AS web-build
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY packages/protocol/src ./packages/protocol/src
# .dockerignore admits this workspace's build inputs, not tests, secrets or dist.
COPY apps/web ./apps/web
RUN bun run --cwd apps/web build

FROM oven/bun:1.3.14 AS runtime
WORKDIR /app

# Fresh named volumes inherit a writable, private directory for the actual bun UID.
# Existing volumes / host bind mounts must be provisioned to the same ownership.
RUN mkdir -p /data \
    && chown bun:bun /data \
    && chmod 0700 /data

COPY package.json ./
# Preserve both hoisted and workspace-local dependency links from Bun's install.
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/apps/server ./apps/server
COPY --from=production-dependencies /app/packages/protocol ./packages/protocol
COPY apps/server/src ./apps/server/src
COPY packages/protocol/src ./packages/protocol/src
COPY --from=web-build /app/apps/web/dist ./apps/web/dist
COPY --chmod=0555 deploy/hub.sh ./deploy/hub.sh

# No NF plugin, test account, full source checkout, compiler cache, or env file.
ENV NODE_ENV=production \
    BIND_HOST=0.0.0.0 \
    PORT=17900 \
    DATABASE_PATH=/data/hub.sqlite

USER bun
EXPOSE 17900
ENTRYPOINT ["/app/deploy/hub.sh"]
CMD ["serve"]
