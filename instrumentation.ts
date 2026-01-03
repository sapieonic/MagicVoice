import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

// Set up diagnostic logging before SDK initialization
// Only set logger if OTEL_LOG_LEVEL is explicitly set to avoid conflicts with SDK's internal logger
if (process.env.OTEL_LOG_LEVEL === 'debug') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

// Service identification
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'magicvoice-core';
const SERVICE_VERSION = process.env.OTEL_SERVICE_VERSION || '1.0.0';
const ENVIRONMENT = process.env.OTEL_ENVIRONMENT || process.env.NODE_ENV || 'development';

// Grafana Cloud OTLP configuration
const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '';
const OTLP_HEADERS = process.env.OTEL_EXPORTER_OTLP_HEADERS || '';

// Parse headers string into object (format: "key1=value1,key2=value2")
function parseHeaders(headersString: string): Record<string, string> {
  if (!headersString) return {};

  // Strip surrounding quotes if present (from .env files)
  let cleanString = headersString.trim();
  if ((cleanString.startsWith('"') && cleanString.endsWith('"')) ||
      (cleanString.startsWith("'") && cleanString.endsWith("'"))) {
    cleanString = cleanString.slice(1, -1);
  }

  const headers: Record<string, string> = {};
  cleanString.split(',').forEach((pair) => {
    const [key, ...valueParts] = pair.split('=');
    if (key && valueParts.length > 0) {
      headers[key.trim()] = valueParts.join('=').trim();
    }
  });

  console.log('📊 OpenTelemetry: Parsed headers:', Object.keys(headers));
  return headers;
}

const headers = parseHeaders(OTLP_HEADERS);

// Check if OTel is configured
const isOtelConfigured = !!OTLP_ENDPOINT;

if (!isOtelConfigured) {
  console.log('⚠️  OpenTelemetry: OTEL_EXPORTER_OTLP_ENDPOINT not set, telemetry disabled');
} else {
  console.log(`📊 OpenTelemetry: Initializing for ${SERVICE_NAME} (${ENVIRONMENT})`);
  console.log(`📡 OTLP Endpoint: ${OTLP_ENDPOINT}`);
}

// Create resource with service information
const resource = new Resource({
  [ATTR_SERVICE_NAME]: SERVICE_NAME,
  [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
  'deployment.environment.name': ENVIRONMENT,
});

// Only initialize SDK if endpoint is configured
if (isOtelConfigured) {
  // Create exporters with explicit URLs
  const traceUrl = `${OTLP_ENDPOINT}/v1/traces`;
  const metricUrl = `${OTLP_ENDPOINT}/v1/metrics`;
  const logUrl = `${OTLP_ENDPOINT}/v1/logs`;

  console.log('📊 OpenTelemetry: Trace URL:', traceUrl);
  console.log('📊 OpenTelemetry: Headers configured:', !!headers.Authorization);

  const traceExporter = new OTLPTraceExporter({
    url: traceUrl,
    headers,
  });

  const metricExporter = new OTLPMetricExporter({
    url: metricUrl,
    headers,
  });

  const logExporter = new OTLPLogExporter({
    url: logUrl,
    headers,
  });

  // Create metric reader
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60000, // Export metrics every 60 seconds
  });

  // Initialize the SDK
  const sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader: metricReader as any, // Type assertion for version compatibility
    logRecordProcessors: [new BatchLogRecordProcessor(logExporter)],
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable fs instrumentation to reduce noise
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // Configure HTTP instrumentation - use ignoreIncomingRequestHook for filtering
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (request) => {
            const ignorePaths = ['/health', '/favicon.ico'];
            return ignorePaths.some(path => request.url?.includes(path));
          },
        },
        // Configure Express instrumentation
        '@opentelemetry/instrumentation-express': {
          enabled: true,
        },
      }),
    ],
  });

  // Start the SDK
  sdk.start();

  // Graceful shutdown
  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n📊 OpenTelemetry: Received ${signal}, shutting down...`);
    try {
      await sdk.shutdown();
      console.log('📊 OpenTelemetry: SDK shut down successfully');
    } catch (error) {
      console.error('📊 OpenTelemetry: Error shutting down SDK', error);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  console.log('✅ OpenTelemetry: SDK initialized successfully');
}

export {};
