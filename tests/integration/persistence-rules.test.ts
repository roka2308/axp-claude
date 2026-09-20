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

  it('contains exactly the expected tables for the current milestone', async () => {
    // Phase 0 established the product store; Phase 1 added Matomo connectivity,
    // the semantic layer and the dashboard lifecycle. Every one of these holds
    // configuration: what to ask Matomo, and how to present the answer.
    const tables = await listTables();
    expect(tables).toEqual([
      '__drizzle_migrations',
      'audit_events',
      'auth_identities',
      'bootstrap_tokens',
      'dashboard_drafts',
      'dashboard_versions',
      'dashboards',
      'group_members',
      'groups',
      'login_attempts',
      'matomo_capability_snapshots',
      'matomo_connections',
      'matomo_sites',
      'object_grants',
      'password_history',
      'platform_state',
      'project_sites',
      'projects',
      'role_assignments',
      'semantic_definitions',
      'semantic_versions',
      'sessions',
      'source_bindings',
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
    const forbiddenColumns = [
      'nb_visits',
      'nb_pageviews',
      'metric_value',
      'result_payload',
      'series',
    ];

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

  it('stores the Matomo credential only as ciphertext', async () => {
    // Master Spec §19: the token is sealed, and there is no read path. A
    // column called `token` or `token_auth` here would be exactly that path.
    const columns = await listColumns('matomo_connections');
    expect(columns).toContain('credential_ciphertext');
    expect(columns).toContain('credential_nonce');
    expect(columns).toContain('credential_key_version');
    for (const plaintext of ['token', 'token_auth', 'credential', 'password', 'api_key']) {
      expect(columns, `matomo_connections.${plaintext}`).not.toContain(plaintext);
    }
  });

  it('keeps capability snapshots about capabilities, not about measurements', async () => {
    // G3 derives compatibility from what the installation can do. Storing a
    // measured value here would turn a capability record into an analytics
    // store through the back door.
    const columns = await listColumns('matomo_capability_snapshots');
    expect(columns).toContain('probes');
    expect(columns).toContain('compatibility');
    for (const measured of ['visits', 'value', 'metrics', 'results', 'data']) {
      expect(columns, `matomo_capability_snapshots.${measured}`).not.toContain(measured);
    }
  });

  it('gives dashboards a snapshot of configuration, not of results', async () => {
    // A published version pins ids and layout so it renders identically later;
    // the numbers are fetched from Matomo at view time, every time.
    const versionColumns = await listColumns('dashboard_versions');
    expect(versionColumns).toContain('snapshot');
    expect(versionColumns).toContain('pinned_semantic_version_ids');
    for (const cached of ['values', 'metrics', 'data', 'results', 'rendered']) {
      expect(versionColumns, `dashboard_versions.${cached}`).not.toContain(cached);
    }
  });
});
