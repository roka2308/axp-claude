import { z } from 'zod';
import { TIME_RANGE_PRESETS, type TimeRangePreset } from './analytics';

/**
 * Scheduled reporting (Master Spec §15, Shared Contract §12).
 *
 * A report schedule references a published dashboard, a relative period, an
 * explicit time zone, a format, recipients and a delivery mode. It never
 * stores numbers: the worker asks Matomo when the report runs, renders, sends
 * and forgets.
 */

export const REPORT_FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'custom'] as const;
export type ReportFrequency = (typeof REPORT_FREQUENCIES)[number];

/** PPTX is held back until the exporter passes its stability gate (DEV-008). */
export const REPORT_FORMATS = ['pdf', 'xlsx', 'pptx'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/**
 * How a report reaches people: the file attached, or a link into the product
 * where the recipient signs in and sees the dashboard under their own rights.
 * A link stores nothing; an attachment exists only while it is being sent.
 */
export const REPORT_DELIVERY_MODES = ['attachment', 'link'] as const;
export type ReportDeliveryMode = (typeof REPORT_DELIVERY_MODES)[number];

/** Relative periods only: a report always describes "the last …" at its run. */
export const REPORT_PERIODS = TIME_RANGE_PRESETS.filter(
  (preset): preset is Exclude<TimeRangePreset, 'custom' | 'today'> =>
    preset !== 'custom' && preset !== 'today',
);
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export const REPORT_COMPARISONS = ['none', 'previous_period', 'prior_year'] as const;

export const REPORT_MAX_RECIPIENTS = 50;

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const reportRhythmSchema = z
  .object({
    frequency: z.enum(REPORT_FREQUENCIES),
    /** Local time of day in the schedule's time zone, `HH:MM`. */
    time: timeOfDay,
    /** Weekly: ISO weekday, 1 = Monday. */
    weekday: z.number().int().min(1).max(7).optional(),
    /**
     * Monthly: day of the month. Quarterly: day of the quarter's first month.
     * 29-31 are not offered; "last" is, so no month is skipped.
     */
    dayOfMonth: z.union([z.number().int().min(1).max(28), z.literal('last')]).optional(),
    /** Custom: the weekdays it runs on. */
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  })
  .strict()
  .superRefine((rhythm, context) => {
    if (rhythm.frequency === 'weekly' && rhythm.weekday === undefined) {
      context.addIssue({ code: 'custom', path: ['weekday'], message: 'weekly needs a weekday' });
    }
    if (
      (rhythm.frequency === 'monthly' || rhythm.frequency === 'quarterly') &&
      rhythm.dayOfMonth === undefined
    ) {
      context.addIssue({ code: 'custom', path: ['dayOfMonth'], message: 'needs a day' });
    }
    if (rhythm.frequency === 'custom' && !rhythm.weekdays?.length) {
      context.addIssue({ code: 'custom', path: ['weekdays'], message: 'custom needs weekdays' });
    }
  });
export type ReportRhythm = z.infer<typeof reportRhythmSchema>;

export const reportScheduleInputSchema = z
  .object({
    dashboardId: z.string().min(1).max(64),
    name: z.string().trim().min(1).max(120),
    format: z.enum(REPORT_FORMATS),
    period: z.enum(REPORT_PERIODS as unknown as [ReportPeriod, ...ReportPeriod[]]),
    comparison: z.enum(REPORT_COMPARISONS),
    rhythm: reportRhythmSchema,
    /** Explicit IANA time zone; when the report runs is decided in this zone. */
    timezone: z.string().min(1).max(64),
    deliveryMode: z.enum(REPORT_DELIVERY_MODES),
    /** Product users of the tenant. Each must be allowed to see the dashboard. */
    recipientUserIds: z.array(z.string().min(1).max(64)).min(1).max(REPORT_MAX_RECIPIENTS),
  })
  .strict();
export type ReportScheduleInput = z.infer<typeof reportScheduleInputSchema>;

export const REPORT_RUN_STATUSES = [
  'queued',
  'running',
  'delivered',
  'partially_delivered',
  'failed',
  'skipped',
] as const;
export type ReportRunStatus = (typeof REPORT_RUN_STATUSES)[number];

/** Why a recipient was left out of a run. */
export const RECIPIENT_SKIP_REASONS = ['no_access', 'inactive'] as const;
export type RecipientSkipReason = (typeof RECIPIENT_SKIP_REASONS)[number];

export interface ReportRecipient {
  readonly userId: string;
  readonly name: string;
  /** Whether they may see the dashboard right now. */
  readonly hasAccess: boolean;
}

export interface ReportRunSummary {
  readonly id: string;
  readonly plannedFor: string;
  readonly trigger: 'schedule' | 'manual';
  readonly status: ReportRunStatus;
  readonly attempts: number;
  /** The published version the run read - never a draft (Published Runtime). */
  readonly publishedVersion: number | null;
  readonly periodFrom: string | null;
  readonly periodTo: string | null;
  readonly delivered: number;
  readonly skipped: readonly { readonly name: string; readonly reason: RecipientSkipReason }[];
  readonly errorKey: string | null;
  readonly finishedAt: string | null;
}

export interface ReportScheduleSummary {
  readonly id: string;
  readonly projectId: string;
  readonly dashboardId: string;
  readonly dashboardName: string;
  readonly name: string;
  readonly format: ReportFormat;
  readonly period: ReportPeriod;
  readonly comparison: (typeof REPORT_COMPARISONS)[number];
  readonly rhythm: ReportRhythm;
  readonly timezone: string;
  readonly deliveryMode: ReportDeliveryMode;
  readonly recipients: readonly ReportRecipient[];
  readonly status: 'active' | 'paused';
  /** Null while paused, or while the tenant is not active. */
  readonly nextRunAt: string | null;
  readonly lastRun: ReportRunSummary | null;
  readonly createdBy: string | null;
}

/** Everything the schedule form needs to offer valid choices. */
export interface ReportScheduleOptions {
  readonly dashboards: readonly { readonly id: string; readonly name: string }[];
  readonly recipients: readonly { readonly userId: string; readonly name: string }[];
  readonly timezone: string;
  readonly pptxEnabled: boolean;
}
