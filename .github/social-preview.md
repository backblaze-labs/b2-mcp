# GitHub Social Preview

`.github/social-preview.png` is the source-controlled candidate for the
repository's GitHub social preview image. GitHub does not consume this path
automatically. A maintainer with repository Settings access must upload the PNG
manually through Settings -> Social preview.

Editable source: `.github/social-preview.svg`.

Regeneration process:

1. Edit `.github/social-preview.svg`.
2. Export a 1280x640 PNG to `.github/social-preview.png` with an SVG-aware
   editor or renderer.
3. Upload `.github/social-preview.png` in GitHub Settings -> Social preview.
4. Verify the live repository reports `usesCustomOpenGraphImage: true`:

```bash
gh repo view backblaze-labs/b2-mcp \
  --json usesCustomOpenGraphImage,openGraphImageUrl
```

Drift checklist:

- Regenerate and re-upload the preview when the repository name, product name,
  primary positioning, or Backblaze B2 branding changes.
- Avoid mutable facts in the image: tool counts, backing-category counts,
  protocol dates, dependency versions, coverage values, and release versions.
- Treat the PNG as stale until the GitHub repository setting has been updated
  and verified.
