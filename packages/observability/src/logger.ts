import { pino, type DestinationStream, type Logger as PinoLogger, type LoggerOptions } from 'pino';
import { getContext } from './correlation';
import { sanitizeForLog } from './redaction';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type LogFormat = 'json' | 'pretty';

export interface LoggerConfig {
  readonly level: LogLevel;
  readonly format: LogFormat;
  /** Process name, e.g. `api`, `worker`, `web`. */
  readonly service: string;
  readonly version: string;
  readonly appEnv: string;
  /** Where records go instead of stdout - the telemetry review reads them back. */
  readonly destination?: DestinationStream;
}

export type Logger = PinoLogger;

/**
 * Creates the process logger.
 *
 * Every record is passed through `sanitizeForLog` before serialisation, so a
 * forgotten payload cannot leak into telemetry. pino's own `redact` option is
 * path-based and would miss nested structures we do not know up front.
 */
export function createLogger(config: LoggerConfig): Logger {
  const options: LoggerOptions = {
    level: config.level,
    base: {
      service: config.service,
      version: config.version,
      env: config.appEnv,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      log: (raw) => {
        const object = describeHttp(raw);
        const context = getContext();
        const merged = context
          ? {
              ...object,
              correlationId: context.correlationId,
              ...(context.requestId ? { requestId: context.requestId } : {}),
              ...(context.userId ? { userId: context.userId } : {}),
              ...(context.tenantId ? { tenantId: context.tenantId } : {}),
              ...(context.projectId ? { projectId: context.projectId } : {}),
              ...(context.jobId ? { jobId: context.jobId } : {}),
            }
          : object;
        return sanitizeForLog(merged) as Record<string, unknown>;
      },
    },
  };

  if (config.format === 'pretty') {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname,service,version,env',
          messageFormat: '{msg}',
        },
      },
    });
  }

  return config.destination ? pino(options, config.destination) : pino(options);
}

/**
 * The HTTP request and response a framework hands to the logger, reduced to
 * what an operator needs: method, path, status. The query string is dropped -
 * it can carry a search term or an address - and nothing else of the raw
 * message (headers, body, socket) is kept.
 */
function describeHttp(object: Record<string, unknown>): Record<string, unknown> {
  const req = object.req as { method?: unknown; url?: unknown } | undefined;
  const res = object.res as { statusCode?: unknown } | undefined;
  if (!req && !res) return object;
  const out: Record<string, unknown> = { ...object };
  if (req && typeof req === 'object') {
    // Named \`url\` because the framework's own serializer, which runs after
    // this, reads exactly that field.
    out.req = {
      method: typeof req.method === 'string' ? req.method : undefined,
      url: typeof req.url === 'string' ? req.url.split('?')[0] : undefined,
    };
  }
  if (res && typeof res === 'object') {
    out.res = { statusCode: typeof res.statusCode === 'number' ? res.statusCode : undefined };
  }
  return out;
}
