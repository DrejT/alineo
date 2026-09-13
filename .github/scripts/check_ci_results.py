#!/usr/bin/env python3

"""Fail the terminal CI job unless every dependency succeeded.

The `required` job passes GitHub's `toJSON(needs)` through the NEEDS
environment variable. Skipped and cancelled dependencies count as failures by
default: for a fan-in job that branch protection requires, only an explicit
success is safe to accept.

SKIPPABLE is a comma-separated allowlist of dependencies whose `skipped` result
is expected — a job with an `if:` condition that legitimately does not apply to
every event. A skipped dependency outside that list still fails, and a listed
dependency that fails outright still fails.
"""

import json
import os


def main() -> None:
    needs = json.loads(os.environ["NEEDS"])
    skippable = {
        name.strip() for name in os.environ.get("SKIPPABLE", "").split(",") if name.strip()
    }

    failures = []
    for name, dependency in sorted(needs.items()):
        result = dependency["result"]
        if result == "success":
            continue
        if result == "skipped" and name in skippable:
            print(f"{name}: skipped (allowed)")
            continue
        failures.append((name, result))

    if failures:
        print("CI dependencies did not succeed:")
        for name, result in failures:
            print(f"{name}: {result}")
        raise SystemExit(1)

    print("All CI dependencies succeeded.")


if __name__ == "__main__":
    main()
