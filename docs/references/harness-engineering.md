# Harness Engineering Reference

Source: Ryan Lopopolo, "Harness engineering: leveraging Codex in an agent-first
world", OpenAI, 2026-02-11:
<https://openai.com/index/harness-engineering/>

This repository adopts the part of the reference that treats `AGENTS.md` as a
short map and `docs/` as the versioned system of record. The local taxonomy is:

```text
AGENTS.md
ARCHITECTURE.md
docs/
  design-docs/
    index.md
  exec-plans/
    active/
    completed/
    tech-debt-tracker.md
  product-specs/
    index.md
  references/
  generated/  # Phase 2 target; not present in Phase 1.
```

Since #528 the per-change records follow the AI-native SDLC playbook instead:
`exec-plans/` moved to `intent/<slug>/` (`intent.md`, `spec.md`, `plan.md`; see
[`../../intent/README.md`](../../intent/README.md)), and deferred work becomes a
new intent rather than a tech-debt tracker row. `design-docs/` and
`product-specs/` keep the long-lived public contracts.

Phase 1 moves the non-generated system-of-record docs into that shape. The
generated tool-profile artifacts remain in `docs/` until the Phase 2 move.
