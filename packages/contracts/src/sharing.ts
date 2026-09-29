import { z } from 'zod';
import type {
  DashboardLayoutPresentation,
  WidgetDetailPresentation,
  WidgetPresentation,
} from './presentation';

/**
 * External sharing (Master Spec §15, Shared Contract §11).
 *
 * A share is a server-side object: a whole published dashboard, a mandatory
 * expiry, revocable at any time, with explicit rights for what the recipient
 * may change. Internal access is not a share - it is an object grant, handled
 * by the permission model (D5).
 */

/** What a recipient may do beyond looking at the dashboard's default view. */
export const SHARE_RIGHTS = ['timeRange', 'comparison', 'detail', 'export'] as const;
export type ShareRight = (typeof SHARE_RIGHTS)[number];

export type ShareRights = Readonly<Record<ShareRight, boolean>>;

/** A share never lives longer than this; "no expiry" is not an option. */
export const SHARE_MAX_LIFETIME_DAYS = 90;
export const SHARE_PASSWORD_MIN_LENGTH = 10;

export const shareRightsSchema = z
  .object({
    timeRange: z.boolean(),
    comparison: z.boolean(),
    detail: z.boolean(),
    export: z.boolean(),
  })
  .strict();

export const shareCreateRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    /** Last day the link works, `YYYY-MM-DD` in the project's time zone. */
    expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    rights: shareRightsSchema,
    /** Optional. Stored as an Argon2id hash, never readable again. */
    password: z.string().min(SHARE_PASSWORD_MIN_LENGTH).max(200).optional(),
  })
  .strict();
export type ShareCreateRequest = z.infer<typeof shareCreateRequestSchema>;

/**
 * Where a share stands, as its owners see it.
 *
 * `unavailable` means the link is fine but the thing behind it is not: the
 * dashboard was archived or trashed, the tenant is suspended, or the person
 * who shared it no longer may. Recipients never learn which.
 */
export const SHARE_STATUSES = ['active', 'expired', 'revoked', 'unavailable'] as const;
export type ShareStatus = (typeof SHARE_STATUSES)[number];

export interface ShareSummary {
  readonly id: string;
  readonly dashboardId: string;
  readonly label: string;
  readonly status: ShareStatus;
  /** Why an otherwise valid share does not work, for its owners only. */
  readonly unavailableReason?:
    'dashboard_not_published' | 'tenant_inactive' | 'creator_lost_access';
  readonly expiresAt: string;
  readonly rights: ShareRights;
  readonly passwordProtected: boolean;
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly revokedAt: string | null;
  readonly lastAccessedAt: string | null;
  readonly accessCount: number;
}

/** The date limits for a new share, in the project's time zone. */
export interface ShareExpiryWindow {
  readonly timezone: string;
  readonly min: string;
  readonly max: string;
  /** Suggested: two weeks from today. */
  readonly suggested: string;
}

export const SHARE_SUGGESTED_LIFETIME_DAYS = 14;

/** Returned once, at creation. The token is never stored and never shown again. */
export interface ShareCreated {
  readonly share: ShareSummary;
  readonly token: string;
}

/**
 * Internal distribution: who can already open the dashboard, and where that
 * is changed. Sharing inside the organisation hands off to permissions rather
 * than producing a link (development plan, Phase 7).
 */
export interface InternalAccessSummary {
  readonly grants: readonly {
    readonly subjectType: 'user' | 'group';
    readonly subjectName: string;
    readonly access: 'view' | 'edit';
    readonly via: 'dashboard' | 'project';
  }[];
  readonly canManage: boolean;
  /** Where grants are changed, when the caller may change them. */
  readonly manageHref?: string;
}

/** What the caller may do with a dashboard they are viewing, decided by the server. */
export interface DashboardPermissions {
  readonly canExport: boolean;
  readonly canShare: boolean;
  readonly canEdit: boolean;
}

// --- the recipient's side ----------------------------------------------------

/** What a recipient learns about a share. Deliberately little. */
export interface ShareViewMeta {
  readonly dashboardName: string;
  readonly description?: string;
  readonly tenantName: string;
  readonly expiresAt: string;
  readonly rights: ShareRights;
}

/**
 * The answer to "what is behind this link".
 *
 * Revoked, expired, archived, deleted and "never existed" all produce the same
 * neutral `unavailable`: the difference is none of the recipient's business,
 * and telling them would turn the link into an oracle.
 */
export type ShareAccess =
  | { readonly state: 'unavailable' }
  | { readonly state: 'password_required' }
  | { readonly state: 'available'; readonly meta: ShareViewMeta };

export const shareUnlockRequestSchema = z.object({ password: z.string().min(1).max(200) }).strict();

export interface ShareUnlocked {
  /** Proves the password was given; valid until `expiresAt`, never past the share. */
  readonly sessionToken: string;
  readonly expiresAt: string;
}

/** The layout a recipient sees: the dashboard's, with nothing internal. */
export type SharedLayout = DashboardLayoutPresentation & { readonly share: ShareViewMeta };
export type SharedWidget = WidgetPresentation;
export type SharedWidgetDetail = WidgetDetailPresentation;
