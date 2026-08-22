---
---

Docs site only, no publishable package changes: comment out the version dropdown
(sidebar.banner) on core/alineo docs for now. The underlying versioning (v0.1/v0.2
content, dynamic registry, redirects) is untouched — this only hides the switcher
UI. Re-enable by uncommenting the sidebar/import blocks in both
`[version]/layout.tsx` files.
