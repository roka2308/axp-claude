import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, type AuditAction } from '@axp/contracts';

/**
 * Audit completeness review (Phase 10; Shared Contract §16).
 *
 * Two directions: every event the contract asks for has an audit action, and
 * every audit action the product declares is actually written somewhere - an
 * action nobody records would look like coverage without being any.
 */

const CONTRACT: Record<string, readonly AuditAction[]> = {
  'bootstrap/recovery': [
    'platform.bootstrap.completed',
    'platform.recovery.completed',
    'auth.password.reset',
  ],
  'tenant creation/lifecycle changes/purge': [
    'tenant.created',
    'tenant.lifecycle.changed',
    'tenant.purged',
  ],
  'user invite/deactivate': ['user.invited', 'user.deactivated'],
  'role/scope/group/object grant changes': [
    'role_assignment.created',
    'role_assignment.removed',
    'group.membership.changed',
    'object_grant.changed',
  ],
  'credential replacement/rotation metadata': ['matomo_connection.credential_replaced'],
  'semantic activation/deprecation': ['semantic.version_activated', 'semantic.version_deprecated'],
  'dashboard publish/rollback/archive/trash': [
    'dashboard.published',
    'dashboard.rolled_back',
    'dashboard.archived',
    'dashboard.trashed',
  ],
  'share create/revoke': ['share.created', 'share.revoked'],
  'schedule changes': [
    'report_schedule.created',
    'report_schedule.updated',
    'report_schedule.paused',
    'report_schedule.deleted',
  ],
  'theme publish/rollback': ['theme.published', 'theme.rolled_back'],
  'solution import/update': ['solution.installed'],
  'privileged diagnostic bundle generation': ['diagnostics.bundle_generated'],
};

/**
 * Declared for actions the MVP does not offer yet: the purge belongs to
 * offboarding retention, which the specification keeps On Hold; a connection
 * is replaced (credential, address) but not removed.
 */
const DECLARED_NOT_YET_WRITTEN = new Set<AuditAction>([
  'tenant.purged',
  'matomo_connection.removed',
]);

const ROOT = path.resolve(__dirname, '../../../..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory())
      return entry === 'node_modules' || entry === 'dist' ? [] : sources(full);
    return /\.ts$/.test(entry) && !/\.test\.ts$/.test(entry) ? [full] : [];
  });
}

describe('audit coverage', () => {
  it('has an action for every event the contract names', () => {
    for (const [event, actions] of Object.entries(CONTRACT)) {
      for (const action of actions) expect(AUDIT_ACTIONS, event).toContain(action);
    }
  });

  it('writes every declared action somewhere in the product', () => {
    const code = [
      ...sources(path.join(ROOT, 'packages', 'core', 'src')),
      ...sources(path.join(ROOT, 'apps', 'api', 'src')),
    ]
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    const unused = AUDIT_ACTIONS.filter(
      (action) => !DECLARED_NOT_YET_WRITTEN.has(action) && !code.includes(`'${action}'`),
    );
    expect(unused).toEqual([]);
  });
});
