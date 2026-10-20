import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { AppError } from '@axp/contracts';

/**
 * SSRF guard for outbound Matomo calls (Master Spec §19).
 *
 * Every outbound request goes through a controlled connection object, and the
 * URL in that object is customer input. Without this check, "connect to your
 * Matomo" becomes "make the server fetch anything reachable from inside the
 * network", including cloud metadata endpoints.
 *
 * Both the hostname and the address it resolves to are checked, because a
 * public name can point at a private address.
 */

export interface UrlGuardOptions {
  /**
   * Allows loopback and private ranges. Development only - a local Matomo is a
   * normal thing to develop against. Never enable outside development.
   */
  readonly allowPrivateNetwork: boolean;
  /**
   * Hosts the operator has named as internal Matomo servers
   * (`MATOMO_ALLOWED_PRIVATE_HOSTS`). Such a host - matched exactly, by name
   * or address literal - may resolve into the internal ranges (RFC 1918,
   * carrier-grade NAT, IPv6 unique local). Loopback, link-local, metadata
   * services and every host not named stay refused.
   */
  readonly allowedPrivateHosts?: readonly string[];
  /** Resolves a hostname to its addresses; replaceable in tests. */
  readonly resolve?: (hostname: string) => Promise<string[]>;
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

/** Cloud metadata services, reachable from most hosted environments. */
const BLOCKED_ADDRESSES = new Set(['169.254.169.254', 'fd00:ec2::254', '100.100.100.200']);

export async function assertSafeOutboundUrl(
  rawUrl: string,
  options: UrlGuardOptions,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw refuse('invalid_url', `Not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw refuse('unsupported_scheme', `Refused scheme ${url.protocol}`);
  }

  // Credentials in the URL would end up in logs and in the stored connection.
  if (url.username || url.password) {
    throw refuse('credentials_in_url', 'URL carries embedded credentials.');
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (!options.allowPrivateNetwork && BLOCKED_HOSTNAMES.has(hostname)) {
    throw refuse('blocked_host', `Refused hostname ${hostname}`);
  }

  const namedInternal = (options.allowedPrivateHosts ?? []).includes(hostname);
  // An address literal is its own answer; only names go to the resolver.
  const addresses =
    net.isIP(hostname) !== 0 ? [hostname] : await (options.resolve ?? resolveAddresses)(hostname);
  for (const address of addresses) {
    if (BLOCKED_ADDRESSES.has(address)) {
      throw refuse('blocked_address', `Refused metadata address ${address}`);
    }
    if (!options.allowPrivateNetwork && isPrivateAddress(address)) {
      // A host the operator named may live in the company network - never on
      // this machine, a link-local segment or a metadata service.
      if (!(namedInternal && isInternalNetworkAddress(address))) {
        throw refuse('private_address', `Refused private address ${address} for ${hostname}`);
      }
    }
  }

  return url;
}

async function resolveAddresses(hostname: string): Promise<string[]> {
  if (net.isIP(hostname) !== 0) return [hostname];
  try {
    const results = await lookup(hostname, { all: true, verbatim: true });
    return results.map((entry) => entry.address);
  } catch {
    // An unresolvable host is a connection problem, not a security decision;
    // the request will fail on its own with a clearer message.
    return [];
  }
}

/**
 * Ranges that must never be reachable from a customer-supplied URL: loopback,
 * RFC 1918, link-local, carrier-grade NAT, unique local addresses.
 */
export function isPrivateAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) {
    const parts = address.split('.').map(Number);
    const [a = 0, b = 0] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === '::1' || normalized === '::') return true;
    // Unique local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd]/.test(normalized)) return true;
    if (/^fe[89ab]/.test(normalized)) return true;
    // IPv4-mapped: check the embedded address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }
  return false;
}

/**
 * The ranges a company network uses for its servers: RFC 1918, carrier-grade
 * NAT and IPv6 unique local addresses. Deliberately narrower than
 * `isPrivateAddress`: loopback, link-local, unspecified and multicast are not
 * where an internal Matomo lives.
 */
export function isInternalNetworkAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (/^f[cd]/.test(normalized)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mapped?.[1]) return isInternalNetworkAddress(mapped[1]);
    return false;
  }
  return false;
}

function refuse(code: string, internalMessage: string): AppError {
  return new AppError('invalid_configuration', {
    code,
    messageKey: `matomo.url.${code}`,
    internalMessage,
  });
}
