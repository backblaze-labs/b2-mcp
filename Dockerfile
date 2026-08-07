ARG NODE_VERSION=22.23.1

FROM node:${NODE_VERSION}-bookworm-slim AS base

WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable pnpm \
  && corepack prepare "pnpm@11.20.0+sha256.34e198cb1e43237517ecedfd31f9ae26a6c0a3e5366ce58a2d05f4b21fb5f19a" --activate

FROM base AS dependencies

ENV NODE_ENV=development
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS build

COPY tsconfig.json tsconfig.typecheck.json ./
COPY src ./src
RUN pnpm run build \
  && pnpm prune --prod

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV B2_MCP_TRANSPORT=http
ENV PORT=3000

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json README.md CHANGELOG.md SECURITY.md LICENSE ./
COPY --chown=node:node docs/CLIENTS.md docs/DEPLOY.md docs/TOOL_PROFILES.md docs/tool-profile-contract.json ./docs/

USER node
EXPOSE 3000
ENTRYPOINT ["node", "dist/index.js"]
