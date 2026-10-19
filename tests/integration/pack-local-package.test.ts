import { describe, expect, test } from "bun:test";
import { MAX_STEP_BASE64, tarballWriteSteps } from "../../scripts/pack-local-package.ts";

const pkg = (base64: string) => ({
  name: "@alineo-labs/demo",
  version: "1.2.3",
  remotePath: "/tmp/alineo-labs-demo-1.2.3.tgz",
  base64,
});

describe("tarballWriteSteps", () => {
  test("a small tarball is one heredoc, as before", () => {
    const steps = tarballWriteSteps(pkg("QUJD"));

    expect(steps).toHaveLength(1);
    expect(steps[0]?.run).toBe(
      "base64 -d <<'ALINEO_PKG__ALINEO_LABS_DEMO_EOF' > /tmp/alineo-labs-demo-1.2.3.tgz\nQUJD\nALINEO_PKG__ALINEO_LABS_DEMO_EOF",
    );
  });

  test("a tarball past the limit is written in parts and decoded at the end", () => {
    const b64 = "A".repeat(MAX_STEP_BASE64 * 2 + 10);

    const steps = tarballWriteSteps(pkg(b64));

    expect(steps).toHaveLength(4);
    expect(steps[0]?.run.startsWith("cat > /tmp/alineo-labs-demo-1.2.3.tgz.b64")).toBe(true);
    expect(steps[1]?.run.startsWith("cat >> /tmp/alineo-labs-demo-1.2.3.tgz.b64")).toBe(true);
    expect(steps[3]?.run).toBe(
      "base64 -d /tmp/alineo-labs-demo-1.2.3.tgz.b64 > /tmp/alineo-labs-demo-1.2.3.tgz && rm /tmp/alineo-labs-demo-1.2.3.tgz.b64",
    );
  });

  test("no step is anywhere near the size execd drops", () => {
    const steps = tarballWriteSteps(pkg("B".repeat(500_000)));

    for (const step of steps) expect(step.run.length).toBeLessThan(MAX_STEP_BASE64 + 500);
  });

  test("the parts, joined, are the original text", () => {
    const b64 = Buffer.from(crypto.getRandomValues(new Uint8Array(150_000))).toString("base64");

    const steps = tarballWriteSteps(pkg(b64));
    const joined = steps
      .slice(0, -1)
      .map((s) => s.run.split("\n").slice(1, -1).join("\n"))
      .join("");

    expect(joined).toBe(b64);
  });
});
