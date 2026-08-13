# capture

Demonstrates capturing exec stdout and using it as input for subsequent steps.

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
2. Runs a Node.js one-liner and captures its stdout (the Node version string)
3. Interpolates the captured value into a subsequent exec command
4. Writes a JSON file into the sandbox using the captured value
5. Reads the file back with `sb.readFile()` and prints it
