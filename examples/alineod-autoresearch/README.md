# alineod-autoresearch

An [autoresearch](https://github.com/karpathy/autoresearch)-style loop, run by several agents in
parallel through [alineod](../../apps/alineod). Each researcher edits one file to lower one metric,
as measured by a judge it may not edit:

```text
lead (root, idle)         holds the task files in /work
├─ researcher-1 … -N      fork the lead's sandbox, each with its own starting direction
```

The task is a CPU-sized toy, not GPU training: `task/model.py` is a character-level language model,
and `task/evaluate.py` scores it as `val_bpc` (bits per character on held-out text). The baseline
scores **3.0283**; a hand-written interpolated n-gram scores about 2.37.

| File               | Role                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task/program.md`  | instructions for the agent (the loop, the rules, the `RESULT` line to finish with)                                                                      |
| `task/model.py`    | the one file the agent edits                                                                                                                            |
| `task/evaluate.py` | the fixed judge. It rejects probabilities that don't sum to 1 and runs over 30 s                                                                        |
| `task/data.txt`    | _Alice's Adventures in Wonderland_, from [Project Gutenberg](https://www.gutenberg.org/ebooks/11) (public domain in the US), without the licence header |
| `index.ts`         | the orchestrator: builds the lab, forks the researchers, supervises them                                                                                |

## Run it

```bash
bunx alineo-cli init          # starts OpenSandbox in Docker (one-time setup)
bun install && bun run build  # from the repo root
```

Start alineod in its own terminal, with your NVIDIA key in **its** environment. Agent specs
reference `${NVIDIA_API_KEY}`, which the daemon resolves, so the key never travels in a request:

```bash
cd apps/alineod
NVIDIA_API_KEY=nvapi-... bun run start
```

Then, in another terminal:

```bash
cd examples/alineod-autoresearch
bun start
```

The first run provisions the lead sandbox cold, which takes a couple of minutes. Later runs reuse
its snapshot.

| Variable       | Default                             |                                                                            |
| -------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| `ALINEOD_URL`  | `http://localhost:4600`             | where alineod is                                                           |
| `MODEL`        | `nvidia/nemotron-3-super-120b-a12b` | the model every researcher uses                                            |
| `RESEARCHERS`  | `4`                                 | how many to fork                                                           |
| `QUORUM`       | `2`                                 | stop the rest once this many return a valid result                         |
| `MAX_NUDGES`   | `4`                                 | how often to tell an agent to carry on after a turn ended without a result |
| `DEADLINE_MIN` | `20`                                | give up after this long                                                    |
| `KEEP_RUN`     | unset                               | `1` leaves the sandboxes up so you can inspect `/work`                     |

## Why the orchestrator supervises

An agent's turn ending isn't the same as it finishing. If the model API answers "overloaded" or
returns a 429, the turn ends anyway. alineod records that as `failed` (versions before
[#296](https://github.com/DrejT/alineo/pull/296) recorded `success` with an empty result), and a
turn can also end normally without a result. So `index.ts` checks each agent's final message for
the `RESULT` line, waits with a growing pause, and prompts the agent to carry on, up to
`MAX_NUDGES` times. See the blog post
[How to run autoresearch with multiple AI agents in parallel](https://docs.alineo.tech/blog/parallel-autoresearch-agents).

## Limits

- The scores are **what each agent reports**. To verify one, run `python3 evaluate.py` in that
  agent's `/work` (use `KEEP_RUN=1`).
- An agent with file access could read the held-out text from `model.py`. `program.md` forbids it;
  a real setup would keep evaluation where the agent can't read.
- Which models work depends on your account and the day. Check a trivial request and one tool call
  before you pick one.
