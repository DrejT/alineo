# Alineo Swarm Control Plane (UI Dashboard)

A production-grade, agentic operational control plane for swarms of sandboxed AI agents, built directly on the **Alineo execution substrate**, **OpenSandbox**, and **bun:sqlite**.

> **Note on Agentic UI**: This is **NOT a conversational chatbot** with text bubbles. Following the design paradigms of [alineo.tech](https://alineo.tech/), [UI SDK](https://ui-sdk.dev/docs), and [OneCLI / amika.dev](https://amika.dev), this dashboard is an **asymmetric operations cockpit** for observing, steering, checkpointing, and securing autonomous multi-agent swarms.

---

## Key Features

1. **Execution Topology Visualizer (SVG)**
   - Live interactive graph showing root orchestrators and forked child nodes.
   - Dynamic cubic Bézier edges representing Copy-on-Write (CoW) sandbox lineage.
   - Real-time status indicators (emerald pulse for running, amber for paused, dashed for forked).
   - Instant node inspector showing PID, uptime, compute millicores, RAM, MCP tool badges, and recent execution ledger.

2. **Micro-Container Fleet Management**
   - Full lifecycle management: `Spawn`, `Pause`, `Resume`, `Fork`, `Checkpoint`, `Terminate`.
   - Resource bound configuration (CPU millicores, Memory MiB).
   - Injected Model Context Protocol (MCP) tool permissions (GitHub, Postgres, Slack, Filesystem).
   - Quick-Wake input for instant container resumption by ID.

3. **Immutable Audit & Replay Ledger**
   - Append-only event ledger backed by `@alineo-labs/sqlite` / `bun:sqlite` with WAL mode.
   - Horizontal commit and branch scrubber marking `exec_start`, `exec_event`, `checkpoint`, and `exec_complete`.
   - Deterministic replay streamer with automatic secret redaction (`[REDACTED_EXEC_TIME]`).

4. **Memory Core Subsystem**
   - **Working Memory**: Live Key-Value scratchpad for active agents with scope governance (`local`, `subtree`, `swarm`).
   - **Episodic Memory**: Hierarchical decision trees capturing agent analyses, subtask divisions, and outcomes.
   - **Semantic Knowledge**: Multi-predicate fact store with vector/term relevance scoring and query recall.
   - **Compaction Pipeline**: Automated pruning of expired memories with on-demand vacuuming.

5. **Security Perimeter & Egress Approvals**
   - Egress gate queue intercepting outbound network calls to external endpoints.
   - Operator approval workflow (`Approve` / `Deny`) with automated sandbox unpausing upon approval.
   - Strict host allowlist and secret token scrubbing.

6. **Workflow Concurrency Semaphores**
   - `@alineo-labs/workflow` lazy pipeline with `maxConcurrency: 4` slots.
   - Slot status monitor (Active, Queued, Idle).
   - Enqueue and pipeline flush controls.

7. **Sliding PTY Terminal & Agent Steering Drawer**
   - Direct command execution inside sandbox containers with stdout/stderr capture and timing.
   - Multi-scope steering directive input (`node`, `subtree`, `fleet`) to dynamically guide autonomous agents.

8. **OneCLI / amika.dev Command Palette**
   - Quick command runner accessible via `Ctrl+K`.
   - Supports: `alineo status`, `alineo spawn`, `alineo fork`, `alineo checkpoint`, `alineo steer`, `alineo memory recall`, `alineo egress approve`, `alineo workflow flush`.

9. **Dual-Density Engine**
   - **Simple Mode**: Executive summary cards, plain-English task statuses, human-friendly badges for non-tech users.
   - **Telemetry Mode**: System metrics, CPU/RAM millicores/MiB, PIDs, SQLite transaction sequence numbers, raw JSON payloads for engineers.

---

## How to Run

### Option 1: Run via Bun (Recommended)
From the repository root (`alineo/`):
```bash
# Start the production control plane server
cd ui
bun run start
```
Or with auto-reload during development:
```bash
bun run dev
```

The server will boot on port `4600`:
- **Web Dashboard**: Open [http://localhost:4600](http://localhost:4600)
- **Health Check**: [http://localhost:4600/health](http://localhost:4600/health)
- **REST APIs**: `http://localhost:4600/api/...`

### Option 2: Run End-to-End Automated Tests
```bash
cd ui
bun run test
```
Runs the automated integration test verifying sandbox lifecycle, memory store/recall, egress gates, steering, and workflows.

---

## End-to-End Use Case: PR #418 Code Review & Security Swarm

You can run this full multi-agent use case directly from the dashboard:

1. Click **`▶ Run Demo Swarm Use Case`** in the top navigation bar.
2. The system executes the following real operations:
   - **Spawn Root Reviewer**: Deploys `sbx_8F4K2M` (`code-reviewer-root`) with GitHub and Slack MCP tools.
   - **Inspect Diff**: Executes real `git diff origin/main...HEAD --stat` in sandbox.
   - **CoW Fork**: Clones rootfs state into child security worker `sbx_2Q9RTA` (`reviewer-security`).
   - **Memory Registration**: Injects working memory (`pr_target = 418`, `auth_policy = rs256`) and semantic fact.
   - **Security Egress Gate**: Security worker attempts outbound connection to `api.osv.dev:443`, pauses container, and creates `gate_91`.
   - **Operator Approval**: Operator clicks **Approve** in the top alert banner or Egress Queue; the container immediately resumes.
   - **Checkpointing**: State snapshot `cp_0142` is committed into the SQLite ledger.
   - **Agent Steering**: Operator sends subtree steering directive `"Enforce strict token verification"`, broadcasting instructions down the agent tree.
   - **Consensus**: Swarm completes PR review with zero secrets leaked.

---

## Directory Structure

```
ui/
├── package.json              # Package definition & scripts
├── tsconfig.json             # TypeScript configuration
├── README.md                 # Complete guide & documentation
├── server/
│   ├── index.ts              # Bun HTTP server & REST router
│   ├── db.ts                 # SQLite persistence & WAL schema
│   ├── sandboxes.ts          # Sandbox micro-container lifecycle engine
│   ├── memory.ts             # Memory Core (working, episodic, semantic, compaction)
│   ├── security.ts           # Egress gates & perimeter approvals
│   ├── workflow.ts           # Concurrency semaphore & pipeline slots
│   ├── steer.ts              # Agent steering engine (node, subtree, fleet)
│   └── cli.ts                # OneCLI command execution runner
├── public/
│   ├── index.html            # Production dashboard UI
│   ├── css/
│   │   └── style.css         # Styling, tokens, and animations
│   └── js/
│       ├── api.js            # REST API client
│       ├── app.js            # Master dashboard controller
│       ├── topology.js       # Interactive SVG topology graph
│       ├── scrubber.js       # Horizontal commit & replay scrubber
│       ├── memory-view.js    # Memory subsystem views
│       └── onecli.js         # OneCLI command palette runner
└── tests/
    └── usecase.test.ts       # End-to-end integration test
```
