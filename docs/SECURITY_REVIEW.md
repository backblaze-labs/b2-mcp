# Security And Provenance Review

Owner: Sophie / QK (`@sophiecarreras`). Implementation owner: Gonza
(`@goanpeca`).

Status: skeleton. Issues #62, #66, and #67 own the final pre-public review.

## Secret Scan

Before public visibility or `v0.1.0`, run a complete-history secret scan from a
fresh clone of the canonical repository:

```bash
mamba env create -f environment.yml
mamba run -n b2-mcp trufflehog --json --regex --entropy=False --repo_path . file://$(pwd)
```

`trufflehog` entropy checks can also be run as a secondary pass, but lockfile
integrity hashes must be triaged separately from secret material. Findings must
be revoked, removed from history if necessary, and documented before release.

## Legal And Provenance Checklist

- Confirm `LICENSE` matches intended public distribution.
- Review complete git history authorship and imported source provenance.
- Confirm third-party runtime dependencies are compatible with the intended
  package and self-hosted deployment model.
- Confirm generated or copied documentation has a known source and owner.
- Record any risk acceptance with owner, rationale, and re-review date.

This document is not legal approval. It is the repo-owned checklist that must be
completed before the release owner asks for public release sign-off.
