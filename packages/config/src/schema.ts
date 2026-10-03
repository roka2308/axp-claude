import { z } from 'zod';
import { deploymentProfileSchema } from '@axp/contracts';

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((value) =>
    typeof value === 'boolean' ? value : value === 'true' || value === '1' || value === 'yes',
  );

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();

/** 32 bytes of base64 entropy. Rejects the placeholder from .env.example. */
const base64Key32 = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('CHANGE_ME'), {
    message: 'Placeholder value from .env.example - generate a real key.',
  })
  .refine(
    (value) => {
      try {
        return Buffer.from(value, 'base64').length >= 32;
      } catch {
        return false;
      }
    },
    { message: 'Must be at least 32 bytes encoded as base64.' },
  );

const mysqlUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith('mysql://'), {
    message: 'Only mysql:// URLs are supported. MySQL is the product store.',
  });

export const configSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  appEnv: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  deploymentProfile: deploymentProfileSchema.default('central_multi_tenant'),

  log: z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    format: z.enum(['json', 'pretty']).default('json'),
  }),

  api: z.object({
    host: z.string().min(1).default('127.0.0.1'),
    port: port.default(4000),
    publicUrl: z.string().url(),
  }),

  web: z.object({
    port: port.default(3000),
    publicUrl: z.string().url(),
  }),

  database: z.object({
    url: mysqlUrl,
    poolLimit: positiveInt.max(200).default(10),
  }),

  secrets: z.object({
    sessionSecret: base64Key32,
    credentialEncryptionKey: base64Key32,
  }),

  session: z.object({
    cookieName: z.string().min(1).default('axp_session'),
    idleTimeoutMinutes: positiveInt.default(60),
    absoluteLifetimeHours: positiveInt.default(12),
    reauthWindowMinutes: positiveInt.default(15),
  }),

  bootstrap: z.object({
    tokenTtlMinutes: positiveInt.max(1440).default(60),
  }),

  analytics: z.object({
    /**
     * Ephemeral in-memory cache only. A persistent analytics cache is On Hold
     * (Master Spec §4) and cannot be configured on.
     */
    cacheTtlSeconds: positiveInt.max(900).default(60),
    cacheMaxEntries: positiveInt.default(500),
    queryTimeoutMs: positiveInt.default(15_000),
    maxParallelQueries: positiveInt.max(64).default(6),
  }),

  matomo: z.object({
    adapter: z.enum(['mock', 'http']).default('mock'),
  }),

  editor: z.object({
    /**
     * How long an editor lease survives without a heartbeat (Master Spec §21).
     *
     * Short enough that a closed laptop does not block a colleague for long,
     * long enough to survive a slow network. Takeover is available before it
     * expires anyway, so this is the automatic case, not the only one.
     */
    leaseTtlSeconds: positiveInt.max(3600).default(120),
    /** How often the editor refreshes its lease. */
    leaseHeartbeatSeconds: positiveInt.max(600).default(30),
  }),

  exports: z.object({
    /**
     * Where finished export files wait for their download, encrypted. Outside
     * the database on purpose: a file of numbers is analytics content, and it
     * is deleted when it expires (Master Spec §4, §15).
     */
    artifactDir: z.string().min(1),
    /** How long a finished file can be downloaded. Short by design. */
    artifactTtlMinutes: positiveInt.max(120).default(15),
  }),

  reports: z.object({
    /**
     * PPTX by schedule stays off until the exporter has passed its stability
     * gate (Master Spec §15, DEV-008). Manual PPTX exports are unaffected.
     */
    pptxEnabled: booleanish.default(false),
  }),

  worker: z.object({
    /** How often the worker looks for queued jobs. */
    jobPollMs: positiveInt.min(200).max(60_000).default(2000),
    /** How long a claimed job may run before another worker may take it over. */
    jobLeaseSeconds: positiveInt.min(30).max(3600).default(300),
  }),

  attention: z.object({
    /** A link this close to its expiry is mentioned to its owner. */
    shareExpiryWarningDays: positiveInt.max(30).default(3),
    /** Accounts unused this long are suggested for review. */
    inactivityDays: positiveInt.max(730).default(90),
  }),

  mail: z.object({
    transport: z.enum(['console', 'smtp']).default('console'),
    from: z.string().min(1).default('Analytics Experience <no-reply@example.invalid>'),
    smtpHost: z.string().optional(),
    smtpPort: port.optional(),
    /** Implicit TLS (port 465). Otherwise STARTTLS is used when offered. */
    smtpSecure: booleanish.default(false),
    smtpUser: z.string().optional(),
    smtpPassword: z.string().optional(),
  }),

  features: z.object({
    demoFixtures: booleanish.default(false),
  }),
});

export type AppConfig = z.infer<typeof configSchema>;
