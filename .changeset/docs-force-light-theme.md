---
---

Docs site only, no publishable package changes: force the docs site to light mode.

PR #233 removed the forced-dark theme but left `themeSwitch` disabled, so the site fell
back to next-themes' `system` default — dark-OS visitors got the (now burgundy) `html.dark`
palette with no way to switch. Restore an explicit default: `forcedTheme: "light"` on
`RootProvider` plus a `light` class on `<html>`, matching the "light mode only" brand
direction.
