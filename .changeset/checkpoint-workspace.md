---
"alineo": minor
---

A turn checkpoint now includes `/workspace` when it exists, so a restored agent gets back the files it worked on and not only its Pi conversation. Before this, a checkpoint covered `/root` only, and `/workspace` is where most specs work.

`node_modules` directories inside `/workspace` are left out. They are nearly all of the cost: a web app with 417 packages was 20 MB and 5 s with them, and 0.1 MB and 0.03 s without. The agent installs them again after a restore. A `node_modules` under `/root` is still included, because it can hold Pi's own packages.

Checkpoints are larger for agents that keep a repository in `/workspace`. A cloned repository measured 3.5 MB and 0.5 s.
