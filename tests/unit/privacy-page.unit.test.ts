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
      <li>In local stdio mode, credentials are supplied by your MCP client configuration or process environment. Credential custody stays on your machine except when the server sends them to Backblaze B2 to authorize or perform requested B2 operations.</li>
      <li>In HTTP <code>headers</code> mode, credentials arrive in request headers, are consumed by the credential resolver, and are stripped before the request crosses into the MCP SDK handler boundary. The running process may keep them in a cached credential and authorization manager until cache eviction, TTL expiry, or process exit.</li>
      <li>In HTTP <code>server</code> mode, credentials come from the operator-managed server environment or secret store and stay inside the operator's deployment except for outbound calls to Backblaze B2.</li>
      <li>In HTTP <code>principal</code> mode, verified caller identity is mapped to operator-managed B2 credentials, which stay inside the operator's deployment except for outbound calls to Backblaze B2.</li>
      </ul>
      <p>Credentials supplied to authenticate b2-mcp HTTP requests are not written to disk by the HTTP transport. The HTTP transport keeps bounded, TTL-limited in-memory credential managers, B2 authorization state, and capability state for the running process. Raw credential values can therefore remain in process memory after a request until cache eviction, TTL expiry, or process exit, but cache keys and logs use non-secret fingerprints rather than raw credential values. B2 credentials are sent only to Backblaze B2 API endpoints needed to authorize or perform the requested operation. They are never collected, sold, or transmitted to the publisher.</p>
      <p>Generated application-key secrets from <code>b2_create_key</code> are handled separately by the durable secret sink. In local stdio mode on supported POSIX systems, the default sink is <code>file</code>, which writes newly created application-key secrets to <code>~/.b2-mcp/secrets.jsonl</code> unless configured differently — but only when that owner-only ledger can be opened safely. If the default ledger cannot be validated (for example, it is a symlink or its parent directory has unsafe permissions), b2-mcp falls back to <code>off</code> and the credential-producing tools return a compatibility stub instead of writing the secret. In HTTP and serverless deployments, the default sink is <code>off</code> and the tool returns a compatibility stub unless the operator explicitly enables a sink mode. If an operator enables <code>B2_SECRET_SINK=file</code> for HTTP or serverless, b2-mcp writes newly created application-key secrets to the configured operator-controlled JSONL file.</p>
      <p>An operator may instead set <code>B2_SECRET_SINK=inline</code>, which is the least private option: it returns the newly generated secret directly in the tool's MCP response, so the secret enters the model's context and may be retained by your MCP client. Because of that exposure it is never a default and is refused on HTTP or serverless deployments unless the operator also sets <code>B2_ALLOW_INLINE_SECRETS=true</code>. The same <code>file</code>, <code>off</code>, and <code>inline</code> sink behavior governs <code>b2_create_key</code> and the Partner API tool <code>b2_create_group_member</code>. The Partner API tool <code>b2_reserve_trial_create_account</code> is a deliberate exception: because Reserve Trial account creation has no provider-side recovery path if a sink write fails after the account is created, it is available only in explicit <code>inline</code> mode and is unavailable in both <code>file</code> and <code>off</code> modes.</p>
      "
    `);
    expect(list).not.toContain("<p>");
    expect(credentialsSection).toContain(
      "Credential custody stays on your machine except when the server sends them to Backblaze B2",
    );
    expect(credentialsSection).toContain(
      "may keep them in a cached credential and authorization manager until cache eviction, TTL expiry, or process exit.</li>",
    );
    expect(credentialsSection).toContain(
      "Raw credential values can therefore remain in process memory after a request",
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
    ["bold link label", "[**Policy**](https://example.com)"],
    ["HTML link label", "[<b>Policy</b>](https://example.com)"],
    ["parenthesized link target", "[Policy](https://example.com/legal_(terms))"],
    ["angle-delimited link target", "[Policy](<https://example.com/privacy>)"],
    ["indented continuation fence", "- item\n    ```text\n    secret\n    ```"],
    ["indented continuation quote", "- item\n    > quote"],
    ["compact thematic break", "---"],
    ["spaced thematic break", "- - -"],
    ["asterisk thematic break", "* * *"],
    ["underscore thematic break", "___"],
    ["setext heading underline", "==="],
    ["single equals setext underline", "Title\n="],
    ["double equals setext underline", "Title\n=="],
    ["single dash setext underline", "Title\n-"],
    ["double dash setext underline", "Title\n--"],
    ["code span inside a link label", "[Policy `internal`](https://example.com)"],
    ["heading inside a list continuation", "- item\n  ## heading"],
    ["lazy list continuation", "- item\ncontinuation"],
    ["trailing-space hard break", "line one  \nline two"],
    ["backslash hard break", "line one\\\nline two"],
    ["backslash-escaped link", "\\[Policy](https://example.com)"],
    ["HTML entity reference", "Copyright &copy; 2026"],
    ["ATX closing hash sequence", "## Contact ##"],
    ["tab after list marker", "-\titem"],
    ["backslash escape in link destination", "[Policy](docs\\*terms.md)"],
    ["entity reference in link label", "[Policy &copy;](https://example.com)"],
    ["backslash escape in link label", "[Policy\\!](https://example.com)"],
    ["entity reference in link title", '[Policy](https://example.com "legal &copy;")'],
  ])("rejects unsupported Markdown: %s", async (_name, markdown) => {
    const { renderMarkdown } = await privacyPageModule();

    expect(() => renderMarkdown(`# Privacy Policy\n\n${markdown}\n`)).toThrow(
      /unsupported Markdown in PRIVACY\.md line/,
    );
  });

  it("renders supported Markdown links with optional titles", async () => {
    const { renderMarkdown } = await privacyPageModule();

    expect(renderMarkdown('[Policy](https://example.com "legal")')).toBe(
      '<p><a href="https://example.com" title="legal">Policy</a></p>',
    );
    expect(renderMarkdown("[Runbook](docs/DISCOVERABILITY.md)")).toBe(
      '<p><a href="https://github.com/backblaze-labs/b2-mcp/blob/main/docs/DISCOVERABILITY.md">Runbook</a></p>',
    );
  });

  it("renders Markdown-looking content inside inline code spans", async () => {
    const { renderMarkdown } = await privacyPageModule();

    expect(renderMarkdown("`![literal](image.png)` and `[**literal**](https://example.com)`")).toBe(
      "<p><code>![literal](image.png)</code> and <code>[**literal**](https://example.com)</code></p>",
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
    expect(packageJson.scripts["docs:watch"]).toContain("--cleanOutputDir false");
    expect(mcpb.privacy_policies).toEqual([HOSTED_PRIVACY_URL]);
    expect(read("README.md")).toContain(HOSTED_PRIVACY_URL);
    expect(read("docs/references/discoverability.md")).toContain(HOSTED_PRIVACY_URL);
    expect(pageHtml(read("PRIVACY.md"))).toContain(HOSTED_PRIVACY_URL);
  });
});
