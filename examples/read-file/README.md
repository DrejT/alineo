# read-file

Demonstrates `sb.readFile()` — reading a file written inside the sandbox back to the host process.

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

1. Creates a `node:20-slim` sandbox
2. Runs a Node.js one-liner that writes the Node version to `/tmp/version.txt`
3. Reads the file back using `sb.readFile()`
4. Writes a JSON report to the sandbox using `sb.writeFile()` and reads it back
5. Prints both captured values to the console
