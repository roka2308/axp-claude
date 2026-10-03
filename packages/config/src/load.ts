import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { type AppConfig, configSchema } from './schema';

export class ConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

/** Walks upwards to the workspace root so every process reads the same .env. */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    if (
      existsSync(path.join(dir, 'package.json')) &&
      existsSync(path.join(dir, 'tsconfig.base.json'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

let dotenvLoaded = false;

export function loadDotenvOnce(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  const root = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
  const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
  const candidate = path.join(root, envFile);
  loadDotenv({ path: existsSync(candidate) ? candidate : path.join(root, '.env'), quiet: true });
}

function raw(env: NodeJS.ProcessEnv) {
  return {
    nodeEnv: env.NODE_ENV,
    appEnv: env.APP_ENV,
    deploymentProfile: env.DEPLOYMENT_PROFILE,
    log: { level: env.LOG_LEVEL, format: env.LOG_FORMAT },
    api: { host: env.API_HOST, port: env.API_PORT, publicUrl: env.API_PUBLIC_URL },
    web: { port: env.WEB_PORT, publicUrl: env.WEB_PUBLIC_URL },
    database: {
      url: env.NODE_ENV === 'test' ? (env.TEST_DATABASE_URL ?? env.DATABASE_URL) : env.DATABASE_URL,
      poolLimit: env.DATABASE_POOL_LIMIT,
    },
    secrets: {
      sessionSecret: env.SESSION_SECRET,
      credentialEncryptionKey: env.CREDENTIAL_ENCRYPTION_KEY,
    },
    session: {
      cookieName: env.SESSION_COOKIE_NAME,
      idleTimeoutMinutes: env.SESSION_IDLE_TIMEOUT_MINUTES,
      absoluteLifetimeHours: env.SESSION_ABSOLUTE_LIFETIME_HOURS,
      reauthWindowMinutes: env.REAUTH_WINDOW_MINUTES,
    },
    bootstrap: { tokenTtlMinutes: env.BOOTSTRAP_TOKEN_TTL_MINUTES },
    analytics: {
      cacheTtlSeconds: env.ANALYTICS_CACHE_TTL_SECONDS,
      cacheMaxEntries: env.ANALYTICS_CACHE_MAX_ENTRIES,
      queryTimeoutMs: env.ANALYTICS_QUERY_TIMEOUT_MS,
      maxParallelQueries: env.ANALYTICS_MAX_PARALLEL_QUERIES,
    },
    matomo: { adapter: env.MATOMO_ADAPTER },
    editor: {
      leaseTtlSeconds: env.EDITOR_LEASE_TTL_SECONDS,
      leaseHeartbeatSeconds: env.EDITOR_LEASE_HEARTBEAT_SECONDS,
    },
    mail: {
      transport: env.MAIL_TRANSPORT,
      from: env.MAIL_FROM,
      smtpHost: env.SMTP_HOST,
      smtpPort: env.SMTP_PORT,
      smtpSecure: env.SMTP_SECURE,
      smtpUser: env.SMTP_USER,
      smtpPassword: env.SMTP_PASSWORD,
    },
    exports: {
      artifactDir:
        env.EXPORT_ARTIFACT_DIR ??
        path.join(findRepoRoot(path.dirname(fileURLToPath(import.meta.url))), '.local', 'exports'),
      artifactTtlMinutes: env.EXPORT_ARTIFACT_TTL_MINUTES,
    },
    reports: { pptxEnabled: env.REPORTS_PPTX_ENABLED },
    worker: {
      jobPollMs: env.WORKER_JOB_POLL_MS,
      jobLeaseSeconds: env.WORKER_JOB_LEASE_SECONDS,
    },
    attention: {
      shareExpiryWarningDays: env.ATTENTION_SHARE_EXPIRY_DAYS,
      inactivityDays: env.ATTENTION_INACTIVITY_DAYS,
    },
    features: { demoFixtures: env.ENABLE_DEMO_FIXTURES },
  };
}

/**
 * Cross-field rules that a per-field schema cannot express. These exist to make
 * an unsafe production deployment fail at startup rather than silently run.
 */
function productionGuards(config: AppConfig): string[] {
  if (config.appEnv !== 'production') return [];
  const issues: string[] = [];

  if (config.features.demoFixtures) {
    issues.push('features.demoFixtures must be off in production (canonical demo seed).');
  }
  if (config.log.format !== 'json') {
    issues.push('log.format must be "json" in production so logs stay machine readable.');
  }
  if (!config.api.publicUrl.startsWith('https://')) {
    issues.push('api.publicUrl must use https in production.');
  }
  if (!config.web.publicUrl.startsWith('https://')) {
    issues.push('web.publicUrl must use https in production.');
  }
  if (config.database.url.includes('axp_dev') || config.database.url.includes('axp_root_dev')) {
    issues.push('database.url still carries a development credential.');
  }
  return issues;
}

let cached: AppConfig | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  loadDotenvOnce();
  const parsed = configSchema.safeParse(raw(env));
  if (!parsed.success) {
    throw new ConfigurationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const guards = productionGuards(parsed.data);
  if (guards.length > 0) throw new ConfigurationError(guards);
  return parsed.data;
}

/** Process-wide singleton. Tests call `loadConfig` directly with a fake env. */
export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

export function resetConfigCacheForTests(): void {
  cached = undefined;
  dotenvLoaded = false;
}
