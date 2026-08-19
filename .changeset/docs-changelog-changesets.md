---
"docs": patch
---

Wire the `/changelog` page to the changeset-generated `CHANGELOG.md` files for `alineo` and
`alineo-cli` instead of a hand-edited placeholder entry. Renders a single date-sorted timeline
(dates from the npm registry, since changesets itself records none), badged per package, cut off at
the drej -> alineo rename boundary and stripped of internal `Updated dependencies` noise. No public
API change — docs content only.
