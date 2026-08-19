# Alineo Skill

This skill provides comprehensive rules and guidelines for working with the `alineo` SDK, CLI, storage adapters, and API.

## Installation

To add this skill to your workspace, run the following command using `npx`:

```bash
npx skills add DrejT/alineo --skill alineo
```

This will automatically fetch and install the skill into your `.agents/skills/alineo` directory.

## How to Use This Skill

Once installed, this skill is automatically invoked when working within the repository. To make the most of it:

1. **Review Architecture**: Check out `rules/architecture.md` for the core design principles of Alineo and OpenSandbox.
2. **Consult Specific Rules**: Depending on the component you are working on, refer directly to the corresponding `.md` file in the `rules/` directory:
   - CLI issues: `cli.md`
   - Storage adapters (SQLite/Postgres): `adapters.md`
   - API interactions: `api-reference.md`
   - Testing & Development: `development.md`
3. **Troubleshooting**: Encountering issues, especially on Windows? Start with `rules/troubleshooting.md`.

## Maintaining the Skill

When updating this skill for distribution, ensure that any changes are reflected in the corresponding rule files in the `rules/` directory and that `SKILL.md` is updated with the latest references.
