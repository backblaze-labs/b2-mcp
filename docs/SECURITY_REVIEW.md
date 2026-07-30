# Security And Provenance Review

Owner: Sophie / QK (`@sophiecarreras`). Implementation owner: Gonza
(`@goanpeca`).

Status: skeleton. Issues #62, #66, and #67 own the final pre-public review.

## Secret Scan

Before public visibility or `v0.1.0`, run a complete-history secret scan from a
fresh clone of the canonical repository:

```bash
mamba env create -f environment.yml
mamba run -n b2-mcp trufflehog --json --regex --entropy=True \
  --exclude_paths .trufflehog-exclude \
  --repo_path . file://$(pwd)
```

The exclude file is limited to lockfile integrity-hash noise. Do not disable
entropy globally: B2 application-key secrets and many session tokens are
high-entropy strings without a stable textual prefix. Findings must be revoked,
removed from history if necessary, and documented before release.

To verify the scanner still catches non-regex high-entropy material, create a
temporary git repository, commit a random high-entropy sentinel string, and
confirm the command above reports it before running the release scan.

## Legal And Provenance Checklist

- Confirm `LICENSE` matches intended public distribution.
- Review complete git history authorship and imported source provenance.
- Confirm third-party runtime dependencies are compatible with the intended
  package and self-hosted deployment model.
- Confirm generated or copied documentation has a known source and owner.
- Record any risk acceptance with owner, rationale, and re-review date.

This document is not legal approval. It is the repo-owned checklist that must be
completed before the release owner asks for public release sign-off.
