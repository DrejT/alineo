import { describe, expect, it } from "bun:test";
import { fetchPublicJson, isPublicAddress, PublicFetchError } from "../src/public-fetch.js";
import { stubFetch } from "./fetch-stub.js";
import { expectRejects } from "./assertions.js";

describe("isPublicAddress", () => {
  it("refuses private, loopback, link-local and reserved IPv4", () => {
    for (const ip of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "127.255.255.254",
      "169.254.169.254", // cloud metadata
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "192.0.2.5",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it("allows public IPv4, including the edges of the private ranges", () => {
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "172.15.255.255",
      "172.32.0.1",
      "100.63.255.255",
      "11.0.0.1",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it("refuses loopback, unique-local, link-local, multicast and mapped-private IPv6", () => {
    for (const ip of [
      "::",
      "::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:7f00:1",
      "2001:db8::1",
      "2001::1",
      "2002:7f00:1::",
      "64:ff9b::7f00:1",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it("allows global unicast IPv6 and a mapped public IPv4", () => {
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicAddress("2a00:1450:4001:81b::200e")).toBe(true);
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
  });

  it("treats anything unparseable as not public", () => {
    for (const ip of ["", "example.com", "1.2.3", "1.2.3.4.5", "999.1.1.1", "::g", "1::2::3"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
});

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });
const publicDns = async () => ["93.184.216.34"];

describe("fetchPublicJson", () => {
  it("fetches and parses JSON from a public https host", async () => {
    const fetchImpl = stubFetch(async () => json({ name: "x" }));
    const out = await fetchPublicJson("https://example.com/spec.json", {
      resolve: publicDns,
      fetchImpl,
    });
    expect(out).toEqual({ name: "x" });
  });

  it("asks fetch not to follow redirects itself", async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = stubFetch(async (_url, init) => {
      seen = init;
      return json({});
    });
    await fetchPublicJson("https://example.com/a", { resolve: publicDns, fetchImpl });
    expect(seen?.redirect).toBe("manual");
  });

  it("refuses http, other ports, credentials and a bad URL", async () => {
    const opts = { resolve: publicDns, fetchImpl: stubFetch(async () => json({})) };
    for (const url of [
      "http://example.com/a",
      "https://example.com:8443/a",
      "https://user:pw@example.com/a",
      "file:///etc/passwd",
      "/etc/passwd",
      "not a url",
    ]) {
      const err = await expectRejects(fetchPublicJson(url, opts));
      expect(err, url).toBeInstanceOf(PublicFetchError);
    }
  });

  it("never calls fetch for a refused URL", async () => {
    const fetchImpl = stubFetch(async () => json({}));
    await expectRejects(fetchPublicJson("https://127.0.0.1/a", { resolve: publicDns, fetchImpl }));
    await expectRejects(fetchPublicJson("https://[::1]/a", { resolve: publicDns, fetchImpl }));
    await expectRejects(fetchPublicJson("https://localhost/a", { resolve: publicDns, fetchImpl }));
    await expectRejects(
      fetchPublicJson("https://db.internal/a", { resolve: publicDns, fetchImpl }),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a name that resolves to a private address, even when another answer is public", async () => {
    const fetchImpl = stubFetch(async () => json({}));
    const resolve = async () => ["93.184.216.34", "10.0.0.5"];
    const err = await expectRejects(
      fetchPublicJson("https://rebind.example/a", { resolve, fetchImpl }),
    );
    expect((err as Error).message).toContain("not public");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("checks every redirect hop, so a public host cannot bounce to a private one", async () => {
    const fetchImpl = stubFetch(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/latest" },
        }),
    );
    const err = await expectRejects(
      fetchPublicJson("https://example.com/a", { resolve: publicDns, fetchImpl }),
    );
    expect((err as Error).message).toContain("not public");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect to another public host, including a relative one", async () => {
    let calls = 0;
    const fetchImpl = stubFetch(async (url) => {
      calls++;
      return calls === 1
        ? new Response(null, { status: 301, headers: { location: "/spec.json" } })
        : json({ at: String(url) });
    });
    const out = await fetchPublicJson("https://example.com/old", { resolve: publicDns, fetchImpl });
    expect(out).toEqual({ at: "https://example.com/spec.json" });
  });

  it("stops after too many redirects", async () => {
    const fetchImpl = stubFetch(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://example.com/again" } }),
    );
    const err = await expectRejects(
      fetchPublicJson("https://example.com/a", { resolve: publicDns, fetchImpl, maxRedirects: 2 }),
    );
    expect((err as Error).message).toContain("redirects");
  });

  it("refuses a body over the cap, declared or streamed", async () => {
    const declared = stubFetch(
      async () => new Response("{}", { status: 200, headers: { "content-length": "999999" } }),
    );
    await expectRejects(
      fetchPublicJson("https://example.com/a", {
        resolve: publicDns,
        fetchImpl: declared,
        maxBytes: 100,
      }),
    );
    const streamed = stubFetch(async () => new Response(JSON.stringify({ pad: "x".repeat(500) })));
    const err = await expectRejects(
      fetchPublicJson("https://example.com/a", {
        resolve: publicDns,
        fetchImpl: streamed,
        maxBytes: 100,
      }),
    );
    expect((err as Error).message).toContain("larger than 100");
  });

  it("reports a non-JSON body and an error status plainly", async () => {
    const notJson = stubFetch(async () => new Response("<html>"));
    expect(
      (
        (await expectRejects(
          fetchPublicJson("https://example.com/a", { resolve: publicDns, fetchImpl: notJson }),
        )) as Error
      ).message,
    ).toContain("not JSON");
    const notFound = stubFetch(
      async () => new Response("", { status: 404, statusText: "Not Found" }),
    );
    expect(
      (
        (await expectRejects(
          fetchPublicJson("https://example.com/a", { resolve: publicDns, fetchImpl: notFound }),
        )) as Error
      ).message,
    ).toContain("404");
  });

  it("does not put the target's error text, or an internal address, in the message", async () => {
    const fetchImpl = stubFetch(async () => {
      throw new Error("connect ECONNREFUSED 10.1.2.3:443");
    });
    const err = (await expectRejects(
      fetchPublicJson("https://example.com/a", { resolve: publicDns, fetchImpl }),
    )) as Error;
    expect(err.message).not.toContain("10.1.2.3");
  });
});
