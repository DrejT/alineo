---
---

Docs site only, no publishable package changes: fix the version switcher
double-prefixing the target URL (e.g. /docs/core/0.2/0.1 instead of
/docs/core/0.1) when switching versions. It derived the "rest of path" by
string-matching the current pathname against a prefix built from the
currentVersion prop, which silently produced no match — and no rest — in some
cases; it now splits the real pathname's own segments instead, independent of
that prop.
