# Contributing

Thanks for your interest in the Backblaze B2 MCP Server. This document covers how
to set up, test, and submit changes.

By participating you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Development setup

The CI gate runs on Node 22. Develop on Node 22 LTS so local behavior matches
the Phase 1 runtime floor.

```bash
npm ci
npm run build        # clean + tsc → dist/
npm test             # typecheck (pretest) + unit suite, no credentials needed
npm run lint         # eslint src tests
npm run format:check # prettier
```

For the version-pinned conda bootstrap:

```bash
mamba env create -f environment.yml
mamba run -n b2-mcp node --version
mamba run -n b2-mcp npm ci
```

Integration tests need real B2 credentials and are not run in the default suite;
see `README.md` and `CLAUDE.md` for how to run them.

## Pull requests

- Branch off `main`; keep changes focused.
- `npm test`, `npm run lint`, and `npm run format:check` must pass. CI runs all
  three on every PR plus a build.
- Add or update unit tests for any behavior change. New tools need a schema entry
  in `tests/unit/tools-schema.test.ts` and at least one handler test.
- Update `CHANGELOG.md` under the appropriate heading.

## Safety requirements for new tools

This server is built for an untrusted (possibly prompt-injected) caller, so new
tools must respect the existing guardrails:

- **Any irreversible or protection-removing action must be wired to the
  destructive-operation gate** (`src/utils/destructive-gate.ts`): add a detector
  and call `checkDestructive(...)` at the top of the handler, returning
  `toolError` when `!ok`. Add gate coverage to `tests/unit/destructive-gate.test.ts`.
- **Bulk object data must not flow through the server.** Use presigned URLs for
  uploads and downloads; the inline object paths are capped at 1 MiB for small
  control-plane payloads only.
- **Never log credentials, tokens, presigned URLs, or signing secrets**, and
  redact any secret a B2 response echoes back before returning it to the model.

## Dependencies and `npm audit`

Production dependencies ship in `dist/` and are kept free of known
vulnerabilities. Any findings reported by `npm audit` are in the **development
toolchain only** (Jest, Babel, ts-jest, and their transitive deps); they are not
installed at runtime and do not ship in the published package, whose `files`
allowlist is limited to `dist/`, `README.md`, `CHANGELOG.md`, `SECURITY.md`, and
`LICENSE`. Please keep production dependencies audit-clean.

## Reporting security issues

Do not open public issues for security vulnerabilities. Follow the process in
[SECURITY.md](./SECURITY.md).
