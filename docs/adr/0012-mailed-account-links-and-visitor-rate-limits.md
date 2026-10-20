# ADR 0012 — Mailed account links, and rate limits that count visitors

Status: accepted
Date: 2026-10-04
Phase: 10 (MVP Hardening and Acceptance)

## Context

Master Spec §6 lists "Invite und Recovery" for the MVP, and §12 asks that a
local account's address change needs re-authentication and verification.
DEV-005 had deferred the address change and mailed invitations until a mail
transport existed; Phase 10 found that self-service password recovery had not
been built at all. Hardening also showed that the API's rate limits counted
the connection address - and every browser request reaches the API through
the web server, so all visitors shared one bucket per route.

## Decision

1. **Account links are single-use, expiring and stored as hashes.** Invitations
   (72 h), password resets (60 min) and address confirmations (24 h) are each a
   row identified by the SHA-256 of a random token. The plain token exists only
   in the mail.
2. **Mail goes through the durable job queue, ids only (ADR 0010).** The job is
   `account.mail` with `{ purpose, recordId }`. Until the mail is sent the
   record keeps the token encrypted with the credential key, bound to the
   record id as associated data; after sending it is removed. A replaced or
   used link is not sent at all.
3. **Recovery does not enumerate.** `POST /auth/password-reset` answers 202
   with the same body for every address, before any lookup, and does its work
   afterwards. Only an active account with a local password gets a link; at
   most three per hour. A reset applies the password rules and history and ends
   every session of the account.
4. **An address change is proven by the new mailbox.** It needs the current
   password; the new address receives the link, the old one a notice without
   it. Until confirmed, sign-in keeps using the old address, and the change can
   be cancelled. Confirmation is a deliberate click, not opening the link, so a
   mail scanner cannot complete it. Addresses an identity provider manages are
   not changed here.
5. **Tokens never travel in a URL the server logs.** Pages receive the token in
   their address (it is in the mail), but every API call carries it in the
   body; invitation inspection moved from `GET /invitations/:token` to
   `POST /invitations/inspect`. Request logs record method, path without query
   and status.
6. **Rate limits count the party that acts.** A signed-in request counts per
   session; an anonymous one by the visitor's address, which the web server
   states in `x-axp-client-address`. The API believes that header only from
   the addresses in `API_TRUSTED_PROXIES` (default: loopback).
7. **Sign-in lockouts use the visitor too.** The brute-force protection locked
   both the account and the address after five failures - and the address was
   the web server's, so five mistyped passwords anywhere locked everyone out.
   It now counts the visitor's address, and an address is locked only after 50
   failures (a whole company can share one), while an account still locks after
   five.

## Consequences

- A deployment needs the web server's address in `API_TRUSTED_PROXIES`, and a
  reverse proxy in front of the web server that sets `X-Forwarded-For`; without
  it, a visitor could choose the address they are counted under (classified
  Production Readiness).
- Losing the credential key while a mail is queued loses that mail; the person
  requests a new link. Nothing else depends on it.
- Unexpected rendering errors now show a localized page with a reference
  number (`app/error.tsx`), instead of the framework's English default.
