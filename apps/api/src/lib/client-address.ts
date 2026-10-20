import type { FastifyRequest } from 'fastify';

/** Carries the visitor's address from the web server to the API. */
export const CLIENT_ADDRESS_HEADER = 'x-axp-client-address';

/**
 * The address of the person behind a request.
 *
 * Every browser request reaches the API through the web server, so the
 * connection address is the web server's. The web server states the
 * visitor's address in a header, which counts only when the connection comes
 * from a trusted proxy (`API_TRUSTED_PROXIES`); anyone else is taken at their
 * own address. Sign-in lockouts and rate limits use this - counting the web
 * server would let a few mistyped passwords lock everyone out.
 */
export function clientAddress(request: FastifyRequest, trustedProxies: readonly string[]): string {
  const peer = request.socket?.remoteAddress ?? request.ip;
  const stated = request.headers[CLIENT_ADDRESS_HEADER];
  if (
    typeof stated === 'string' &&
    stated.length > 0 &&
    stated.length <= 64 &&
    /^[0-9a-fA-F:.]+$/.test(stated) &&
    trustedProxies.includes(peer)
  ) {
    return stated;
  }
  return peer;
}
