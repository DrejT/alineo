# interactive-exec

Demonstrates `sb.exec(cmd, { interactive: true })`: a live, bidirectional PTY session that can be driven like a human — and resumed like one too.

## Setup

```bash
bunx alineo-cli init   # starts OpenSandbox in Docker (one-time setup)
```

## Run

```bash
bun install
bun start
```

## What it does

1. Creates an `ubuntu:22.04` sandbox and opens an interactive `bash` session
2. Drives it with several `write()` calls — exports a var, `cd`s into a directory, writes a file — none of which is a single self-contained command
3. Checkpoints the sandbox **while the shell is still open** (not after it exits)
4. Resumes from that checkpoint into a new sandbox
5. Opens the same interactive exec again at the same call site — the resume path detects the session was still open, replays its recorded stdin for real against the freshly restored filesystem, then hands control back live
6. Asserts the `cd`, the file contents, and the exported variable all survived — reconstructed by re-running the recorded input, not by faking a transcript
7. Exits the shell and asserts the interactive exec resolves with the process's real exit code

OpenSandbox snapshots are rootfs-only (no CRIU) — the original bash process is provably gone after resume. Reconstructing shell state is only possible by replaying the stdin that produced it.
