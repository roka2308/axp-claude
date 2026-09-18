import type { AppConfig } from '@axp/config';
import { createDatabase, type Database, type DatabaseHandle } from '@axp/db';
import type { Logger } from '@axp/observability';
import { type Clock, systemClock } from './clock';
import { AuditService } from './audit/audit-service';
import { AuthorizationService } from './access/authorization-service';
import { AuthService } from './identity/auth-service';
import { UserService } from './identity/user-service';
import { BootstrapService } from './platform/bootstrap-service';
import { TenantService } from './tenancy/tenant-service';

/**
 * Composition root for the domain layer.
 *
 * The API process, the worker and the CLIs all build the same container, which
 * is what makes "one modular monolith, several processes" true rather than
 * aspirational: there is exactly one implementation of each domain rule.
 */
export interface Container {
  readonly config: AppConfig;
  readonly db: Database;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly audit: AuditService;
  readonly authorization: AuthorizationService;
  readonly auth: AuthService;
  readonly users: UserService;
  readonly tenants: TenantService;
  readonly bootstrap: BootstrapService;
  close(): Promise<void>;
}

export interface CreateContainerOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly clock?: Clock;
  /** Reuse an existing handle (tests share one pool across cases). */
  readonly databaseHandle?: DatabaseHandle;
}

export function createContainer(options: CreateContainerOptions): Container {
  const clock = options.clock ?? systemClock;
  const handle = options.databaseHandle ?? createDatabase(options.config);
  const ownsHandle = options.databaseHandle === undefined;
  const { db } = handle;
  const logger = options.logger;

  const audit = new AuditService({ db, clock, logger });
  const authorization = new AuthorizationService({ db });
  const users = new UserService({ db, clock, audit });
  const tenants = new TenantService({ db, clock, audit });

  const auth = new AuthService({
    db,
    clock,
    logger,
    audit,
    sessionPolicy: {
      idleTimeoutMinutes: options.config.session.idleTimeoutMinutes,
      absoluteLifetimeHours: options.config.session.absoluteLifetimeHours,
      reauthWindowMinutes: options.config.session.reauthWindowMinutes,
    },
  });

  const bootstrap = new BootstrapService({
    db,
    clock,
    logger,
    audit,
    tokenTtlMinutes: options.config.bootstrap.tokenTtlMinutes,
  });

  return {
    config: options.config,
    db,
    logger,
    clock,
    audit,
    authorization,
    auth,
    users,
    tenants,
    bootstrap,
    close: async () => {
      if (ownsHandle) await handle.close();
    },
  };
}
