---
---

Repo tooling only, no publishable package changes: automate the docs version cut.

`plans/versioned-docs.md` left "fire a version cut on a package minor bump" as a
manual step — and it was missed twice (0.2.0 → PRs #193/#194, 0.3.0 → PR #223),
each time via a feature PR editing the current-latest `content/docs/{core,alineo}/vX.Y/`
folder in place instead of adding a new one.

- `apps/docs/scripts/cut-doc-version.ts` — `cp -r` the latest folder to `v<epoch>`
  for both trees and repoint its internal links, where the epoch is
  `@alineo-labs/sandbox`'s published `major.minor` (`epochVersion()` in
  `doc-versions.ts`). `--check` mode does no writes and exits non-zero if a cut is owed.
- `release:version` root script (`changeset version && cut-doc-version.ts`), wired
  into `release.yml` as `changesets/action`'s `version:` command — the
  `chore: version packages` PR now always carries the matching folder.
- `ci.yml` `Docs version check` job runs `cut-doc-version.ts --check` on every PR.
- `CLAUDE.md` + `plans/versioned-docs.md` updated.
