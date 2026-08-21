# Alineo Skill

This skill provides comprehensive rules and guidelines for working with the `alineo` agent SDK, CLI, and the storage adapters it requires. It does not cover the underlying `@alineo-labs/sandbox` client SDK.

## Installation

To add this skill to your workspace, run the following command using `npx`:

```bash
npx skills add DrejT/alineo --skill alineo
```

This will automatically fetch and install the skill into your `.agents/skills/alineo` directory.

## What This Skill Does

When an AI agent is equipped with this skill, it gains deep, context-aware knowledge of the Alineo framework. Specifically, the skill enables the agent to:
- **Write and Debug Alineo Agent Code**: Generate correct TypeScript SDK code for loading, resuming, and spawning Pi agents, including streaming prompts and session control.
- **Use the Alineo CLI**: Expertly navigate the `alineo-cli` for local development workflows.
- **Troubleshoot Effectively**: Quickly diagnose common issues, especially Windows-specific gotchas or SQLite/Postgres adapter problems.
- **Follow Best Practices**: Adhere to the core architectural guidelines and event ledger patterns specific to Alineo.

## How to Use This Skill

Once installed, this skill is automatically invoked when working within the repository. To make the most of it:

1. **Review Architecture**: Check out `rules/architecture.md` for the core design principles of Alineo and OpenSandbox.
2. **Consult Specific Rules**: Depending on the component you are working on, refer directly to the corresponding `.md` file in the `rules/` directory:
   - CLI issues: `cli.md`
   - Storage adapters (SQLite/Postgres): `adapters.md`
   - Agent SDK interactions: `agent-sdk.md`
   - Testing & Development: `development.md`
3. **Troubleshooting**: Encountering issues, especially on Windows? Start with `rules/troubleshooting.md`.

## Maintaining the Skill

When updating this skill for distribution, ensure that any changes are reflected in the corresponding rule files in the `rules/` directory and that `SKILL.md` is updated with the latest references.
