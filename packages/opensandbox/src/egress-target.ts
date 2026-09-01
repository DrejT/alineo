// Validation for `NetworkRule.target` values — mirrors the egress sidecar's own parse order
// (`components/egress/pkg/policy/policy.go` `normalizePolicy`): try bare IP, then CIDR, then
// treat it as a domain. We reject only strings that could not be any of the three, so a
// malformed `networkPolicy` fails locally instead of on a server round-trip.

const IPV4_OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = `${IPV4_OCTET}(\\.${IPV4_OCTET}){3}`;
// Deliberately permissive IPv6 — full RFC 4291 is not worth reproducing; this catches the
// common forms and obvious garbage. The server is the authority.
const IPV6 = "([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}";

const ipv4Re = new RegExp(`^${IPV4}$`);
const ipv6Re = new RegExp(`^${IPV6}$`);

/** A single DNS label: alphanumeric plus internal hyphens, 1–63 chars. */
const LABEL = "(?!-)[A-Za-z0-9-]{1,63}(?<!-)";
// A domain, optionally with a single leading `*.` wildcard (the sidecar's only wildcard form).
const domainRe = new RegExp(`^(\\*\\.)?(${LABEL}\\.)*${LABEL}\\.?$`);

function isIpAddress(s: string): boolean {
  return ipv4Re.test(s) || ipv6Re.test(s);
}

function isCidr(s: string): boolean {
  const slash = s.lastIndexOf("/");
  if (slash === -1) return false;
  const addr = s.slice(0, slash);
  const bits = s.slice(slash + 1);
  if (!/^\d{1,3}$/.test(bits)) return false;
  const n = Number(bits);
  if (ipv4Re.test(addr)) return n <= 32;
  if (ipv6Re.test(addr)) return n <= 128;
  return false;
}

/**
 * Returns whether `target` is a usable `NetworkRule.target`: an FQDN, a `*.`-prefixed
 * wildcard domain, a bare IPv4/IPv6 address, or a CIDR block. Whitespace-only, URL-shaped
 * (`http://…`), or otherwise malformed strings return `false`.
 */
export function isValidEgressTarget(target: string): boolean {
  const t = target.trim(); // the sidecar trims too (policy.go normalizePolicy)
  if (t === "") return false;
  if (isIpAddress(t)) return true;
  if (isCidr(t)) return true;
  return domainRe.test(t);
}
