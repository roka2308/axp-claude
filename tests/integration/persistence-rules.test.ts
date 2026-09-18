import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, listColumns, listTables, setupDatabase } from './harness';

/**
 * Guards the hard persistence rule (Master Spec §4, acceptance checklist A):
 * MySQL holds product configuration only. No Matomo analytics result sets, no
 * visit/action raw data, no analytics API payloads.
 *
 * This is a structural test on purpose. A behavioural test can only prove that
 * today's code paths do not write analytics data; the schema check proves that
 * there is nowhere to write it. When a milestone legitimately adds a table, the
 * expected list below changes in the same commit - which is exactly the review
 * moment the rule needs.
 */
describe('product store persistence rules', () => {
  beforeAll(async () => {
    await setupDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('contains exactly the expected Phase 0 tables', async () => {
    const tables = await listTables();
    expect(tables).toEqual([
      '__drizzle_migrations',
      'audit_events',
      'auth_identities',
      'bootstrap_tokens',
      'group_members',
      'groups',
      'login_attempts',
      'object_grants',
      'password_history',
      'platform_state',
      'projects',
      'role_assignments',
      'sessions',
      'tenant_memberships',
      'tenants',
      'users',
    ]);
  });

  it('has no table whose name suggests analytics result storage', async () => {
    const forbidden = [
      'visits',
      'actions',
      'pageviews',
      'analytics_results',
      'analytics_cache',
      'report_data',
      'metric_values',
      'widget_data',
      'matomo_results',
      'time_series',
    ];
    const tables = await listTables();
    for (const name of forbidden) {
      expect(tables).not.toContain(name);
    }
  });

  it('stores no analytics values on the tables that do exist', async () => {
    // Columns that would indicate normalised Matomo results leaking into the
    // product store rather than staying in the ephemeral RAM cache.
    const forbiddenColumns = ['nb_visits', 'nb_pageviews', 'metric_value', 'result_payload', 'series'];

    for (const table of await listTables()) {
      const columns = await listColumns(table);
      for (const forbidden of forbiddenColumns) {
        expect(columns, `${table}.${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('never stores a password or token in a plaintext-shaped column', async () => {
    const authColumns = await listColumns('auth_identities');
    expect(authColumns).toContain('password_hash');
    expect(authColumns).not.toContain('password');

    const tokenColumns = await listColumns('bootstrap_tokens');
    expect(tokenColumns).toContain('token_hash');
    expect(tokenColumns).not.toContain('token');

    const sessionColumns = await listColumns('sessions');
    expect(sessionColumns).toContain('token_hash');
    expect(sessionColumns).not.toContain('token');
  });
});
