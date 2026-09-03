import { HtmlRenderer, Parser } from "commonmark";

// The constrained privacy-page renderer (`scripts/write-privacy-page.mjs`)
// rewrites relative Markdown link destinations to their canonical repository
// blob URL. The differential oracle normalizes that rewrite away so the
// constrained output can be compared for semantic equivalence against the
// reference CommonMark parser, which leaves relative destinations untouched.
const REPO_BLOB_URL = "https://github.com/backblaze-labs/b2-mcp/blob/main/";

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
 * - heading anchor `id`s only — the slug is stripped from `<h1>`–`<h6>` opening
 *   tags (the hosted renderer adds them; the reference omits them). An `id` on
 *   any other element survives and forces a mismatch.
 * - the relative→`REPO_BLOB_URL` href rewrite only — the blob-URL prefix is
 *   removed solely when it opens an `href="…"` destination value (the hosted
 *   renderer rewrites relative links to their repository blob URL; the
 *   reference keeps them relative). The blob URL appearing anywhere else — as
 *   literal text, or prepended to a non-relative destination — survives.
 * - insignificant whitespace (a softbreak `\n` vs a joined space, indentation).
 *
 * Anything semantic — a dropped `<br>`, a construct emitted as literal text
 * instead of markup, emphasis, an entity rendered as source — survives and
 * forces a mismatch, which is exactly the drift the oracle must catch.
 */
export function canonicalizeHtml(html: string): string {
  return html
    .replace(/(<h[1-6])\s+id="[^"]*"/g, "$1")
    .split(`href="${REPO_BLOB_URL}`)
    .join('href="')
    .replace(/>\s+</g, "><")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Outcome of comparing the constrained renderer against reference CommonMark:
 * - `rejected`: the constrained renderer refused the input (fail-closed, safe).
 * - `matches`: the constrained output is canonically equal to CommonMark.
 * - `diverges`: the constrained renderer accepted input it renders differently
 *   from CommonMark — a drift bug the hosted page must never ship.
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
 * silently mis-rendering it. `diverges` — accepted but rendered differently
 * from CommonMark — is the drift bug this must never allow.
 */
export function expectRejectedByOracle(comparison: CommonMarkComparison): void {
  expect(comparison.kind).not.toBe("diverges");
  expect(comparison.kind).toBe("rejected");
}
