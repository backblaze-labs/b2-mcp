#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const privacyMarkdownPath = join(root, "PRIVACY.md");
const outputRoot = join(root, "api-docs");
const privacyDir = join(outputRoot, "privacy");
const hostedPrivacyUrl = "https://backblaze-labs.github.io/b2-mcp/privacy/";
const repoBlobUrl = "https://github.com/backblaze-labs/b2-mcp/blob/main/";

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function linkTarget(rawTarget) {
  if (/^(?:https?:|mailto:|tel:)/i.test(rawTarget) || rawTarget.startsWith("#")) {
    return rawTarget;
  }
  return `${repoBlobUrl}${rawTarget.replace(/^\.\//, "")}`;
}

function renderInline(markdown) {
  const inlinePattern = /\[([^\]\n]+)\]\(([^)\n]+)\)|`([^`\n]+)`/g;
  let output = "";
  let cursor = 0;
  for (const match of markdown.matchAll(inlinePattern)) {
    output += escapeHtml(markdown.slice(cursor, match.index));
    if (match[1] !== undefined && match[2] !== undefined) {
      const href = escapeHtml(linkTarget(match[2].trim()));
      output += `<a href="${href}">${escapeHtml(match[1])}</a>`;
    } else {
      output += `<code>${escapeHtml(match[3])}</code>`;
    }
    cursor = match.index + match[0].length;
  }
  output += escapeHtml(markdown.slice(cursor));
  return output;
}

function renderMarkdown(markdown) {
  const html = [];
  const paragraph = [];
  let listOpen = false;

  function closeParagraph() {
    if (paragraph.length === 0) return;
    html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph.length = 0;
  }

  function closeList() {
    if (!listOpen) return;
    html.push("</ul>");
    listOpen = false;
  }

  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim()) {
      closeParagraph();
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeParagraph();
      closeList();
      const level = heading[1].length;
      const text = heading[2].trim();
      const id = slugify(text);
      html.push(`<h${level} id="${id}">${renderInline(text)}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^- (.+)$/);
    if (bullet) {
      closeParagraph();
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${renderInline(bullet[1].trim())}</li>`);
      continue;
    }

    paragraph.push(line.trim());
  }

  closeParagraph();
  closeList();
  return html.join("\n");
}

function pageHtml(markdown) {
  const body = renderMarkdown(markdown);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="canonical" href="${hostedPrivacyUrl}">
    <title>Privacy Policy | Backblaze B2 MCP Server</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #f7f8fb;
        --fg: #18212f;
        --muted: #526071;
        --link: #0b62b4;
        --panel: #ffffff;
        --border: #d8dde7;
        --code: #eef2f7;
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #12161d;
          --fg: #eef2f7;
          --muted: #aab5c4;
          --link: #86b9ff;
          --panel: #181f29;
          --border: #303b4b;
          --code: #242d3a;
        }
      }

      body {
        margin: 0;
        background: var(--bg);
        color: var(--fg);
        font: 16px/1.65 system-ui, sans-serif;
      }

      main {
        box-sizing: border-box;
        width: min(860px, calc(100% - 32px));
        margin: 32px auto;
        padding: 40px;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 8px;
      }

      h1,
      h2,
      h3 {
        line-height: 1.25;
        letter-spacing: 0;
      }

      h1 {
        margin: 0 0 16px;
        font-size: 2.1rem;
      }

      h2 {
        margin: 36px 0 12px;
        font-size: 1.35rem;
      }

      h3 {
        margin: 28px 0 10px;
        font-size: 1.1rem;
      }

      p,
      ul {
        margin: 0 0 16px;
      }

      li {
        margin: 6px 0;
      }

      a {
        color: var(--link);
      }

      code {
        padding: 0.12em 0.3em;
        border-radius: 4px;
        background: var(--code);
        font-family: ui-monospace, monospace;
        font-size: 0.92em;
      }

      footer {
        margin-top: 36px;
        color: var(--muted);
        font-size: 0.92rem;
      }

      @media (max-width: 640px) {
        main {
          width: 100%;
          min-height: 100vh;
          margin: 0;
          padding: 24px 18px;
          border-width: 0;
          border-radius: 0;
        }

        h1 {
          font-size: 1.75rem;
        }
      }
    </style>
  </head>
  <body>
    <main>
${body
  .split("\n")
  .map((line) => `      ${line}`)
  .join("\n")}
      <footer>
        Source: <a href="https://github.com/backblaze-labs/b2-mcp/blob/main/PRIVACY.md">PRIVACY.md</a>
      </footer>
    </main>
  </body>
</html>
`;
}

const markdown = readFileSync(privacyMarkdownPath, "utf8");
const html = pageHtml(markdown);
mkdirSync(privacyDir, { recursive: true });
writeFileSync(join(privacyDir, "index.html"), html);
writeFileSync(join(outputRoot, "privacy.html"), html);
console.log(`privacy-page: wrote ${hostedPrivacyUrl}`);
