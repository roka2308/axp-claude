# ADR 0010 — Durable jobs, scheduled reports and a grouped Attention Center

Status: accepted
Date: 2026-10-03
Phase: 8 (Scheduled Reporting and Attention Center)

## Context

Master Spec §15 and Shared Contract §12 ask for scheduled reports that use the
Published Runtime, relative periods with an explicit time zone, recipient
permissions and retry/status, and for an operational, role-aware, grouped
Attention Center - in-app first, selective mail. The development plan asks for
a `JobQueue` with reliable claim, retry, fail and complete. Gate F8 adds that a
suspended or offboarding tenant stops reports, shares and customer jobs.

## Decision

1. **The job queue is a MySQL table with leases.** `jobs` holds kind, payload,
   status, attempts and a lease (`locked_by`, `locked_until`). Workers claim
   with `SELECT … FOR UPDATE SKIP LOCKED`, so several workers can run without
   double-taking a job. A failure is retried after 1, 5 and 15 minutes, then
   the job is `dead`; a non-retryable failure is `failed` at once. Expired
   leases return to the queue. A `dedupe_key` makes enqueueing idempotent.
   Payloads are validated per kind and hold ids only - never analytics data.
2. **A schedule is configuration; a run is status.** `report_schedules` names
   a dashboard, a relative period, a comparison, a rhythm (daily, weekly,
   monthly, quarterly, chosen weekdays) in an explicit IANA time zone, a
   format, a delivery mode and recipient user ids. `report_runs` records each
   occurrence: when it was due, the published version it read, the period
   dates, how many were reached and who was left out and why. Neither stores a
   number from the report.
3. **Every run re-decides.** At run time the worker checks the tenant's
   lifecycle, the dashboard's publication, the owner's access and every
   recipient's access (role and grant, ADR 0006). Recipients without access
   are left out and named in the run; the owner is told. The run reads the
   latest published version - never a draft.
4. **The period is relative to when the run was due.** The presentation
   builder takes a reference moment (`at`); the period is resolved against it
   in the site's calendar and pinned to dates for the engine. A retry an hour
   later describes the same days. The schedule's time zone decides _when_ it
   runs; the site's decides the analytics calendar.
5. **Stopped tenants stop.** The scheduler records a due occurrence of a
   suspended or offboarding tenant as `skipped` and enqueues nothing; a job
   queued before the suspension is cancelled when claimed; the API refuses
   "send now"; shares were already resolved per request (ADR 0009).
6. **Two delivery modes.** `attachment` renders the file in the worker and
   mails it - one mail per recipient, nothing written to disk. `link` mails a
   link into the product; the recipient signs in and sees the dashboard under
   their own rights, and nothing is rendered or stored.
7. **PPTX by schedule waits for its stability gate.** `REPORTS_PPTX_ENABLED`
   (off by default) decides whether schedules may choose PPTX; manual PPTX
   exports are unaffected.
8. **Attention items are grouped problems, routed by capability.** An item is
   identified by a group key (kind and subject). Seeing the problem again
   raises its count and `last_seen_at`; seeing it gone resolves it; a resolved
   or acknowledged problem that returns is open again. Who sees an item is
   decided by an audience capability in the item's project or tenant, plus an
   owner when one person is concerned. Only `action_required` items with an
   owner are mailed, once per group. The kinds are a closed, operational list
   - report failed, recipients without access, link expiring, mapping to
     review, account unused - with no field or route for metric thresholds.

## Consequences

- No new infrastructure: the queue runs on the product store the platform
  already operates, which is enough for scheduled reporting's volume.
- A worker crash costs at most one lease period; nothing is lost.
- A recipient who leaves the organisation or loses a grant stops receiving
  reports without anyone editing the schedule.
- The Attention Center cannot become analytics alerting by accident: the
  database enum, the contract and a gate step pin its kinds.
