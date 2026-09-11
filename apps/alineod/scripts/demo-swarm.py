#!/usr/bin/env python3
"""
Fan-out/gather swarm demo against a running alineod.

  root "coordinator"  -> spawns 3 haiku workers -> a "gather" agent waitFor's all 3
                         and assembles their outputs (delivered as /inputs/*.txt + /inputs.json).

Usage:  python3 demo-swarm.py [BASE_URL]      (default http://localhost:4600)

Not a test — a scripted client that exercises the v0 routes end to end.
"""
import json
import sys
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(line_buffering=True)  # so progress shows in a redirected log

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4600"
MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b"
NV = "${NVIDIA_API_KEY}"  # resolved from the alineod process env by the SDK


def call(method, path, body=None, timeout=320):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "null")
    except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
        return 0, {"transport_error": str(e)}


def spec(name, **extra):
    return {
        "name": name, "cli": "pi", "provider": "nvidia", "model": MODEL,
        "env": {"NVIDIA_API_KEY": NV},
        "resources": {"cpu": "1000m", "memory": "2Gi"},
        **extra,
    }


def wait_live(agent_id, timeout_s=180):
    """POST /runs and POST /agents are async (202, provisioning in the background) — an agent
    can only be used as a spawn parent once its sandbox exists. Poll until `sandboxId` is set
    (the agent_provisioned event has landed) or it ends in failure."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        st, a = call("GET", f"/agents/{agent_id}", timeout=10)
        if a and a.get("sandboxId"):
            return a
        if a and a.get("outcome") in ("failed", "aborted", "budget-exceeded", "lost"):
            raise RuntimeError(f"{agent_id} ended before becoming live: {a}")
        time.sleep(2)
    raise TimeoutError(f"{agent_id} never became live within {timeout_s}s")


print(f"→ {BASE}")

print("[1] POST /runs  (root: coordinator, spawnDepth 2)")
st, run = call("POST", "/runs", {
    "spec": spec("coordinator", spawnDepth=2, maxAgents=10),
    "prompt": "You coordinate three worker agents assembling a poem. Reply with exactly: READY",
})
print("   ", st, run)
rid, root = run["runId"], run["rootAgentId"]

print(f"    waiting for {root} to become live (sandbox provisioned)...")
wait_live(root)
print(f"    {root} is live")

workers = []
for topic in ("the ocean", "mountains", "the desert"):
    print(f"[2] POST /runs/{rid}/agents  (worker: {topic})")
    st, w = call("POST", f"/runs/{rid}/agents", {
        "spec": spec(f"worker-{topic.split()[-1]}"),
        "parentAgentId": root,
        "prompt": f"Write one haiku (three lines, 5-7-5) about {topic}. Output only the three lines.",
    })
    print("   ", st, w)
    workers.append(w["agentId"])

print(f"[3] POST /runs/{rid}/agents  (gather, waitFor {workers})")
st, g = call("POST", f"/runs/{rid}/agents", {
    "spec": spec("gather"),
    "parentAgentId": root,
    "waitFor": workers,
    "prompt": (
        "The file /inputs.json lists three text files, each holding one haiku "
        "(ocean, mountains, desert). Read all three. Then output a poem titled "
        "'Three Landscapes' with the three haikus as three stanzas in that order. "
        "Output only the poem."
    ),
})
print("   ", st, g)
gather = g["agentId"]

print(f"[4] GET /agents/{gather}/result  (poll until settled)")
res = None
for i in range(120):
    st, res = call("GET", f"/agents/{gather}/result", timeout=20)
    print(f"    [{i}] {st} {res.get('state') if res else res}")
    if res and res.get("state") == "settled":
        break
    time.sleep(5)
print("   ", st)
print(json.dumps(res, indent=2))

print(f"\n[5] GET /runs/{rid}  (final tree)")
st, tree = call("GET", f"/runs/{rid}")
for a in tree["agents"]:
    print(f"   {a['agentId']}  depth={a['depth']}  {a['state']:9}  {a['outcome']}  {a['specName']}")
