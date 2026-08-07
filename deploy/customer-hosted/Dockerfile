# syntax=docker/dockerfile:1.7

FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS production-deps

WORKDIR /opt/b2-mcp
ENV NODE_ENV=production

COPY package.json deploy/customer-hosted/pnpm-lock.yaml deploy/customer-hosted/pnpm-workspace.yaml ./
RUN corepack enable \
  && pnpm install --prod --frozen-lockfile --ignore-scripts \
  && pnpm store prune

FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

ARG B2_MCP_VERSION

LABEL org.opencontainers.image.title="Backblaze B2 MCP Server"
LABEL org.opencontainers.image.description="Customer-hosted Backblaze B2 MCP reference runtime"
LABEL org.opencontainers.image.source="https://github.com/backblaze-labs/b2-mcp"

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /usr/local/lib/b2-mcp

COPY --from=production-deps --chown=root:root /opt/b2-mcp/node_modules ./node_modules
COPY --chown=root:root package.json ./
COPY --chown=root:root dist ./dist

RUN test -n "$B2_MCP_VERSION" \
  && B2_MCP_VERSION="$B2_MCP_VERSION" node -e 'const pkg = require("./package.json"); if (pkg.version !== process.env.B2_MCP_VERSION) { throw new Error(`package version ${pkg.version} does not match B2_MCP_VERSION ${process.env.B2_MCP_VERSION}`); }' \
  && ln -s /usr/local/lib/b2-mcp/dist/index.js /usr/local/bin/b2-mcp \
  && ln -s /usr/local/lib/b2-mcp/dist/index.js /usr/local/bin/b2-mcp-server \
  && mkdir -p /sandbox /tmp/b2-mcp \
  && chown -R node:node /sandbox /tmp/b2-mcp

COPY --chown=root:root deploy/customer-hosted/container-entrypoint.sh /usr/local/bin/b2-mcp-container-entrypoint
RUN chmod 0555 /usr/local/bin/b2-mcp-container-entrypoint

USER node
WORKDIR /home/node
EXPOSE 3000
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||3000; fetch('http://127.0.0.1:'+p+'/ready').then(async r=>{ if(!r.ok) throw new Error(await r.text()); }).catch(e=>{ console.error(e.message); process.exit(1); })"

ENTRYPOINT ["b2-mcp-container-entrypoint"]
CMD ["--transport", "http"]
