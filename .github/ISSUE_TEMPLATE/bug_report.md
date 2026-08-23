---
name: Bug report
about: Report a problem with the B2 MCP server
labels: bug
---

**Describe the bug**

<!-- Clear, concise description. Do NOT include B2 application keys or any credential values. -->

**Steps to reproduce**

1.
2.
3.

**Expected behavior**

**Actual behavior**

<!-- If a tool returned an error, paste the full error line. It looks like:
     B2 Error [NoSuchKey] (HTTP 404): ... (requestId: abc123)
     The code/status and especially the requestId let us (and Backblaze) trace it. -->

**Environment**

- Server version (`/health` endpoint or `package.json`):
- Transport: stdio / HTTP (Streamable)
- Node version:
- OS:
- MCP client (Claude Desktop, Cursor, etc.):

**Logs**

<!-- Relevant `journalctl -u b2-mcp` or stderr output. Redact any credential or token values. -->

```

```
