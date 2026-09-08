import fc from "fast-check";
import { compareToCommonMark } from "../support/commonmark-oracle";

// Property-based / fuzz coverage for the bespoke CommonMark validator/renderer
// behind the hosted privacy page (`scripts/write-privacy-page.mjs`). The
// differential oracle (`tests/support/commonmark-oracle.ts`) drives the safety
// property: for ANY input the constrained renderer must either fail closed
// (reject) or produce HTML canonically equal to the reference CommonMark parser.
// A `diverges` outcome — accepted but rendered differently — is the drift bug the
// hosted page must never ship, and includes any path that would emit unescaped
// or unsafe HTML.
//
// Edge cases surfaced while building this suite (issue #399 acceptance): the
// fuzzer found two families of "empty block" constructs the validator silently
// mis-rendered as paragraphs instead of matching CommonMark or failing closed:
//   1. bare list markers with no content — `+`, `*`, `1.`, `2)` — which
//      CommonMark treats as empty list items (`<ul><li></li></ul>` / `<ol>...`);
//      only `-` alone had been caught (by the thematic-break rule).
//   2. bare ATX headings — `#`, `##`, `###`, `####`, `# `, `#\t` — which
//      CommonMark treats as empty headings (`<h1></h1>`); the heading match
//      required content, so hashes-only lines fell through to `<p>#</p>`.
// `scripts/write-privacy-page.mjs` was hardened to fail closed on both, so it
// once again either rejects or matches reference CommonMark for every input.
// Ties into #384 (durable CommonMark parser).

type PrivacyPageModule = { renderMarkdown: (markdown: string) => string };

let renderMarkdown: (markdown: string) => string;
beforeAll(async () => {
  const mod = (await import(
    "../../scripts/write-privacy-page.mjs"
  )) as unknown as PrivacyPageModule;
  renderMarkdown = mod.renderMarkdown;
});

// A palette of Markdown line fragments biased toward the constructs most likely
// to trip a hand-written validator: raw HTML and autolinks, entity references,
// backslash escapes, images, reference/inline links with odd destinations,
// tables, block quotes, fenced code, thematic breaks, setext underlines, ATX
// edge forms, ordered/nested/lazy lists, hard line breaks, and code-span
// boundary spaces.
const markdownFragment = fc.constantFrom(
  "# Heading",
  "## Sub heading",
  "### Small heading",
  "#### Too deep",
  "###### Way too deep",
  "## Closing hashes ##",
  "Plain paragraph text.",
  "- top level bullet",
  "- bullet with [link](https://example.com)",
  "  two-space continuation",
  "   three-space continuation",
  "\ttab continuation",
  "-\ttab after marker",
  "-  double space after marker",
  "  - nested bullet",
  "1. ordered item",
  "2) ordered paren",
  "* star bullet",
  "+ plus bullet",
  "> block quote",
  "```",
  "~~~",
  "    indented code block",
  "| table | cells |",
  "| --- | --- |",
  "[ref]: https://example.com",
  "text with `inline code`",
  "code with ` spaced ` boundary",
  "text **bold** and _em_ and ~strike~",
  "<script>alert(1)</script>",
  "<b>raw html</b>",
  "<https://autolink.example>",
  "a & b plain ampersand",
  "entity &amp; and &#169; and &copy;",
  "back\\slash escape \\[not a link\\]",
  "![image](https://example.com/x.png)",
  "line with trailing break  ",
  "line ending in backslash\\",
  "text with < less and > greater",
  "[label with `code`](https://example.com)",
  "[root path](/root/path)",
  "[scheme](ftp://example.com)",
  "[query only](?search=1)",
  "[anchor](#section)",
  "[relative](docs/page.md)",
  "---",
  "- - -",
  "***",
  "___",
  "===",
  "Setext title",
  "",
);

// Each line is a palette fragment, unconstrained chaos, or a concatenation of
// both, so structured constructs and random bytes are both exercised.
const chaos = fc.string();
const line = fc.oneof(
  markdownFragment,
  chaos,
  fc.tuple(markdownFragment, chaos).map(([fragment, tail]) => `${fragment}${tail}`),
);
const markdownDocument = fc.array(line, { maxLength: 10 }).map((lines) => lines.join("\n"));

// Every `<...>` token the constrained renderer may legitimately emit. Anything
// else in tag position would be unescaped/unsafe HTML leaking from the input.
const ALLOWED_TAG = /^<\/?(?:h[1-3]|p|ul|li|a|code)(?:\s[^<>]*)?>$/;

describe("privacy-page CommonMark validator property suite", () => {
  it("never diverges from reference CommonMark (fail-closed or exact match)", () => {
    fc.assert(
      fc.property(markdownDocument, (markdown) => {
        const comparison = compareToCommonMark(markdown, renderMarkdown);
        expect(comparison.kind).not.toBe("diverges");
      }),
      { numRuns: 4000 },
    );
  });

  it("only ever emits its allow-listed HTML tags for accepted input", () => {
    fc.assert(
      fc.property(markdownDocument, (markdown) => {
        let html: string;
        try {
          html = renderMarkdown(markdown);
        } catch {
          return; // fail-closed rejection is safe
        }
        for (const tag of html.match(/<[^>]*>/g) ?? []) {
          expect(tag).toMatch(ALLOWED_TAG);
        }
      }),
      { numRuns: 1000 },
    );
  });
});
