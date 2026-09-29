import { z } from 'zod';
import { comparisonModeSchema, timeRangePresetSchema } from './analytics';

/**
 * Manual exports (Master Spec §15).
 *
 * An export reproduces the current viewer state - the period and comparison
 * on screen - from the same presentation model the screen reads. The file is a
 * short-lived, protected artifact: encrypted at rest, readable only by whoever
 * asked for it, and deleted when it expires.
 */
export const EXPORT_FORMATS = ['pdf', 'xlsx', 'pptx', 'csv'] as const;
export const exportFormatSchema = z.enum(EXPORT_FORMATS);
export type ExportFormat = z.infer<typeof exportFormatSchema>;

/** Formats that describe a whole dashboard; CSV describes one widget. */
export const DASHBOARD_EXPORT_FORMATS = ['pdf', 'xlsx', 'pptx'] as const;

export const exportRequestSchema = z
  .object({
    format: exportFormatSchema,
    /** Required for CSV, refused for the dashboard formats. */
    widgetId: z.string().min(1).max(64).optional(),
    /** The viewer state to reproduce. Absent: the dashboard's own default. */
    timeRange: timeRangePresetSchema.optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    comparison: comparisonModeSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.format === 'csv' && !value.widgetId) {
      context.addIssue({ code: 'custom', path: ['widgetId'], message: 'CSV needs a widget.' });
    }
    if (value.format !== 'csv' && value.widgetId) {
      context.addIssue({ code: 'custom', path: ['widgetId'], message: 'Only CSV is per widget.' });
    }
  });
export type ExportRequest = z.infer<typeof exportRequestSchema>;

/** A finished export, as the requester sees it. Carries no analytics values. */
export interface ExportArtifactSummary {
  readonly id: string;
  readonly format: ExportFormat;
  readonly fileName: string;
  readonly byteSize: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}
