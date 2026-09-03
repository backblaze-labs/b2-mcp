import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readJson, root } from "../contract/support";

type PrivacyPageModule = {
  HOSTED_PRIVACY_URL: string;
  pageHtml: (markdown: string) => string;
  renderMarkdown: (markdown: string) => string;
  writePrivacyPage: (options?: {
    log?: (message: string) => void;
    outputRoot?: string;
    privacyMarkdownPath?: string;
  }) => { files: string[]; hostedPrivacyUrl: string };
};

async function privacyPageModule(): Promise<PrivacyPageModule> {
  return (await import("../../scripts/write-privacy-page.mjs")) as unknown as PrivacyPageModule;
}

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

describe("privacy page generator", () => {
  it("renders wrapped credential-mode bullets as complete list items", async () => {
    const { renderMarkdown } = await privacyPageModule();

    const html = renderMarkdown(read("PRIVACY.md"));
    const credentialsSection = html.slice(
      html.indexOf('<h2 id="b2-credentials">'),
      html.indexOf('<h2 id="object-data">'),
    );
    const list = credentialsSection.match(/<ul>[\s\S]*<\/ul>/)?.[0] ?? "";

    expect(credentialsSection).toMatchInlineSnapshot(`
      "<h2 id="b2-credentials">B2 Credentials</h2>
      <p>b2-mcp uses Backblaze B2 application keys and, for Partner API tools only, optional master keys to authenticate to Backblaze B2 on your behalf.</p>
      <ul>
      <li>In local stdio mode, credentials are supplied by your MCP client configuration or process environment and stay on your machine.</li>
      <li>In HTTP <code>headers</code> mode, credentials arrive in request headers, are consumed by the credential resolver, and are stripped before the request crosses into the MCP SDK handler boundary.</li>
      <li>In HTTP <code>server</code> mode, credentials come from the operator-managed server environment or secret store.</li>
      <li>In HTTP <code>principal</code> mode, verified caller identity is mapped to operator-managed B2 credentials.</li>
      </ul>
      <p>Credentials are not persisted by b2-mcp in HTTP mode. The HTTP transport keeps only bounded, TTL-limited in-memory capability and authorization state for the running process, keyed and logged with non-secret fingerprints rather than raw credential values. B2 credentials are sent only to Backblaze B2 API endpoints needed to perform the requested operation. They are never collected, sold, or transmitted to the publisher.</p>
      "
    `);
    expect(list).not.toContain("<p>");
    expect(credentialsSection).toContain(
      "<li>In local stdio mode, credentials are supplied by your MCP client configuration or process environment and stay on your machine.</li>",
    );
    expect(credentialsSection).toContain(
      "and are stripped before the request crosses into the MCP SDK handler boundary.</li>",
    );
    expect(credentialsSection).toContain(
      "verified caller identity is mapped to operator-managed B2 credentials.</li>",
    );
    expect(credentialsSection).not.toContain(
      "<li>In local stdio mode, credentials are supplied by your MCP client configuration</li>",
    );
  });

  it.each([
    ["bold text", "**important**"],
    ["code fence", "```text\nsecret\n```"],
    ["ordered list", "1. first"],
    ["nested list", "- parent\n  - child"],
    ["block quote", "> quote"],
    ["table", "| Field | Value |\n| --- | --- |"],
  ])("rejects unsupported Markdown: %s", async (_name, markdown) => {
    const { renderMarkdown } = await privacyPageModule();

    expect(() => renderMarkdown(`# Privacy Policy\n\n${markdown}\n`)).toThrow(
      /unsupported Markdown in PRIVACY\.md line/,
    );
  });

  it("writes both hosted privacy page paths from the canonical Markdown", async () => {
    const { HOSTED_PRIVACY_URL, pageHtml, writePrivacyPage } = await privacyPageModule();
    const outputRoot = mkdtempSync(join(tmpdir(), "b2-mcp-privacy-page-"));

    try {
      const result = writePrivacyPage({ log: () => undefined, outputRoot });
      const indexHtml = readFileSync(join(outputRoot, "privacy", "index.html"), "utf8");
      const legacyHtml = readFileSync(join(outputRoot, "privacy.html"), "utf8");

      expect(result.hostedPrivacyUrl).toBe(HOSTED_PRIVACY_URL);
      expect(result.files.every((file) => existsSync(file))).toBe(true);
      expect(indexHtml).toBe(pageHtml(read("PRIVACY.md")));
      expect(legacyHtml).toBe(indexHtml);
      expect(indexHtml).toContain(`<link rel="canonical" href="${HOSTED_PRIVACY_URL}">`);
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("keeps the hosted privacy URL contract aligned", async () => {
    const { HOSTED_PRIVACY_URL, pageHtml } = await privacyPageModule();
    const packageJson = readJson<{ scripts: Record<string, string> }>("package.json");
    const mcpb = readJson<{ privacy_policies: string[] }>("mcpb/manifest.json");

    expect(packageJson.scripts["docs:privacy"]).toBe("node scripts/write-privacy-page.mjs");
    expect(packageJson.scripts.docs).toBe("typedoc && pnpm run docs:privacy");
    expect(packageJson.scripts["docs:watch"]).toContain("pnpm run docs:privacy");
    expect(mcpb.privacy_policies).toEqual([HOSTED_PRIVACY_URL]);
    expect(read("README.md")).toContain(HOSTED_PRIVACY_URL);
    expect(read("docs/DISCOVERABILITY.md")).toContain(HOSTED_PRIVACY_URL);
    expect(pageHtml(read("PRIVACY.md"))).toContain(HOSTED_PRIVACY_URL);
  });
});
