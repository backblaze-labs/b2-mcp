import { readFileSync } from "fs";
import { join } from "path";

const root = join(__dirname, "../..");

describe("container image policy", () => {
  const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
  const dockerignore = readFileSync(join(root, ".dockerignore"), "utf8");
  const nvmrc = readFileSync(join(root, ".nvmrc"), "utf8").trim();

  it("builds a multi-stage production image on the pinned Node runtime", () => {
    expect(dockerfile).toContain(`ARG NODE_VERSION=${nvmrc}`);
    expect(dockerfile).toContain("FROM node:${NODE_VERSION}-bookworm-slim AS base");
    expect(dockerfile).toContain("FROM dependencies AS build");
    expect(dockerfile).toContain("FROM node:${NODE_VERSION}-bookworm-slim AS runtime");
    expect(dockerfile).toContain("pnpm install --frozen-lockfile");
    expect(dockerfile).toContain("pnpm run build");
    expect(dockerfile).toContain("pnpm prune --prod");
    expect(dockerfile).toContain('ENTRYPOINT ["node", "dist/index.js"]');
  });

  it("defaults containers to HTTP while preserving CLI transport selection", () => {
    expect(dockerfile).toContain("ENV B2_MCP_TRANSPORT=http");
    expect(dockerfile).toContain("ENV PORT=3000");
    expect(dockerfile).not.toContain("B2_APPLICATION_KEY=");
    expect(dockerfile).not.toContain("B2_APPLICATION_KEY_ID=");
  });

  it("keeps local artifacts and secrets out of the Docker build context", () => {
    for (const ignored of [
      ".git",
      ".env",
      ".env.local",
      ".env.*.local",
      "node_modules",
      "dist",
      "coverage",
      "reports",
      "docs/internal",
    ]) {
      expect(dockerignore).toContain(ignored);
    }
  });
});
