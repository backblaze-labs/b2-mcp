import { HtmlRenderer, Parser } from "commonmark";

// The constrained privacy-page renderer (`scripts/write-privacy-page.mjs`)
// rewrites relative Markdown link destinations to their canonical repository
// blob URL. The differential oracle normalizes that rewrite away so the
// constrained output can be compared for semantic equivalence against the
// reference CommonMark parser, which leaves relative destinations untouched.
const REPO_BLOB_URL = "https://github.com/backblaze-labs/b2-mcp/blob/main/";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Strip the blob-URL prefix only when it opens an `href` whose remaining value
// is a validated repository-relative file path: the next character is not "/",
// "?", or "#", and the value does not begin with a URI scheme (`ftp:`, ...). A
// legitimate relative rewrite yields `.../blob/main/docs/x`; a mis-rewrite of a
// root/network-path (`.../blob/main//host`), query-only (`.../blob/main/?x`), or
// absolute-scheme (`.../blob/main/ftp://host`) target fails these guards and
// stays visible, so the divergence is not normalized into a false match.
const BLOB_HREF_PREFIX = new RegExp(
  `href="${escapeRegExp(REPO_BLOB_URL)}(?![/?#])(?![a-zA-Z][a-zA-Z0-9+.-]*:)`,
  "g",
);

// Private-use sentinel delimiters wrapping a masked code span's index. Escaped
// HTML output can never contain them, and they are neither whitespace nor
// digits, so the whitespace collapse leaves them intact and the restore step
// cannot collide with numbers in real prose.
const CODE_MASK_OPEN = "\uE000";
const CODE_MASK_CLOSE = "\uE001";

/**
 * Render Markdown with the reference CommonMark implementation. This is the
 * oracle: canonical CommonMark output the constrained renderer is measured
 * against, so completeness is machine-checked instead of hand-maintained.
 */
export function renderReferenceHtml(markdown: string): string {
  const parsed = new Parser().parse(markdown);
  return new HtmlRenderer().render(parsed);
}

/**
 * Reduce rendered HTML to a structural, attribute- and whitespace-insensitive
 * canonical form so the constrained renderer's output can be compared against
 * the reference CommonMark output for equivalence on the supported subset.
 *
 * Only intentional, safe differences are normalized away, and each is scoped to
 * where it legitimately occurs so a genuine divergence is not masked into a
 * false `matches`:
 * - heading anchor `id`s only: the slug is stripped from `<h1>`-`<h6>` opening
 *   tags (the hosted renderer adds them; the reference omits them). An `id` on
 *   any other element survives and forces a mismatch.
 * - the relative-to-`REPO_BLOB_URL` href rewrite only: the blob-URL prefix is
 *   removed solely when it opens an `href="..."` value whose remainder is a
 *   validated repository-relative file path (the hosted renderer rewrites those
 *   to their repository blob URL while the reference keeps them relative). The
 *   blob URL appearing as literal text, or prepended to a root/network-path
 *   (`.../blob/main//host`), query-only (`.../blob/main/?x`), or absolute-scheme
 *   (`.../blob/main/ftp://host`) destination, survives and forces a mismatch.
 * - insignificant whitespace (a softbreak newline vs a joined space,
 *   indentation) OUTSIDE `<code>` spans. Whitespace inside a code span is
 *   significant: CommonMark strips a single boundary space the constrained
 *   renderer keeps, so code-span content is masked before the collapse and
 *   restored verbatim, letting such a divergence surface instead of being
 *   normalized into a match.
 *
 * Anything semantic (a dropped `<br>`, a construct emitted as literal text
 * instead of markup, emphasis, an entity rendered as source, mismatched
 * code-span whitespace) survives and forces a mismatch, which is exactly the
 * drift the oracle must catch.
 */
export function canonicalizeHtml(html: string): string {
  const codeSpans: string[] = [];
  const masked = html.replace(/<code>[\s\S]*?<\/code>/g, (span) => {
    codeSpans.push(span);
    return `${CODE_MASK_OPEN}${codeSpans.length - 1}${CODE_MASK_CLOSE}`;
  });
  return masked
    .replace(/(<h[1-6])\s+id="[^"]*"/g, "$1")
    .replace(BLOB_HREF_PREFIX, 'href="')
    .replace(/>\s+</g, "><")
    .replace(/\s+/g, " ")
    .trim()
    .replace(
      new RegExp(`${CODE_MASK_OPEN}(\\d+)${CODE_MASK_CLOSE}`, "g"),
      (_, index) => codeSpans[Number(index)],
    );
}

/**
 * Outcome of comparing the constrained renderer against reference CommonMark:
 * - `rejected`: the constrained renderer refused the input (fail-closed, safe).
 * - `matches`: the constrained output is canonically equal to CommonMark.
 * - `diverges`: the constrained renderer accepted input it renders differently
 *   from CommonMark, a drift bug the hosted page must never ship.
 */
export type CommonMarkComparison =
  | { kind: "rejected"; error: Error }
  | { kind: "matches" }
  | { kind: "diverges"; constrained: string; reference: string };

/**
 * Fail-closed differential check. The constrained renderer must either reject
 * the input or produce output canonically equal to the reference CommonMark
 * parser; a `diverges` result means it silently mis-rendered a construct.
 */
export function compareToCommonMark(
  markdown: string,
  render: (markdown: string) => string,
): CommonMarkComparison {
  let constrainedHtml: string;
  try {
    constrainedHtml = render(markdown);
  } catch (error) {
    return { kind: "rejected", error: error as Error };
  }
  const constrained = canonicalizeHtml(constrainedHtml);
  const reference = canonicalizeHtml(renderReferenceHtml(markdown));
  return constrained === reference
    ? { kind: "matches" }
    : { kind: "diverges", constrained, reference };
}

/**
 * Assert the constrained renderer produced output equal to reference
 * CommonMark. On a `diverges` result the canonical HTML strings are compared
 * first so the failure surfaces a readable diff rather than a bare enum
 * mismatch; `matches` is then the real assertion.
 */
export function expectMatchesCommonMark(comparison: CommonMarkComparison): void {
  if (comparison.kind === "diverges") {
    expect(comparison.constrained).toBe(comparison.reference);
  }
  expect(comparison.kind).toBe("matches");
}

/**
 * Assert the constrained renderer refused the input (fail-closed) rather than
 * silently mis-rendering it. `diverges`, accepted but rendered differently from
 * CommonMark, is the drift bug this must never allow.
 */
export function expectRejectedByOracle(comparison: CommonMarkComparison): void {
  expect(comparison.kind).not.toBe("diverges");
  expect(comparison.kind).toBe("rejected");
}
