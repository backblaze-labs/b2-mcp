# Repository Rulesets

## Release Tags

The package publish workflow runs on `v*.*.*` and `v*.*.*-*` tag pushes. GitHub
loads a tag-push workflow from the tagged commit before the workflow can verify
that the release tag is reachable from `ci-green`, so release tag creation must
be restricted outside the workflow.

Keep `release-tags.json` active in GitHub repository rulesets. It blocks
creating, updating, or deleting release tags unless the actor is a trusted
release principal with repository-admin bypass. Do not grant this bypass to the
general repository write role.
