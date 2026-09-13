#!/usr/bin/env python3

"""Fail the terminal CI job unless every dependency succeeded.

`blocking-ci` passes GitHub's `toJSON(needs)` through the NEEDS environment
variable. Skipped and cancelled dependencies count as failures: for a fan-in job
that branch protection requires, only an explicit success is safe to accept.
"""

import json
import os


def main() -> None:
    needs = json.loads(os.environ["NEEDS"])
    failures = sorted(
        (name, dependency["result"])
        for name, dependency in needs.items()
        if dependency["result"] != "success"
    )

    if failures:
        print("CI dependencies did not succeed:")
        for name, result in failures:
            print(f"{name}: {result}")
        raise SystemExit(1)

    print("All CI dependencies succeeded.")


if __name__ == "__main__":
    main()
