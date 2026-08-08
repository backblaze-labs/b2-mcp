# TypeScript 7 Migration Record

Issue: [#114](https://github.com/backblaze-labs/b2-mcp/issues/114)

This record captures the feasibility audit for moving b2-mcp from the
TypeScript 6.0 transition line to the native TypeScript 7 compiler.

## Decision

Adopt Option B: keep the repository pinned to TypeScript 6.0.x until
TypeScript 7.1 is generally available and `typescript-eslint` publishes a
compatible release that supports TypeScript 7 for type-aware linting.

The trigger to proceed is:

- TypeScript 7.1 GA includes the stable programmatic compiler API;
- `typescript-eslint` supports TypeScript 7 in its peer range and type
  information pipeline;
- the repository can run `pnpm install --frozen-lockfile`,
  `pnpm run typecheck`, `pnpm run build`, `pnpm run lint:docs`, and
  `pnpm run test:package` without a TypeScript 6 compatibility package.

Until that trigger is met, do not merge a blanket `typescript@7` upgrade.

## Current State

- `build` uses `tsc` to emit CommonJS JavaScript, declarations, declaration
  maps, and source maps into `dist/`.
- `typecheck` uses `tsc --noEmit -p tsconfig.typecheck.json`.
- `lint:docs` uses ESLint, `typescript-eslint`, and type-aware parser services
  for TSDoc and JSDoc validation.
- `dev` uses `tsx src/index.ts` and no longer depends on `ts-node`.

Vitest and Biome are not blockers for TypeScript 7 because they do not depend
on the TypeScript compiler API for this repository's current gates.

## Feasibility

| Consumer | Status | Migration note |
| --- | --- | --- |
| `build` | Feasible later | Native compiler output must be compared against TypeScript 6 output for CJS, `.d.ts`, `.d.ts.map`, and package exports. |
| `typecheck` | Feasible later | Run on the Node.js 22.3.0, 22.23.1, 24, and 26 evidence paths and review any diagnostic drift. |
| `lint:docs` | Blocked now | It needs the TypeScript programmatic API through `typescript-eslint`, whose current support excludes TypeScript 7. |
| `dev` | Already unblocked | The script uses `tsx`, avoiding `ts-node` and its compiler-API dependency. |

## Staged Path

1. Keep `typescript` on `~6.0.x` and keep the README badge on TypeScript 6.x.
2. Keep `dev` on `tsx` and do not reintroduce `ts-node`.
3. Revisit the compiler migration only after the trigger above is met.
4. For the migration PR, pin an exact TypeScript 7.x version, regenerate the
   lockfile, and run the deterministic gate plus package smoke evidence.
5. Compare `dist/` emitted by TypeScript 6 and TypeScript 7 before trusting the
   new compiler path. Reviewed-equivalent output is acceptable only when the PR
   explains every difference.

## Required Evidence For The Future Migration

- `pnpm install --frozen-lockfile`
- `pnpm run typecheck`
- `pnpm run build`
- `pnpm run lint`
- `pnpm run lint:docs`
- `pnpm run test:contract`
- `pnpm run test:protocol`
- `pnpm run test:package`
- `pnpm run check:package-budget`
- `pnpm run audit:supply-chain`

The migration must not add production dependencies or raise the production
package budget. Any new compatibility package must stay in `devDependencies`
and be removed once the toolchain no longer needs it.
