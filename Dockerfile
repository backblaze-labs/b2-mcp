# node:22.23.1-bookworm-slim, resolved and reviewed 2026-08-07.
FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS base

WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

FROM base AS dependencies

ENV NODE_ENV=development
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable pnpm \
  && node -e 'const { execFileSync } = require("node:child_process"); const { packageManager } = require("./package.json"); if (!packageManager?.startsWith("pnpm@")) throw new Error("packageManager must pin pnpm"); execFileSync("corepack", ["prepare", packageManager, "--activate"], { stdio: "inherit" });' \
  && pnpm install --frozen-lockfile --ignore-scripts

FROM dependencies AS build

# Stable releases pass their semver as RELEASE_VERSION so the runtime marker is
# stamped into dist; prereleases and untagged builds leave it empty and report
# the `dev` channel. This keeps the image runtime channel in sync with the npm
# tarball without shipping scripts/ into the build stage.
ARG RELEASE_VERSION=""
COPY tsconfig.json tsconfig.typecheck.json ./
COPY src ./src
RUN pnpm run build \
  && RELEASE_VERSION="${RELEASE_VERSION}" node -e "const v=(process.env.RELEASE_VERSION||'').trim(); if(v){ if(!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(v)) throw new Error('RELEASE_VERSION must be a stable semver: '+v); const pkg=require('./package.json'); if(pkg.version!==v) throw new Error('RELEASE_VERSION '+v+' does not match package version '+pkg.version); require('node:fs').writeFileSync('dist/release-version.json', JSON.stringify({name:pkg.name,releaseChannel:'published',version:v},null,2)+'\n'); }" \
  && pnpm prune --prod

# node:22.23.1-bookworm-slim, resolved and reviewed 2026-08-07.
FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV B2_MCP_TRANSPORT=http
ENV PORT=3000

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json README.md CHANGELOG.md SECURITY.md LICENSE ./
# The image keeps operator-facing docs for in-container help/debugging. It does
# not mirror the npm packlist fixtures because they are not read at runtime.
COPY --chown=node:node docs/CLIENTS.md docs/DEPLOY.md docs/TOOL_PROFILES.md docs/tool-profile-contract.json ./docs/

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('node:http').get({host:'127.0.0.1',port:Number(process.env.PORT)||3000,path:'/health'},(res)=>process.exit(res.statusCode===200?0:1)).on('error',()=>process.exit(1))"
ENTRYPOINT ["node", "dist/index.js"]
