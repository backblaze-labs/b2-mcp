#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultPrivacyMarkdownPath = join(root, "PRIVACY.md");
const defaultOutputRoot = join(root, "api-docs");

export const HOSTED_PRIVACY_URL = "https://backblaze-labs.github.io/b2-mcp/privacy/";
export const REPO_BLOB_URL = "https://github.com/backblaze-labs/b2-mcp/blob/main/";

// Supported Markdown subset for PRIVACY.md: blank lines, paragraphs, #/##/###
// headings, top-level "- " bullets with two- or three-space indented
// continuation lines, inline links whose destinations do not contain spaces,
// angle brackets, or parentheses, optional quoted link titles, and inline code
// spans. The generator fails closed on unsupported constructs so the hosted page
// cannot silently drift from the canonical file.

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
  return `${REPO_BLOB_URL}${rawTarget.replace(/^\.\//, "")}`;
}

function supportedLinkPattern() {
  return /\[([^\]\n]+)\]\(([^()<>\s]+)(?:\s+"([^"\n]+)")?\)/g;
}

function withoutSupportedCode(markdown) {
  return markdown.replace(/`[^`\n]+`/g, "");
}

function withoutSupportedInline(markdown) {
  return withoutSupportedCode(markdown).replace(supportedLinkPattern(), "");
}

function unsupported(lineNumber, message) {
  throw new Error(`unsupported Markdown in PRIVACY.md line ${lineNumber}: ${message}`);
}

function assertSupportedInline(markdown, lineNumber) {
  const textWithoutCode = withoutSupportedCode(markdown);

  if (/!\[[^\]\n]*\]\([^)]+\)/.test(textWithoutCode)) {
    unsupported(lineNumber, "images are not supported");
  }

  for (const match of textWithoutCode.matchAll(supportedLinkPattern())) {
    const label = match[1];
    const unsupportedLabelChars = ["`", "*", "_", "~", "<", ">", "[", "]"];
    if (unsupportedLabelChars.some((char) => label.includes(char))) {
      unsupported(lineNumber, "link labels must be plain text");
    }
  }

  const text = withoutSupportedInline(markdown);
  if (/[*_~]/.test(text)) {
    unsupported(lineNumber, "emphasis and strikethrough are not supported");
  }
  if (/[<>]/.test(text)) {
    unsupported(lineNumber, "raw HTML and autolinks are not supported");
  }
  if (/`/.test(text)) {
    unsupported(lineNumber, "only inline code spans are supported");
  }
  if (/\[|\]/.test(text)) {
    unsupported(lineNumber, "only inline [text](url) links are supported");
  }
}

export function assertSupportedMarkdown(markdown) {
  let inList = false;

  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (!trimmed) {
      inList = false;
      continue;
    }

    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      unsupported(lineNumber, "fenced code blocks are not supported");
    }
    if (/^ {0,3}>/.test(line)) {
      unsupported(lineNumber, "block quotes are not supported");
    }
    if (/^ {0,3}\[[^\]\n]+\]:/.test(line)) {
      unsupported(lineNumber, "reference links are not supported");
    }
    if (/^ {0,3}\|/.test(line) || /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(line)) {
      unsupported(lineNumber, "tables are not supported");
    }
    if (/^ {0,3}#{4,6}\s+/.test(line)) {
      unsupported(lineNumber, "only #, ##, and ### headings are supported");
    }
    if (/^(?:\d+[.)]|[*+])\s+/.test(line)) {
      unsupported(lineNumber, "only top-level '- ' unordered lists are supported");
    }
    if (/^\s+(?:[-*+]|\d+[.)])\s+/.test(line)) {
      unsupported(lineNumber, "nested lists are not supported");
    }
    // Reject every CommonMark thematic break (3+ of -, *, or _, optionally
    // space-separated: `---`, `- - -`, `***`, `___`, `_ _ _`) plus setext
    // underlines. Matching only the compact `---` let a spaced `- - -` fall
    // through to the bullet rule and render as `<ul><li>- -</li></ul>`.
    // CommonMark accepts one or more `=` or `-` as a setext underline, so
    // `Title\n=`, `Title\n==`, `Title\n-`, and `Title\n--` must fail closed
    // too; matching only `={3,}` merged those into a paragraph.
    if (
      /^([-*_])(?:[ \t]*\1){2,}$/.test(trimmed) ||
      /^=+$/.test(trimmed) ||
      /^-+$/.test(trimmed)
    ) {
      unsupported(lineNumber, "horizontal rules and alternate headings are not supported");
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      inList = false;
      assertSupportedInline(heading[2], lineNumber);
      continue;
    }

    const bullet = line.match(/^- (.+)$/);
    if (bullet) {
      inList = true;
      assertSupportedInline(bullet[1], lineNumber);
      continue;
    }

    if (/^\s+/.test(line)) {
      if (inList && /^ {2,3}\S/.test(line)) {
        assertSupportedInline(trimmed, lineNumber);
        continue;
      }
      unsupported(lineNumber, "indented blocks are only supported as list continuations");
    }

    inList = false;
    assertSupportedInline(trimmed, lineNumber);
  }
}

export function renderInline(markdown) {
  const inlinePattern = /\[([^\]\n]+)\]\(([^()<>\s]+)(?:\s+"([^"\n]+)")?\)|`([^`\n]+)`/g;
  let output = "";
  let cursor = 0;
  for (const match of markdown.matchAll(inlinePattern)) {
    output += escapeHtml(markdown.slice(cursor, match.index));
    if (match[1] !== undefined && match[2] !== undefined) {
      const href = escapeHtml(linkTarget(match[2].trim()));
      const title = match[3] === undefined ? "" : ` title="${escapeHtml(match[3])}"`;
      output += `<a href="${href}"${title}>${escapeHtml(match[1])}</a>`;
    } else {
      output += `<code>${escapeHtml(match[4])}</code>`;
    }
    cursor = match.index + match[0].length;
  }
  output += escapeHtml(markdown.slice(cursor));
  return output;
}

export function renderMarkdown(markdown) {
  assertSupportedMarkdown(markdown);

  const html = [];
  const paragraph = [];
  let listOpen = false;
  let currentListItem = null;

  function closeParagraph() {
    if (paragraph.length === 0) return;
    html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph.length = 0;
  }

  function closeListItem() {
    if (!currentListItem) return;
    html.push(`<li>${renderInline(currentListItem.join(" "))}</li>`);
    currentListItem = null;
  }

  function closeList() {
    if (!listOpen) return;
    closeListItem();
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
      closeListItem();
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      currentListItem = [bullet[1].trim()];
      continue;
    }

    if (listOpen && currentListItem && /^ {2,3}\S/.test(line)) {
      currentListItem.push(line.trim());
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }

  closeParagraph();
  closeList();
  return html.join("\n");
}

export function pageHtml(markdown) {
  const body = renderMarkdown(markdown);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="canonical" href="${HOSTED_PRIVACY_URL}">
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
        Source: <a href="${REPO_BLOB_URL}PRIVACY.md">PRIVACY.md</a>
      </footer>
    </main>
  </body>
</html>
`;
}

export function writePrivacyPage({
  privacyMarkdownPath = defaultPrivacyMarkdownPath,
  outputRoot = defaultOutputRoot,
  log = console.log,
} = {}) {
  const privacyDir = join(outputRoot, "privacy");
  const markdown = readFileSync(privacyMarkdownPath, "utf8");
  const html = pageHtml(markdown);
  mkdirSync(privacyDir, { recursive: true });
  const indexPath = join(privacyDir, "index.html");
  const legacyPath = join(outputRoot, "privacy.html");
  writeFileSync(indexPath, html);
  writeFileSync(legacyPath, html);
  log(`privacy-page: wrote ${HOSTED_PRIVACY_URL}`);
  return { hostedPrivacyUrl: HOSTED_PRIVACY_URL, files: [indexPath, legacyPath] };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  writePrivacyPage();
}
