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

  mail: z.object({
    transport: z.enum(['console', 'smtp']).default('console'),
    from: z.string().min(1).default('Analytics Experience <no-reply@example.invalid>'),
    smtpHost: z.string().optional(),
    smtpPort: port.optional(),
  }),

  features: z.object({
    demoFixtures: booleanish.default(false),
  }),
});

export type AppConfig = z.infer<typeof configSchema>;
