# ADR 0003 — Bootstrap through a one-time token, never a default account

- Status: accepted
- Date: 2026-09-18
- Milestone: F0
- Specification reference: Master Spec §6, Gap Review G4, Acceptance checklist D

## Context

Gap Review G4 requires a persistent `UNINITIALIZED → INITIALIZED` state, no
default accounts or passwords, a short-lived cryptographically secure one-time
activation token, a setup path that closes permanently, and a separate audited
break-glass recovery path.

The design question was where the first credential comes from.

## Decision

`npm run bootstrap-admin` is a privileged local process that mints a token and
prints it to stdout. It creates no account. The operator opens the printed URL
and chooses the address and password in the browser; that request creates the
first platform admin inside a single transaction which re-reads the platform
state row `FOR UPDATE`.

Only a SHA-256 hash of the token is stored. Re-running the command invalidates
any previously issued, unconsumed token.

Break-glass recovery uses the same mechanism with a different token purpose, a
different route, a different audit action, and works only on an already
initialized platform.

## Consequences

Positive:

- There is no moment at which a known credential exists, so there is nothing to
  leak, forget to change, or find in a fixture.
- Concurrent bootstrap attempts cannot both succeed; the second finds the
  platform initialized.
- A database read never yields a usable token.
- Losing every platform admin does not reopen setup, which would otherwise be a
  trivial takeover path on an internet-reachable instance.

Negative:

- Bootstrap requires shell access to the deployment. That is intended: it is the
  privilege boundary.
- The operator must copy a URL from a terminal into a browser.

## Alternatives considered

**CLI creates the account directly, prompting for a password.** Simpler, but a
password typed into a terminal ends up in shell history and in process listings,
and the flow cannot be driven by an orchestrator that has no TTY.

**Environment variable with an initial admin password.** Common and convenient,
but it puts a real credential into deployment configuration, which is precisely
what G4 rules out.
