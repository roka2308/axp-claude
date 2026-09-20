import {
  boolean,
  char,
  foreignKey,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { MATOMO_COMPATIBILITY_STATES } from '@axp/contracts';
import { createdAt, idColumn, updatedAt, utcTimestamp } from './_shared';
import { projects, tenants } from './tenancy';
import { users } from './identity';

export const MATOMO_CONNECTION_STATUSES = ['untested', 'ok', 'failing', 'disabled'] as const;

/**
 * A Matomo installation a tenant can query (Master Spec §13).
 *
 * Connections live at tenant level and are reused across the tenant's projects;
 * sites are assigned to projects individually.
 *
 * The credential is stored encrypted (AES-256-GCM) and is never returned by any
 * API. There is deliberately no "reveal" path: a lost token is replaced, not
 * read back (Master Spec §19).
 */
export const matomoConnections = mysqlTable(
  'matomo_connections',
  {
    id: idColumn().primaryKey(),
    tenantId: char('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: varchar({ length: 200 }).notNull(),
    baseUrl: varchar('base_url', { length: 500 }).notNull(),
    /** Ciphertext, nonce and auth tag of the Matomo token, base64. */
    credentialCiphertext: text('credential_ciphertext').notNull(),
    credentialNonce: varchar('credential_nonce', { length: 64 }).notNull(),
    /** Which encryption key produced the ciphertext, for future rotation. */
    credentialKeyVersion: int('credential_key_version').notNull().default(1),
    credentialUpdatedAt: utcTimestamp(),
    status: mysqlEnum(MATOMO_CONNECTION_STATUSES).notNull().default('untested'),
    lastTestedAt: utcTimestamp(),
    createdByUserId: char('created_by_user_id', { length: 36 }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_matomo_connection_tenant_name').on(table.tenantId, table.name),
    index('idx_matomo_connections_tenant').on(table.tenantId),
  ],
);

/**
 * What a connection was observed to be able to do (Master Spec §22, G3).
 *
 * Holds capability flags, version and limitations - never analytics results.
 * Keeping snapshots rather than one row lets drift be detected by comparing
 * the newest against the previous one.
 */
export const matomoCapabilitySnapshots = mysqlTable(
  'matomo_capability_snapshots',
  {
    id: idColumn().primaryKey(),
    connectionId: char('connection_id', { length: 36 }).notNull(),
    detectedAt: utcTimestamp().notNull(),
    matomoVersion: varchar('matomo_version', { length: 40 }),
    compatibility: mysqlEnum(MATOMO_COMPATIBILITY_STATES).notNull(),
    /** Probe results: capability -> state. No measured values. */
    probes: json().$type<Record<string, unknown>[]>().notNull(),
    limitationKeys: json('limitation_keys').$type<string[]>().notNull().default([]),
    siteCount: int('site_count'),
    createdAt: createdAt(),
  },
  (table) => [
    // Named explicitly: MySQL caps identifier names at 64 characters, and the
    // derived name for this column pair is longer than that.
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [matomoConnections.id],
      name: 'fk_capability_snapshot_connection',
    }).onDelete('cascade'),
    index('idx_capability_snapshots_connection').on(table.connectionId, table.detectedAt),
  ],
);

/**
 * Site metadata mirrored from Matomo.
 *
 * `timezone` is authoritative for the analytics calendar: period boundaries
 * follow the site, not the server and not the browser (Master Spec §19).
 */
export const matomoSites = mysqlTable(
  'matomo_sites',
  {
    id: idColumn().primaryKey(),
    tenantId: char('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    connectionId: char('connection_id', { length: 36 })
      .notNull()
      .references(() => matomoConnections.id, { onDelete: 'cascade' }),
    /** Matomo's own numeric id within that installation. */
    matomoSiteId: int('matomo_site_id').notNull(),
    name: varchar({ length: 255 }).notNull(),
    mainUrl: varchar('main_url', { length: 500 }),
    timezone: varchar({ length: 64 }).notNull(),
    currency: varchar({ length: 10 }),
    ecommerceEnabled: boolean('ecommerce_enabled').notNull().default(false),
    metadataRefreshedAt: utcTimestamp(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_matomo_site_connection_site').on(table.connectionId, table.matomoSiteId),
    index('idx_matomo_sites_tenant').on(table.tenantId),
  ],
);

/**
 * Assignment of a site to a project.
 *
 * A join table because the same site may serve several projects of the same
 * tenant (Master Spec §13). Crossing tenants is prevented by both sides
 * carrying the tenant and by the domain layer checking it.
 */
export const projectSites = mysqlTable(
  'project_sites',
  {
    id: idColumn().primaryKey(),
    projectId: char('project_id', { length: 36 })
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    siteId: char('site_id', { length: 36 })
      .notNull()
      .references(() => matomoSites.id, { onDelete: 'cascade' }),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_project_site').on(table.projectId, table.siteId),
    index('idx_project_sites_site').on(table.siteId),
  ],
);
