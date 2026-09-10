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


def spec(name, **extra):
    return {
        "name": name, "cli": "pi", "provider": "nvidia", "model": MODEL,
        "env": {"NVIDIA_API_KEY": NV},
        "resources": {"cpu": "1000m", "memory": "2Gi"},
        **extra,
    }


print(f"→ {BASE}")

print("[1] POST /runs  (root: coordinator, spawnDepth 2)")
st, run = call("POST", "/runs", {
    "spec": spec("coordinator", spawnDepth=2, maxAgents=10),
    "prompt": "You coordinate three worker agents assembling a poem. Reply with exactly: READY",
})
print("   ", st, run)
rid, root = run["runId"], run["rootAgentId"]

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

print(f"[4] GET /agents/{gather}/result?wait=240  (polls until settled)")
res = None
for _ in range(20):
    st, res = call("GET", f"/agents/{gather}/result?wait=240", timeout=250)
    if res and res.get("state") == "settled":
        break
print("   ", st)
print(json.dumps(res, indent=2))

print(f"\n[5] GET /runs/{rid}  (final tree)")
st, tree = call("GET", f"/runs/{rid}")
for a in tree["agents"]:
    print(f"   {a['agentId']}  depth={a['depth']}  {a['state']:9}  {a['outcome']}  {a['specName']}")
