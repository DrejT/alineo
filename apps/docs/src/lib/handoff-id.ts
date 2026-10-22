/**
 * The landing page (alineo.tech) adds `?ph_id=<anonymous PostHog ID>` to links that point here, so
 * one visitor stays one person across both sites without a cookie.
 */

/** Query parameter name. Keep in step with `HANDOFF_PARAM` in the landing page's analytics.ts. */
const HANDOFF_PARAM = "ph_id";

/** PostHog anonymous IDs are UUIDs. Accept only that shape, so a crafted link cannot inject
 * arbitrary text into analytics. */
const ID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Returns the handed-off ID, or undefined when it is missing or malformed. */
export function readHandoffId(search: string): string | undefined {
  const id = new URLSearchParams(search).get(HANDOFF_PARAM);
  return id !== null && ID_SHAPE.test(id) ? id : undefined;
}

/** Returns `search` and `hash` without the handoff parameter, for `history.replaceState`. */
export function stripHandoffParam(pathname: string, search: string, hash: string): string {
  const params = new URLSearchParams(search);
  params.delete(HANDOFF_PARAM);
  const rest = params.toString();
  return `${pathname}${rest ? `?${rest}` : ""}${hash}`;
}
