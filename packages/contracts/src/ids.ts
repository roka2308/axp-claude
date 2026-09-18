/**
 * Branded identifier types.
 *
 * Every tenant-owned record carries a tenant identity (Shared Contract §4).
 * Branding the ids makes it a type error to pass a ProjectId where a TenantId
 * is expected, which is the cheapest possible guard against cross-tenant bugs.
 */

declare const brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Brand<string, 'UserId'>;
export type GroupId = Brand<string, 'GroupId'>;
export type TenantId = Brand<string, 'TenantId'>;
export type ProjectId = Brand<string, 'ProjectId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type RoleAssignmentId = Brand<string, 'RoleAssignmentId'>;
export type AuditEventId = Brand<string, 'AuditEventId'>;
export type CorrelationId = Brand<string, 'CorrelationId'>;

/**
 * Stable identifier that survives export/import between installations.
 * Never equal to a local database id (Shared Contract §13).
 */
export type PortableId = Brand<string, 'PortableId'>;

export const asUserId = (value: string): UserId => value as UserId;
export const asGroupId = (value: string): GroupId => value as GroupId;
export const asTenantId = (value: string): TenantId => value as TenantId;
export const asProjectId = (value: string): ProjectId => value as ProjectId;
export const asSessionId = (value: string): SessionId => value as SessionId;
export const asCorrelationId = (value: string): CorrelationId => value as CorrelationId;
export const asPortableId = (value: string): PortableId => value as PortableId;
