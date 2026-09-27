#!/usr/bin/env python3
"""
Live SSE reconnect gate: drop the stream mid-run, reconnect with `Last-Event-ID`,
and prove the client missed nothing and saw nothing twice.

`apps/alineod/test/sse.test.ts` already covers this against `fakeSdk`. This exercises it
against a real swarm on a real daemon, which is the gate `plans/foundation-packages.md`
lists as still owed.

  python3 sse-reconnect-test.py [BASE_URL]      (default http://localhost:4600)

Passes when: the reconnected leg starts strictly after the last id seen, and
(leg 1 + leg 2) is exactly the run's persisted history, in seq order, no gaps, no repeats.
"""
import json
import sys
import threading
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(line_buffering=True)

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4600"
MODEL = "nvidia/nemotron-3-super-120b-a12b"
NV = "${NVIDIA_API_KEY}"
DROP_AFTER = 4          # ids seen on leg 1 before yanking the socket
GAP_SECONDS = 20        # stay disconnected this long, so events pile up


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
    except Exception as e:  # noqa: BLE001 - transport shape varies
        return 0, {"transport_error": str(e)}


def spec(name, **extra):
    s = {
        "name": name, "harness": "pi", "provider": "nvidia", "model": MODEL,
        "env": {"NVIDIA_API_KEY": NV},
        "resources": {"cpu": "1000m", "memory": "2Gi"},
    }
    s.update(extra)
    return s


def read_sse(run_id, last_event_id=None, stop_after=None, deadline=120):
    """Collect (id, event) frames. Returns (frames, stopped_early)."""
    headers = {"accept": "text/event-stream"}
    if last_event_id is not None:
        headers["Last-Event-ID"] = str(last_event_id)
    req = urllib.request.Request(f"{BASE}/runs/{run_id}/events", headers=headers)
    frames, cur, ended = [], {}, time.time() + deadline
    resp = urllib.request.urlopen(req, timeout=deadline)
    try:
        for raw in resp:
            line = raw.decode().rstrip("\n")
            if line.startswith("id: "):
                cur["id"] = int(line[4:])
            elif line.startswith("event: "):
                cur["event"] = line[7:]
            elif line == "":
                if "event" in cur:
                    frames.append(cur)
                    if "id" in cur:
                        print(f"    id={cur['id']:<5} {cur['event']}")
                    if stop_after and len([f for f in frames if "id" in f]) >= stop_after:
                        return frames, True
                cur = {}
            if time.time() > ended:
                return frames, False
    except Exception as e:  # noqa: BLE001
        print(f"    (stream ended: {type(e).__name__})")
    finally:
        resp.close()
    return frames, False


def main():
    status, health = call("GET", "/health")
    print(f"alineod {BASE} health={status}")
    if status != 200:
        sys.exit(f"daemon not reachable: {health}")

    print("\n1. starting a run")
    status, run = call("POST", "/runs", {
        "spec": spec("sse-reconnect-root", spawnDepth=1, maxAgents=2),
        "prompt": "Run `echo one && sleep 8 && echo two && sleep 8 && echo three` "
                  "with the bash tool, then reply DONE.",
    })
    if status not in (200, 202):
        sys.exit(f"POST /runs failed {status}: {run}")
    run_id = run["runId"]
    print(f"   runId={run_id} root={run['rootAgentId']}")

    print(f"\n2. leg 1 — reading until {DROP_AFTER} identified events, then dropping the socket")
    leg1, dropped = read_sse(run_id, stop_after=DROP_AFTER, deadline=180)
    ids1 = [f["id"] for f in leg1 if "id" in f]
    if not ids1:
        sys.exit("leg 1 saw no persisted events — cannot test reconnect")
    last_seen = ids1[-1]
    print(f"   dropped={dropped} after id={last_seen} ({len(ids1)} identified frames)")

    print(f"\n3. staying disconnected {GAP_SECONDS}s so events accumulate")
    time.sleep(GAP_SECONDS)

    print(f"\n4. leg 2 — reconnecting with Last-Event-ID: {last_seen}")
    leg2, _ = read_sse(run_id, last_event_id=last_seen, stop_after=DROP_AFTER + 6, deadline=180)
    ids2 = [f["id"] for f in leg2 if "id" in f]
    print(f"   {len(ids2)} identified frames on leg 2")

    print("\n5. full replay from scratch (the reference history)")
    full, _ = read_sse(run_id, stop_after=None, deadline=15)
    ids_full = [f["id"] for f in full if "id" in f]
    print(f"   {len(ids_full)} persisted events in the run's history")

    print("\n--- verdict ---")
    ok = True

    if ids2 and ids2[0] <= last_seen:
        print(f"FAIL  replay repeated an event: first id after reconnect {ids2[0]} <= {last_seen}")
        ok = False
    elif ids2:
        print(f"pass  no repeat: leg 2 starts at {ids2[0]}, after {last_seen}")
    else:
        print("FAIL  leg 2 received nothing")
        ok = False

    seen = ids1 + ids2
    if seen != sorted(seen):
        print(f"FAIL  ids out of order across the reconnect: {seen}")
        ok = False
    else:
        print("pass  ids monotonically increasing across the reconnect")

    expected = [i for i in ids_full if i <= max(seen)] if seen else []
    missing = [i for i in expected if i not in seen]
    if missing:
        print(f"FAIL  gap — persisted but never delivered: {missing}")
        ok = False
    else:
        print(f"pass  no gap: every persisted event up to {max(seen)} was delivered across the two legs")

    dupes = {i for i in seen if seen.count(i) > 1}
    if dupes:
        print(f"FAIL  duplicates delivered: {sorted(dupes)}")
        ok = False
    else:
        print("pass  no duplicates")

    print(f"\n{'PASS' if ok else 'FAIL'} — leg1={len(ids1)} leg2={len(ids2)} history={len(ids_full)}")
    call("DELETE", f"/runs/{run_id}")
    print("run deleted (ledger kept)")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
