# alineo cookbook

Task-oriented recipes for building with alineo — real end-to-end scenarios built by composing the
SDK's primitives (sandboxes, exec, checkpoints, forks, workflows, agents), as opposed to
[`examples/`](../examples), which demonstrates one primitive at a time.

Structure and spirit borrowed from
[Composio's `python/examples`](https://github.com/ComposioHQ/composio/tree/next/python/examples):
each recipe is a small, standalone, runnable package you can copy out of this repo and adapt —
no shared runtime package to unwind first.

Every recipe below is also published on the [docs site](https://docs.alineo.tech/docs/cookbooks).

| Recipe                                                 | What it shows                                                                                                   |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| [`untrusted-code-execution`](untrusted-code-execution) | Running LLM-generated / untrusted code safely — per-snippet isolation, resource caps, timeouts                  |
| [`ci-test-runner`](ci-test-runner)                     | Running a repo's test suite in a disposable sandbox and turning the output into a structured pass/fail report   |
| [`parallel-test-shards`](parallel-test-shards)         | Installing dependencies once, then `fork()`-ing into parallel sandboxes to shard work                           |
| [`resumable-etl-pipeline`](resumable-etl-pipeline)     | A multi-stage pipeline that checkpoints after each stage and resumes without redoing completed work             |
| [`ai-agent-bugfix`](ai-agent-bugfix)                   | An `alineo` agent that debugs and fixes a failing test on its own, then gets independently verified |

## Setup

```bash
bunx alineo-cli init   # starts OpenSandbox in Docker (one-time setup)
```

## Run any recipe

```bash
cd cookbooks/<recipe>
bun install
bun start
```

Each recipe's own README has the specifics — including any extra setup, like the API key
`ai-agent-bugfix` needs.
