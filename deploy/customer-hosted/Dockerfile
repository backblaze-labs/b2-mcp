# syntax=docker/dockerfile:1.7

FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

ARG B2_MCP_VERSION

LABEL org.opencontainers.image.title="Backblaze B2 MCP Server"
LABEL org.opencontainers.image.description="Customer-hosted Backblaze B2 MCP reference runtime"
LABEL org.opencontainers.image.source="https://github.com/backblaze-labs/b2-mcp"

ENV NODE_ENV=production
ENV PORT=3000

RUN test -n "$B2_MCP_VERSION" \
  && npm install -g --omit=dev --ignore-scripts "@backblaze-labs/b2-mcp@${B2_MCP_VERSION}" \
  && npm cache clean --force \
  && mkdir -p /sandbox /tmp/b2-mcp \
  && chown -R node:node /sandbox /tmp/b2-mcp

COPY --chown=root:root container-entrypoint.sh /usr/local/bin/b2-mcp-container-entrypoint
RUN chmod 0555 /usr/local/bin/b2-mcp-container-entrypoint

USER node
WORKDIR /home/node
EXPOSE 3000
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||3000; fetch('http://127.0.0.1:'+p+'/ready').then(async r=>{ if(!r.ok) throw new Error(await r.text()); }).catch(e=>{ console.error(e.message); process.exit(1); })"

ENTRYPOINT ["b2-mcp-container-entrypoint"]
CMD ["--transport", "http"]
