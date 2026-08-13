# Task: backfill missing example READMEs

The repo is cloned at ./repo (alineo, a sandbox execution substrate). Every
folder under ./repo/examples/ should have a README.md describing, in one
short paragraph, what capability that example demonstrates (base it on the
index.ts file in that folder).

The examples missing a README.md are listed, one per line, in
./MISSING_READMES.txt (already computed for you -- no need to search for
them). Decide how to split this list among spawned child agents (one child
per example, or grouped -- your call), and have each child write the
missing README.md for its assigned example(s) inside its own copy of the
repo (children start from your exact checked-out commit, so their edits
apply to the same tree).

To fork a child, run exactly this (your own session name is
rlm-fanout-master):

    alineo fork rlm-fanout-master ./agents/worker.json --prompt "<plain instruction>" --json

Keep each --prompt value plain English, naming the example and the file to
write. Do not embed literal shell commands or shell operators like && inside
the --prompt text -- the child will run its own commands once it starts, you
do not need to script that for it.

Do not write any README.md file yourself directly -- every missing README
must be written by a spawned child, even if there is only one missing file.
Your own job is to read MISSING_READMES.txt, decide the split, spawn one or
more children to do the writing, and collect their results.

Each child should:

- Write repo/examples/<name>/README.md (a short paragraph, no more).
- Run "cd repo && git diff" and report the full diff as its final answer.
- NOT commit or push anything.

When all children report back, combine their diffs and report the combined
patch set as your OWN final answer, in a fenced code block. Do not apply,
commit, or push anything yourself either -- this task is about producing a
reviewable patch set, not merging it.
