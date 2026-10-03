import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '@axp/contracts';
import { closeDatabase, columnType, listColumns, listTables, setupDatabase } from './harness';

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
      'attention_items',
      'audit_events',
      'auth_identities',
      'bootstrap_tokens',
      'dashboard_drafts',
      'dashboard_shares',
      'dashboard_versions',
      'dashboards',
      'export_artifacts',
      'group_members',
      'groups',
      'jobs',
      'login_attempts',
      'matomo_capability_snapshots',
      'matomo_connections',
      'matomo_sites',
      'object_grants',
      'password_history',
      'platform_state',
      'project_sites',
      'projects',
      'report_runs',
      'report_schedules',
      'role_assignments',
      'semantic_definitions',
      'semantic_versions',
      'sessions',
      'share_sessions',
      'solution_installations',
      'source_bindings',
      'templates',
      'tenant_memberships',
      'tenants',
      'user_invitations',
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

  it('can store every audit action the product knows about', async () => {
    /*
     * `audit_events.action` is a MySQL enum, so a new action without a
     * migration is not a type error - it is a write that fails at runtime.
     * And the audit service swallows write failures on purpose, so the row
     * would simply never appear while the operation reported success.
     *
     * This is the cheapest possible guard against that: the column and the
     * contract must list exactly the same actions.
     */
    const type = await columnType('audit_events', 'action');
    const inDatabase = [...type.matchAll(/'([^']+)'/g)].map((match) => match[1]!);

    expect(inDatabase).toEqual([...AUDIT_ACTIONS]);
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

  it('keeps shares as configuration, with the link and password only as hashes', async () => {
    // Phase 7: a share names a dashboard, an expiry and rights. The link token
    // and the optional password are unusable if the table is read.
    const shareColumns = await listColumns('dashboard_shares');
    expect(shareColumns).toContain('token_hash');
    expect(shareColumns).toContain('password_hash');
    expect(shareColumns).toContain('expires_at');
    for (const plaintext of ['token', 'password', 'link', 'url']) {
      expect(shareColumns, `dashboard_shares.${plaintext}`).not.toContain(plaintext);
    }
    const sessionColumns = await listColumns('share_sessions');
    expect(sessionColumns).toContain('token_hash');
    expect(sessionColumns).not.toContain('token');
  });

  it('records export files by reference, never their content', async () => {
    // The export file holds analytics values, so it lives encrypted outside
    // the database and is deleted when it expires. The row is metadata.
    const columns = await listColumns('export_artifacts');
    expect(columns).toContain('storage_key');
    expect(columns).toContain('expires_at');
    for (const content of ['content', 'body', 'data', 'bytes', 'payload', 'values', 'blob']) {
      expect(columns, `export_artifacts.${content}`).not.toContain(content);
    }
  });

  it('keeps jobs, schedules and runs free of analytics values', async () => {
    // Phase 8: a job names its work by id, a schedule names a dashboard and a
    // relative period, a run records status and counts. The numbers a report
    // shows are fetched from Matomo when it runs and are never written here.
    for (const table of ['jobs', 'report_schedules', 'report_runs', 'attention_items']) {
      const columns = await listColumns(table);
      for (const content of ['values', 'data', 'result', 'results', 'content', 'body', 'file']) {
        expect(columns, `${table}.${content}`).not.toContain(content);
      }
    }
    expect(await listColumns('report_runs')).toContain('period_from');
  });
});
