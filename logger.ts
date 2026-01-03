import pino from 'pino';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { trace, context } from '@opentelemetry/api';

const isDev = process.env.NODE_ENV !== 'production';

// Create pino logger with appropriate transport
const pinoLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    service: process.env.OTEL_SERVICE_NAME || 'magicvoice-core',
    env: process.env.OTEL_ENVIRONMENT || process.env.NODE_ENV || 'development',
  },
});

// Map pino levels to OTel severity
const severityMap: Record<string, SeverityNumber> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

// Get OTel logger for exporting to Grafana
function getOtelLogger() {
  return logs.getLogger(process.env.OTEL_SERVICE_NAME || 'magicvoice-core');
}

// Emit log to OTel for Grafana export
function emitOtelLog(level: string, message: string, attributes: Record<string, unknown> = {}) {
  const otelLogger = getOtelLogger();
  const activeSpan = trace.getSpan(context.active());
  const spanContext = activeSpan?.spanContext();

  otelLogger.emit({
    severityNumber: severityMap[level] || SeverityNumber.INFO,
    severityText: level.toUpperCase(),
    body: message,
    attributes: {
      ...attributes,
      'service.name': process.env.OTEL_SERVICE_NAME || 'magicvoice-core',
    },
    context: spanContext ? trace.setSpanContext(context.active(), spanContext) : context.active(),
  });
}

// Create wrapper that logs to both pino and OTel
function createLogger(component?: string) {
  const childLogger = component ? pinoLogger.child({ component }) : pinoLogger;

  return {
    trace: (msg: string, attrs?: Record<string, unknown>) => {
      childLogger.trace(attrs || {}, msg);
      emitOtelLog('trace', msg, { component, ...attrs });
    },
    debug: (msg: string, attrs?: Record<string, unknown>) => {
      childLogger.debug(attrs || {}, msg);
      emitOtelLog('debug', msg, { component, ...attrs });
    },
    info: (msg: string, attrs?: Record<string, unknown>) => {
      childLogger.info(attrs || {}, msg);
      emitOtelLog('info', msg, { component, ...attrs });
    },
    warn: (msg: string, attrs?: Record<string, unknown>) => {
      childLogger.warn(attrs || {}, msg);
      emitOtelLog('warn', msg, { component, ...attrs });
    },
    error: (msg: string, attrs?: Record<string, unknown>) => {
      childLogger.error(attrs || {}, msg);
      emitOtelLog('error', msg, { component, ...attrs });
    },
    fatal: (msg: string, attrs?: Record<string, unknown>) => {
      childLogger.fatal(attrs || {}, msg);
      emitOtelLog('fatal', msg, { component, ...attrs });
    },
    // Create child logger for a specific component
    child: (component: string) => createLogger(component),
  };
}

// Export default logger and factory
export const logger = createLogger();
export { createLogger };
