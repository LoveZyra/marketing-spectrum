/**
 * ip-guard: pure, unit-testable IP classification used by SSRF guards
 * (server/routes/documents.js fetch-url). No I/O — string in, boolean out.
 *
 * isPrivateIp(address) returns true when the address must NOT be dialed by an
 * outbound fetch on the user's behalf: loopback, RFC 1918, link-local (incl.
 * cloud metadata 169.254.169.254), CGNAT, benchmarking, documentation/TEST-NET
 * ranges, multicast, reserved and unspecified space — for both IPv4 and IPv6.
 * IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) IPv6 forms recurse
 * into the embedded IPv4 address so a private v4 target cannot hide inside a
 * v6 literal. The deprecated IPv4-compatible range (::/96) is blocked outright
 * — it is IETF-reserved, never legitimately dialed, and includes :: and ::1.
 * Anything unparseable is treated as private (fail closed).
 */

import net from 'net';

/**
 * Strict dotted-quad IPv4 parse: exactly four decimal octets 0-255, no
 * shorthand ("127.1") and no leading zeros ("010.0.0.1" — some stacks parse
 * that as octal, so it is rejected outright). Returns [a,b,c,d] or null.
 */
export function parseIPv4(address) {
  if (typeof address !== 'string') return null;
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

const ipv4ToInt = (octets) =>
  (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);

// [base, prefixBits] — every IPv4 range an SSRF guard must refuse to dial.
const PRIVATE_V4_RANGES = [
  ['0.0.0.0', 8],       // "this network" (RFC 791)
  ['10.0.0.0', 8],      // RFC 1918 private
  ['100.64.0.0', 10],   // CGNAT shared address space (RFC 6598)
  ['127.0.0.0', 8],     // loopback
  ['169.254.0.0', 16],  // link-local, incl. cloud metadata endpoints
  ['172.16.0.0', 12],   // RFC 1918 private
  ['192.0.0.0', 24],    // IETF protocol assignments (RFC 6890)
  ['192.0.2.0', 24],    // TEST-NET-1 documentation
  ['192.168.0.0', 16],  // RFC 1918 private
  ['198.18.0.0', 15],   // benchmarking (RFC 2544)
  ['198.51.100.0', 24], // TEST-NET-2 documentation
  ['203.0.113.0', 24],  // TEST-NET-3 documentation
  ['224.0.0.0', 4],     // multicast
  ['240.0.0.0', 4],     // reserved (RFC 1112) — includes 255.255.255.255
].map(([base, bits]) => {
  const mask = (~0 << (32 - bits)) >>> 0;
  return { base: (ipv4ToInt(parseIPv4(base)) & mask) >>> 0, mask };
});

/**
 * True when the IPv4 address (dotted-quad string or [a,b,c,d] array) is
 * private/reserved/unroutable. Fails closed on malformed input.
 */
export function isPrivateIPv4(address) {
  const octets = Array.isArray(address) ? address : parseIPv4(address);
  if (
    !octets
    || octets.length !== 4
    || !octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  ) {
    return true; // fail closed
  }
  const value = ipv4ToInt(octets);
  if (value === 0xffffffff) return true; // limited broadcast (inside 240/4, listed for clarity)
  return PRIVATE_V4_RANGES.some(({ base, mask }) => ((value & mask) >>> 0) === base);
}

/**
 * Expand an IPv6 string into its eight 16-bit groups. Handles `::`
 * compression, an embedded dotted-quad tail (::ffff:127.0.0.1), a zone-id
 * suffix (%eth0) and surrounding brackets. Returns number[8] or null.
 */
export function expandIPv6(address) {
  if (typeof address !== 'string') return null;
  let addr = address.trim().toLowerCase();
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  const zoneIndex = addr.indexOf('%');
  if (zoneIndex !== -1) addr = addr.slice(0, zoneIndex);
  if (addr.length === 0) return null;

  // Convert an embedded IPv4 tail into the equivalent two hex groups.
  const lastColon = addr.lastIndexOf(':');
  if (lastColon === -1) return null;
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part) => (part === '' ? [] : part.split(':'));
  let groups;
  if (halves.length === 2) {
    const head = groupsOf(halves[0]);
    const rest = groupsOf(halves[1]);
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null; // "::" must stand for at least one group
    groups = [...head, ...new Array(missing).fill('0'), ...rest];
  } else {
    groups = groupsOf(addr);
  }
  if (groups.length !== 8) return null;

  const out = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    out.push(Number.parseInt(group, 16));
  }
  return out;
}

/**
 * True when the IPv6 address is private/reserved/unroutable. Embedded-IPv4
 * forms defer to isPrivateIPv4. Fails closed on parse errors.
 */
export function isPrivateIPv6(address) {
  const g = expandIPv6(address);
  if (!g) return true; // fail closed
  const embeddedV4 = () => [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
  const firstFiveZero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;

  if (g.every((group) => group === 0)) return true; // :: unspecified
  if (firstFiveZero && g[5] === 0 && g[6] === 0 && g[7] === 1) return true; // ::1 loopback
  if (firstFiveZero && g[5] === 0xffff) return isPrivateIPv4(embeddedV4()); // ::ffff:0:0/96 IPv4-mapped — recurse into embedded v4
  // ::/96 deprecated IPv4-compatible: IETF-reserved, never legitimately routable —
  // block the whole range rather than recursing (covers ::, ::1 and e.g. ::8.8.8.8).
  if (firstFiveZero && g[5] === 0) return true;
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isPrivateIPv4(embeddedV4()); // 64:ff9b::/96 NAT64 well-known prefix
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0x0001) return true; // 64:ff9b:1::/48 local-use NAT64 (RFC 8215)
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (fc00–fdff)
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local (fe80–febf)
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local (fec0–feff)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * True when `address` must not be dialed by an SSRF-guarded fetch. Accepts
 * IPv4 or IPv6 literals (optionally bracketed and/or zone-qualified). Anything
 * net.isIP does not recognize is treated as private (fail closed).
 */
export function isPrivateIp(address) {
  if (typeof address !== 'string' || address.length === 0) return true;
  let candidate = address.trim();
  if (candidate.startsWith('[') && candidate.endsWith(']')) candidate = candidate.slice(1, -1);
  const zoneIndex = candidate.indexOf('%');
  const bare = zoneIndex === -1 ? candidate : candidate.slice(0, zoneIndex);
  const version = net.isIP(bare);
  if (version === 4) return isPrivateIPv4(bare);
  if (version === 6) return isPrivateIPv6(bare);
  return true; // not a recognizable IP literal — fail closed
}
