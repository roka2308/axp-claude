import { pino, type Logger as PinoLogger, type LoggerOptions } from 'pino';
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
      log: (object) => {
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

  return pino(options);
}
