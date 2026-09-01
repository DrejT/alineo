import { describe, expect, it } from "bun:test";
import type { CredentialBinding } from "@alineo-labs/core";
import { toWireAuth, toWireBinding, fromWireBindingMetadata } from "../src/broker.ts";

describe("toWireAuth", () => {
  it("maps { type: 'header' } to an apiKey wire auth carrying the credential name", () => {
    expect(toWireAuth("gh", { type: "header", name: "Authorization" })).toEqual({
      type: "apiKey",
      name: "Authorization",
      credential: "gh",
    });
  });

  it("maps { type: 'substitution' } to passthrough + one substitution entry", () => {
    expect(
      toWireAuth("oai", { type: "substitution", placeholder: "__OAI__", in: ["query", "path"] }),
    ).toEqual({
      type: "passthrough",
      substitutions: [{ credential: "oai", placeholder: "__OAI__", in: ["query", "path"] }],
    });
  });
});

describe("toWireBinding", () => {
  it("carries host + a trailing-glob path from pathPrefix", () => {
    const binding: CredentialBinding = {
      host: "api.github.com",
      pathPrefix: "/repos/",
      injection: { type: "header", name: "Authorization" },
    };
    expect(toWireBinding("gh", binding)).toEqual({
      name: "gh",
      match: { hosts: ["api.github.com"], paths: ["/repos/*"] },
      auth: { type: "apiKey", name: "Authorization", credential: "gh" },
    });
  });
});

describe("fromWireBindingMetadata", () => {
  it("round-trips a header binding this package created", () => {
    const binding: CredentialBinding = {
      host: "api.github.com",
      injection: { type: "header", name: "Authorization" },
    };
    const meta = { match: toWireBinding("gh", binding).match, auth: { type: "apiKey", name: "Authorization" } };
    expect(fromWireBindingMetadata(meta)).toEqual(binding);
  });

  it("recovers host + a substitution shape for a passthrough binding (placeholder/in are lossy)", () => {
    expect(
      fromWireBindingMetadata({ match: { hosts: ["api.example.com"] }, auth: { type: "passthrough" } }),
    ).toEqual({
      host: "api.example.com",
      injection: { type: "substitution", placeholder: "", in: [] },
    });
  });

  it("throws UnsupportedInjectionError for an auth type another client created", () => {
    expect(() =>
      fromWireBindingMetadata({ match: { hosts: ["x"] }, auth: { type: "bearer" } }),
    ).toThrow("bearer");
  });
});
