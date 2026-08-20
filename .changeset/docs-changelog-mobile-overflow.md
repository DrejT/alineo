---
"docs": patch
---

Fix `/changelog` overflowing horizontally on narrow viewports. `@tailwindcss/typography`'s `.prose` never sets a wrap rule on inline `code`, so long unbroken identifiers in changelog entries (e.g. `ALINEO_OBSERVABILITY`, `CreateSandboxOptions.metadata`) pushed past the viewport edge instead of wrapping. Inline code now uses `break-words` globally, fixing the changelog page and any other docs page with a long inline-code identifier near a line wrap.
