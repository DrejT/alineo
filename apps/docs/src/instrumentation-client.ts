/**
 * Runs in the browser before the app is interactive (Next's `instrumentation-client` convention).
 * Initializes PostHog for the docs site.
 *
 * Off unless `NEXT_PUBLIC_POSTHOG_KEY` was set at build time, so `next dev` and preview builds
 * send nothing. The key is a write-only project key, not a secret.
 *
 * Plan: plans/20-10-2026/posthog-telemetry-forward.md (Phase B)
 */
import posthog from "posthog-js";
import { readHandoffId, stripHandoffParam } from "./lib/handoff-id";

const INTERNAL_FLAG = "alineo_internal";

/** Visit any page once with `?ph_internal=1` to mark this browser as the maintainer's, and
 * `?ph_internal=0` to undo it. Events then carry `internal: true`, so PostHog can filter them out.
 * Cloudflare Web Analytics has no such switch. */
function isInternalBrowser(): boolean {
  try {
    const param = new URLSearchParams(window.location.search).get("ph_internal");
    if (param === "1") localStorage.setItem(INTERNAL_FLAG, "1");
    if (param === "0") localStorage.removeItem(INTERNAL_FLAG);
    return localStorage.getItem(INTERNAL_FLAG) === "1";
  } catch {
    // Storage can be blocked (private window, site data cleared). Treat the visit as external.
    return false;
  }
}

/** The landing page (alineo.tech) adds `?ph_id=<anonymous ID>` to links that point here. Use it
 * only for a browser with no PostHog ID yet, so a returning visitor keeps their own history, and
 * drop it from the address bar so a copied URL does not carry someone else's ID. */
function takeHandoffId(projectKey: string): string | undefined {
  try {
    const id = readHandoffId(window.location.search);
    if (!id) return undefined;
    const { pathname, search, hash } = window.location;
    window.history.replaceState(window.history.state, "", stripHandoffParam(pathname, search, hash));
    // posthog-js keeps its state under `ph_<key>_posthog`; a stored ID means a returning visitor.
    return localStorage.getItem(`ph_${projectKey}_posthog`) === null ? id : undefined;
  } catch {
    return undefined;
  }
}

const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;

if (key) {
  try {
    const handoffId = takeHandoffId(key);
    posthog.init(key, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
      // Docs visitors stay anonymous: no person profile until someone is identified, and nothing
      // here ever identifies anyone.
      person_profiles: "identified_only",
      // The docs are a static export that navigates on the client, so a page load alone misses
      // most pageviews.
      capture_pageview: "history_change",
      capture_pageleave: true,
      respect_dnt: true,
      disable_session_recording: true,
      ...(handoffId ? { bootstrap: { distinctID: handoffId } } : {}),
      loaded: (ph) => {
        if (isInternalBrowser()) ph.register({ internal: true });
      },
    });
  } catch {
    // Analytics must never break the docs.
  }
}
