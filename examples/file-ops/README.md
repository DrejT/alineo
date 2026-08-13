# file-ops

Demonstrates the full sandbox file operations API — no `exec`/`sed` needed for common file tasks.

## Setup

```bash
bunx alineo-cli init   # starts OpenSandbox in Docker (one-time setup)
```

## Run

```bash
bun install
bun start
```

## What it covers

| Method                                | Description                                           |
| ------------------------------------- | ----------------------------------------------------- |
| `writeFile` / `readFile`              | Write and read UTF-8 files                            |
| `moveFile` / `deleteFile`             | Move or remove a file                                 |
| `createDirectory` / `deleteDirectory` | Create or remove directories                          |
| `listDirectory`                       | List directory contents                               |
| `searchFiles`                         | Find files matching a glob pattern                    |
| `getFileInfo`                         | Stat a file (size, type, mode, timestamps)            |
| `replaceInFiles`                      | In-place string substitution across one or more files |
| `transfer`                            | Copy a file from one sandbox to another               |

Two sandboxes are used to demonstrate `transfer()`.
