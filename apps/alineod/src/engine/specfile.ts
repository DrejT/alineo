/**
 * The SDK's `Alineo.prototype.spawn()` takes a spec *path*, not an object (see #184 / the
 * factory). alineod accepts spec objects over HTTP, so it writes them into its own working
 * dir and hands the path down. (D-b in research/daemon.md — "accept the object, own the dir".)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORK_DIR } from "../../config";

const SPEC_DIR = join(WORK_DIR, "specs");
mkdirSync(SPEC_DIR, { recursive: true });

export function writeSpecFile(agentId: string, spec: unknown): string {
  const p = join(SPEC_DIR, `${agentId}.json`);
  writeFileSync(p, JSON.stringify(spec, null, 2));
  return p;
}
