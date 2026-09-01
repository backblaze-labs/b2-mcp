# GitHub Social Preview

`.github/social-preview.png` is the source-controlled candidate for the
repository's GitHub social preview image (1280x640, the size GitHub recommends).
GitHub does not consume this path automatically. A maintainer with repository
Settings access must upload the PNG manually through Settings -> Social preview.

Editable source: `.github/social-preview.svg`.

## Brand

The card follows the Backblaze brand kit:

- Colors: brand navy `#000033` background, flame red `#E20626` accent, white text.
- Typeface: **Space Grotesk** (Backblaze display font), embedded in the SVG as
  base64 WOFF2 so the render is font-accurate on any machine.
- Logo: the official **Backblaze B2** long logo (red flame + white wordmark),
  embedded as an SVG data URI.
- Layout leaves GitHub's recommended ~40px safe border around all text and the
  logo so nothing is clipped when the card is cropped or rounded in unfurls.

Keep the copy evergreen: no mutable facts (tool counts, backing-category counts,
protocol dates, dependency versions, coverage values, release versions).

## Regeneration

The SVG uses `<foreignObject>` with embedded fonts, so render it with a
**browser-based** renderer (Chromium/WebKit/Playwright), not `resvg`/Inkscape
(which do not support `foreignObject`).

1. Edit `.github/social-preview.svg`.
2. Open it in a browser sized to a 1280x640 viewport and capture the element, or
   load it in Playwright and screenshot, then downscale to exactly 1280x640.
3. Save the result to `.github/social-preview.png`.
4. Upload `.github/social-preview.png` in GitHub Settings -> Social preview.
5. Verify the live repository reports `usesCustomOpenGraphImage: true`:

```bash
gh repo view backblaze-labs/b2-mcp \
  --json usesCustomOpenGraphImage,openGraphImageUrl
```

## Drift checklist

- Regenerate and re-upload the preview when the repository name, product name,
  primary positioning, or Backblaze B2 branding changes.
- Avoid mutable facts in the image: tool counts, backing-category counts,
  protocol dates, dependency versions, coverage values, and release versions.
- Treat the PNG as stale until the GitHub repository setting has been updated
  and verified.
