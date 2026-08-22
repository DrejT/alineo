---
---

Docs site only, no publishable package changes: fix the version switcher still
double-prefixing the target URL (e.g. /docs/core/0.2/0.1) after #195's path-computation
fix. Reproduced live with Playwright + network tracing: the path computation was
already correct (it requested the right .../0.1.txt flight payload first), but
Next's client-side RSC-flight navigation between two sibling values of the same
[version] dynamic segment (output:"export" + dynamicParams:false) 404s on that
request and wrongly retries relative to the current path, landing on a real 404
with the mangled URL. Switched to a full page navigation (window.location.href)
for version switches instead of router.push — verified with a real build served
locally and driven with Playwright, both directions and from a subpage.
