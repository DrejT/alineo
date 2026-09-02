import { describe, expect, it } from "vitest";
import { isValidEgressTarget } from "../src/egress-target.ts";

describe("isValidEgressTarget", () => {
  it("accepts FQDNs and wildcard domains", () => {
    for (const t of [
      "api.github.com",
      "example.com",
      "a.b.c.d.example.co.uk",
      "*.openai.com",
      "*.a.b.example.com",
      "localhost",
      "host-with-hyphens.example.com",
      "trailing-dot.example.com.",
    ]) {
      expect(isValidEgressTarget(t), t).toBe(true);
    }
  });

  it("accepts bare IPv4/IPv6 and CIDR", () => {
    for (const t of [
      "10.0.0.5",
      "192.168.1.1",
      "255.255.255.255",
      "0.0.0.0",
      "10.0.0.0/8",
      "192.168.0.0/16",
      "172.16.0.0/12",
      "1.2.3.4/32",
      "::1",
      "2001:db8::1",
      "fe80::1/64",
      "2001:db8::/32",
      "::ffff:192.168.1.1", // IPv4-mapped IPv6 — the server accepts it
      "::ffff:192.168.1.0/120",
      "fe80::",
    ]) {
      expect(isValidEgressTarget(t), t).toBe(true);
    }
  });

  it("tolerates surrounding whitespace (the sidecar trims too)", () => {
    expect(isValidEgressTarget("  api.github.com  ")).toBe(true);
  });

  it("rejects malformed targets", () => {
    for (const t of [
      "",
      "   ",
      "http://api.github.com",
      "api.github.com/path",
      "api.github.com:443",
      "a b",
      "*.*.com",
      "*",
      "10.0.0.0/33",
      "10.0.0.0/999",
      "-leadinghyphen.com",
      "trailinghyphen-.com",
      "foo:bar", // single colon, not an IPv6
    ]) {
      expect(isValidEgressTarget(t), t).toBe(false);
    }
  });
});
