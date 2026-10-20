# ADR 0013 — Internal Matomo servers are allowed by name

Status: accepted
Date: 2026-10-20
Phase: after 10 (handover to the operating team)

## Context

The SSRF guard (Master Spec §19) refuses every Matomo address that resolves
into a private network unless the installation runs in `development` or
`test`. A connection URL is customer input; without the guard, "connect your
Matomo" lets anyone make the server reach whatever sits inside the network,
including cloud metadata services.

A company that runs the platform next to its own Matomo usually has that Matomo
on an internal address. Outside development it could not be connected at all -
a blocker for the first pilot.

## Decision

1. **The operator names internal Matomo servers in configuration:**
   `MATOMO_ALLOWED_PRIVATE_HOSTS`, comma-separated. Customers and tenant
   administrators cannot change it; it is part of the deployment.
2. **Exact entries only.** Each entry is a host name or an address literal,
   matched case-insensitively against the host of the connection URL. Wildcards,
   ranges, schemes and ports are refused at startup - an entry can never open
   more than one host.
3. **A named host may reach the company network, nothing more.** It may resolve
   into RFC 1918 ranges, carrier-grade NAT (100.64/10) and IPv6 unique local
   addresses. Loopback, link-local, unspecified, multicast and the metadata
   addresses stay refused even for a named host; `localhost` stays refused by
   name.
4. **Everything else is unchanged.** Hosts not named are refused as before,
   redirects stay forbidden (`redirect: 'error'`), credentials in URLs stay
   refused, and development keeps its permissive mode.
5. **Diagnostics report how many hosts are named, not which** - host names
   describe the internal network.

## Consequences

- Connecting an internal Matomo is a deployment step: add its host name, restart
  API and worker.
- The guard still checks resolved addresses before the request; the request
  itself resolves the name again. A name that can be repointed between the two
  lookups (DNS rebinding) is the operator's to control - internal names in the
  company's own DNS are.
