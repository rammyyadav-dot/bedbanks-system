# syntax=docker/dockerfile:1.7
# FBEDS API container (ADR 0075). Build context is the repository root:
#   docker build -f apps/api/Dockerfile -t fbeds-api .                                # runtime image (default target)
#   docker build -f apps/api/Dockerfile --target migrator -t fbeds-api:<sha>-migrate .  # one-off owner migration task image
#
# The runtime image runs compiled JavaScript only (`node dist/main.js`): no TypeScript compiler, no runtime transpiler, no prisma CLI, no migrations.
# A type error fails `nest build` in the builder stage, so a broken commit never produces an image. The API reads API_PORT; hosts that inject PORT
# (Render, Railway, Fly.io) are mapped onto it. Migrations and the runtime database roles are owner-run steps: the API image never runs them
# (docs/runbooks/api-deploy.md, docs/runbooks/neon-staging-migrations.md). The `migrator` target carries the prisma CLI and migrations and nothing else.
#
# NODE_IMAGE is the Node 24 (engines.node) Alpine index digest, so every architecture resolves to a reviewed image; Dependabot (docker) bumps it.
ARG NODE_IMAGE=node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
ARG PNPM_VERSION=10.4.1

# ---- Toolchain: Node + the repository's pinned pnpm (packageManager). Alpine ships libssl3, which Prisma's musl engine links against. ----
FROM ${NODE_IMAGE} AS toolchain
ARG PNPM_VERSION
ENV CI=true PNPM_STORE_DIR=/pnpm/store CHECKPOINT_DISABLE=1
RUN npm install --global "pnpm@${PNPM_VERSION}" && npm cache clean --force

# ---- Builder: full install (dev dependencies included), Prisma client, `nest build`. ----
FROM toolchain AS builder
WORKDIR /repo
# Lockfile-only layer: the dependency download is cached until pnpm-lock.yaml changes, not on every source edit.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=fbeds-pnpm-store,target=/pnpm/store \
    pnpm fetch --store-dir "$PNPM_STORE_DIR"
COPY . .
RUN --mount=type=cache,id=fbeds-pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --store-dir "$PNPM_STORE_DIR" --filter "@bedbanks/api..."
# Generated on Alpine, so the bundled query engine is linux-musl-openssl-3.0.x, the one the runtime stage loads.
RUN pnpm --filter @bedbanks/api prisma:generate
# Webpack bundles the @bedbanks/* workspace packages (they export TypeScript source) into dist/main.js; the fork-ts-checker pass fails this step on any
# type error. npm dependencies stay external (apps/api/webpack.config.js).
RUN pnpm --filter @bedbanks/api build \
  && test -s apps/api/dist/main.js \
  && ! grep -q 'require("@bedbanks/' apps/api/dist/main.js

# ---- Runtime dependencies: production install of apps/api only, its own Prisma client, unreachable packages removed. ----
FROM builder AS runtime-deps
RUN --mount=type=cache,id=fbeds-pnpm-store,target=/pnpm/store \
    pnpm --filter @bedbanks/api deploy --prod --legacy --prefer-offline --store-dir "$PNPM_STORE_DIR" /prod/api
WORKDIR /prod/api
RUN /repo/apps/api/node_modules/.bin/prisma generate --schema=prisma/schema.prisma \
  && ls node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client/ | grep -q 'linux-musl-openssl-3.0.x' \
  && node /repo/apps/api/scripts/prune-runtime-deps.cjs /prod/api

# ---- Migration tooling: the prisma CLI (and its engines) only, for the owner-run migration task. ----
FROM builder AS migrator-deps
RUN --mount=type=cache,id=fbeds-pnpm-store,target=/pnpm/store \
    pnpm --filter @bedbanks/api deploy --legacy --prefer-offline --store-dir "$PNPM_STORE_DIR" /prod/migrate
WORKDIR /prod/migrate
# `prisma version` fetches the schema engine now, at build time, so the migration task never downloads a binary from inside the VPC.
RUN node /repo/apps/api/scripts/prune-runtime-deps.cjs /prod/migrate --only prisma \
  && node node_modules/prisma/build/index.js version >/dev/null \
  && ls node_modules/.pnpm/@prisma+engines@*/node_modules/@prisma/engines/ | grep -q '^schema-engine-linux-musl-openssl-3.0.x$'

# ---- Hardened Node base for both shipped images: no package managers, non-root. ----
FROM ${NODE_IMAGE} AS hardened
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production CHECKPOINT_DISABLE=1
WORKDIR /app

# ---- Migrator: `prisma migrate deploy` with the owner DATABASE_URL injected by the one-off task. Never deployed as a service. ----
FROM hardened AS migrator
COPY --from=migrator-deps /prod/migrate/package.json ./package.json
COPY --from=migrator-deps /prod/migrate/node_modules ./node_modules
COPY --from=builder /repo/apps/api/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=builder /repo/apps/api/prisma/migrations ./prisma/migrations
USER node
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy", "--schema=prisma/schema.prisma"]

# ---- Runtime (default target). Files stay root-owned and read-only to the `node` user that runs the process. ----
FROM hardened AS runner
ENV API_HOST=0.0.0.0
COPY --from=runtime-deps /prod/api/package.json ./package.json
COPY --from=runtime-deps /prod/api/node_modules ./node_modules
COPY --from=runtime-deps /prod/api/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=builder /repo/apps/api/dist ./dist
USER node
EXPOSE 3002
STOPSIGNAL SIGTERM
# exec: node is PID 1 and receives SIGTERM directly, so the graceful drain (enableShutdownHooks, beginDraining) runs.
CMD ["sh", "-c", "API_PORT=\"${PORT:-${API_PORT:-3002}}\" exec node dist/main.js"]
