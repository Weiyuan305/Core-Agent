# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/control-plane-api/package.json apps/control-plane-api/package.json
COPY apps/control-plane-worker/package.json apps/control-plane-worker/package.json
COPY apps/runtime-supervisor/package.json apps/runtime-supervisor/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/runtime-core/package.json packages/runtime-core/package.json
RUN npm ci --ignore-scripts

FROM dependencies AS build

COPY tsconfig.base.json ./
COPY apps/control-plane-api/src apps/control-plane-api/src
COPY apps/control-plane-api/tsconfig.json apps/control-plane-api/tsconfig.json
COPY apps/control-plane-worker/src apps/control-plane-worker/src
COPY apps/control-plane-worker/tsconfig.json apps/control-plane-worker/tsconfig.json
COPY apps/runtime-supervisor/src apps/runtime-supervisor/src
COPY apps/runtime-supervisor/tsconfig.json apps/runtime-supervisor/tsconfig.json
COPY packages/contracts/src packages/contracts/src
COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.json
COPY packages/runtime-core/src packages/runtime-core/src
COPY packages/runtime-core/tsconfig.json packages/runtime-core/tsconfig.json
RUN npm run contracts:build \
    && npm run build -w @core-agent/runtime-core \
    && npm run build -w @core-agent/control-plane-api \
    && npm run build -w @core-agent/control-plane-worker \
    && npm run build -w @core-agent/runtime-supervisor \
    && npm prune --omit=dev --ignore-scripts

FROM ${NODE_IMAGE} AS runtime

WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --gid 12000 core-agent-api \
    && useradd --uid 12000 --gid 12000 --no-create-home --shell /usr/sbin/nologin core-agent-api \
    && groupadd --gid 12002 core-agent-runtime \
    && useradd --uid 12001 --gid 12002 --no-create-home --shell /usr/sbin/nologin core-agent-worker \
    && useradd --uid 12002 --gid 12002 --no-create-home --shell /usr/sbin/nologin core-agent-supervisor \
    && install -d -m 0700 -o 12002 -g 12002 /run/core-agent/supervisor \
    && install -d -m 0700 -o 12002 -g 12002 /var/lib/core-agent/supervisor/journal
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/control-plane-api/package.json ./apps/control-plane-api/package.json
COPY --from=build /app/apps/control-plane-api/dist ./apps/control-plane-api/dist
COPY --from=build /app/apps/control-plane-worker/package.json ./apps/control-plane-worker/package.json
COPY --from=build /app/apps/control-plane-worker/dist ./apps/control-plane-worker/dist
COPY --from=build /app/apps/runtime-supervisor/package.json ./apps/runtime-supervisor/package.json
COPY --from=build /app/apps/runtime-supervisor/dist ./apps/runtime-supervisor/dist
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/runtime-core/package.json ./packages/runtime-core/package.json
COPY --from=build /app/packages/runtime-core/dist ./packages/runtime-core/dist
COPY packages/runtime-core/migrations ./packages/runtime-core/migrations
COPY scripts/migrate-runtime.mjs ./scripts/migrate-runtime.mjs
COPY scripts/bootstrap-runtime-database-auth.mjs ./scripts/bootstrap-runtime-database-auth.mjs
COPY scripts/project-runtime-database-credentials.mjs ./scripts/project-runtime-database-credentials.mjs
COPY scripts/converge-runtime-postgres-auth.mjs ./scripts/converge-runtime-postgres-auth.mjs
COPY scripts/api-ingress-proxy.mjs ./scripts/api-ingress-proxy.mjs
COPY scripts/preflight-runtime-docker-socket.mjs ./scripts/preflight-runtime-docker-socket.mjs
COPY scripts/prepare-supervisor-socket-volume.mjs ./scripts/prepare-supervisor-socket-volume.mjs
COPY infra/hermes/base-images.lock.json ./infra/hermes/base-images.lock.json
COPY infra/runtime/providers.dev.json ./infra/runtime/providers.dev.json

FROM runtime AS api
USER 12000:12000
ENTRYPOINT ["node", "apps/control-plane-api/dist/src/server.js"]

FROM runtime AS worker
USER 12001:12002
ENTRYPOINT ["node", "apps/control-plane-worker/dist/src/server.js"]

FROM runtime AS supervisor
USER 12002:12002
ENTRYPOINT ["node", "apps/runtime-supervisor/dist/src/main.js"]
