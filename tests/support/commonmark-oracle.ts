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
 * Only intentional, safe differences are normalized away:
 * - heading `id` slugs (the hosted renderer adds anchor ids the reference omits)
 * - the `REPO_BLOB_URL` rewrite the hosted renderer applies to relative links
 * - insignificant whitespace (a softbreak `\n` vs a joined space, indentation)
 *
 * Anything semantic — a dropped `<br>`, a construct emitted as literal text
 * instead of markup, emphasis, an entity rendered as source — survives and
 * forces a mismatch, which is exactly the drift the oracle must catch.
 */
export function canonicalizeHtml(html: string): string {
  return html
    .replace(/\sid="[^"]*"/g, "")
    .split(REPO_BLOB_URL)
    .join("")
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
