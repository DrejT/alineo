// Validation for `NetworkRule.target` values — mirrors the egress sidecar's own parse order
// (`components/egress/pkg/policy/policy.go` `normalizePolicy`): try bare IP, then CIDR, then
// treat it as a domain. This is a fast local guard against an obviously-malformed policy, not
// a re-implementation of `net/netip` — it errs toward accepting: the server is the authority,
// and a false rejection here is worse than the round-trip the guard exists to save.

const IPV4_OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const ipv4Re = new RegExp(`^${IPV4_OCTET}(\\.${IPV4_OCTET}){3}$`);

// Permissive IPv6: anything made of hex groups + colons, optionally with a trailing
// dotted-quad (IPv4-mapped forms like `::ffff:192.168.1.1`). Requires a `::` or ≥2 colons so
// a bare word can't match. Full RFC 4291 validation is the server's job.
const ipv6Re =
  /^(?=.*:)[0-9a-fA-F:]*(?::(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3})?$/;

/** A single DNS label: alphanumeric plus internal hyphens, 1–63 chars. */
const LABEL = "(?!-)[A-Za-z0-9-]{1,63}(?<!-)";
// A domain, optionally with a single leading `*.` wildcard (the sidecar's only wildcard form).
const domainRe = new RegExp(`^(\\*\\.)?(${LABEL}\\.)*${LABEL}\\.?$`);

function isIpv6(s: string): boolean {
  return (s.includes("::") || (s.match(/:/g)?.length ?? 0) >= 2) && ipv6Re.test(s);
}

function isIpAddress(s: string): boolean {
  return ipv4Re.test(s) || isIpv6(s);
}

function isCidr(s: string): boolean {
  const slash = s.lastIndexOf("/");
  if (slash === -1) return false;
  const addr = s.slice(0, slash);
  const bits = s.slice(slash + 1);
  if (!/^\d{1,3}$/.test(bits)) return false;
  const n = Number(bits);
  if (ipv4Re.test(addr)) return n <= 32;
  if (isIpv6(addr)) return n <= 128;
  return false;
}

/**
 * Returns whether `target` is a plausible `NetworkRule.target`: an FQDN, a `*.`-prefixed
 * wildcard domain, a bare IPv4/IPv6 address, or a CIDR block. Whitespace-only, URL-shaped
 * (`http://…`), space-containing, or otherwise clearly-malformed strings return `false`.
 */
export function isValidEgressTarget(target: string): boolean {
  const t = target.trim(); // the sidecar trims too (policy.go normalizePolicy)
  if (t === "" || /\s/.test(t) || t.includes("/") !== isCidr(t)) return false;
  if (isIpAddress(t)) return true;
  if (isCidr(t)) return true;
  return domainRe.test(t);
}
