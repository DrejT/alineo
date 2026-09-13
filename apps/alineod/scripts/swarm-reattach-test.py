#!/usr/bin/env python3
"""
Multi-agent D-a verification: spawn a small tree with agents at DIFFERENT lifecycle stages
(mid-tool-call, waitFor-blocked) simultaneously, print the tree, then STOP — the harness
kills alineod and restarts it externally, then re-runs this with --after to check the result.
"""
import json
import sys
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(line_buffering=True)
BASE = "http://localhost:4600"
MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b"
NV = "${NVIDIA_API_KEY}"


def call(method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "null")


def spec(name, **extra):
    return {"name": name, "cli": "pi", "provider": "nvidia", "model": MODEL,
            "env": {"NVIDIA_API_KEY": NV}, "resources": {"cpu": "1000m", "memory": "2Gi"}, **extra}


def wait_live(agent_id, timeout_s=180):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        st, a = call("GET", f"/agents/{agent_id}", timeout=10)
        if a and a.get("sandboxId"):
            return a
        if a and a.get("outcome") in ("failed", "aborted", "budget-exceeded", "lost"):
            raise RuntimeError(f"{agent_id} ended before becoming live: {a}")
        time.sleep(2)
    raise TimeoutError(f"{agent_id} never became live")


if sys.argv[1:] == ["--after"]:
    rid = open("/tmp/reattach-rid.txt").read().strip()
    print(f"[after] GET /runs/{rid}")
    st, tree = call("GET", f"/runs/{rid}")
    for a in tree["agents"]:
        print(f"   {a['agentId']}  depth={a['depth']}  {a['state']:10}  {a['outcome']}  {a['specName']}")
    sys.exit(0)

print("[1] POST /runs (coordinator, spawnDepth 2)")
st, run = call("POST", "/runs", {"spec": spec("coordinator", spawnDepth=2, maxAgents=10),
                                  "prompt": "Reply with exactly: READY"})
print("   ", st, run)
rid, root = run["runId"], run["rootAgentId"]
open("/tmp/reattach-rid.txt", "w").write(rid)

wait_live(root)
print(f"    {root} is live")

workers = []
for name, secs, marker in (("ocean", 20, "OCEAN_DONE"), ("mountains", 25, "MOUNTAIN_DONE"), ("desert", 30, "DESERT_DONE")):
    st, w = call("POST", f"/runs/{rid}/agents", {
        "spec": spec(f"worker-{name}"),
        "parentAgentId": root,
        "prompt": f"Run the bash command exactly: sleep {secs} && echo {marker}  -- then report its output verbatim.",
    })
    print(f"[2] worker-{name} ->", st, w)
    workers.append(w["agentId"])

st, g = call("POST", f"/runs/{rid}/agents", {
    "spec": spec("gather"), "parentAgentId": root, "waitFor": workers,
    "prompt": "Combine the three workers' outputs. Output only the combined text.",
})
print("[3] gather (waitFor, will be blocked/'spawning') ->", st, g)

print(f"\nrunId={rid}")
print("Now: wait for tool_start on all 3 workers, then kill -9 alineod from the harness.")
