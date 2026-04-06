---
title: "Collector: OpenTelemetry Compatibility"
description: Ingesting OpenTelemetry data — OTLP over gRPC, converting OTel spans and logs to Aires events, firehose mode.
---

## Overview

The Aires collector can ingest OpenTelemetry data alongside native Aires events. This enables incremental migration — keep your existing OTel instrumentation while adding Aires-native events for richer observability.

## OTLP Ingestion

The collector accepts OTLP (OpenTelemetry Protocol) data over gRPC on the same port as native Aires ingestion. OTel-instrumented applications can point their OTLP exporter directly at the Aires collector.

### OTel SDK Configuration

Configure your OpenTelemetry SDK to export to the Aires collector:

**Node.js (OTel JS)**:

```typescript
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc"

const traceExporter = new OTLPTraceExporter({
  url: "http://localhost:4317",
})

const logExporter = new OTLPLogExporter({
  url: "http://localhost:4317",
})
```

**Python (OTel Python)**:

```python
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.exporter.otlp.proto.grpc.log_exporter import OTLPLogExporter

trace_exporter = OTLPSpanExporter(endpoint="localhost:4317", insecure=True)
log_exporter = OTLPLogExporter(endpoint="localhost:4317", insecure=True)
```

**Go (OTel Go)**:

```go
import "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"

exporter, err := otlptracegrpc.New(ctx,
    otlptracegrpc.WithEndpoint("localhost:4317"),
    otlptracegrpc.WithInsecure(),
)
```

**Environment variable (any OTel SDK)**:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
export OTEL_EXPORTER_OTLP_PROTOCOL="grpc"
```

## Conversion: OTel Spans to Aires Events

When the collector receives an OTLP `ExportTraceServiceRequest`, each span is converted to an Aires `Event`:

| OTel Span Field | Aires Event Field | Notes |
|----------------|-------------------|-------|
| `traceId` | `trace_id` | Hex-encoded to string |
| `spanId` | `span_id` | Hex-encoded to string |
| `parentSpanId` | `parent_span_id` | Hex-encoded to string |
| `name` | `message` | Span name becomes the message |
| `kind` | `kind` | Mapped: `SPAN_KIND_SERVER` → `"server"`, etc. |
| `startTimeUnixNano` | `timestamp_ns` | Direct mapping |
| `endTimeUnixNano` | Used to compute `http_duration_ms` | `(end - start) / 1_000_000` |
| `status.code` | `severity` | `OK` → `info`, `ERROR` → `error` |
| `status.message` | `error_message` | If status is ERROR |
| `attributes` | `attributes` | String values mapped directly |
| Resource `service.name` | `service` | From OTel resource attributes |
| Resource `deployment.environment` | `environment` | From OTel resource attributes |
| Resource `host.name` | `host` | From OTel resource attributes |

### HTTP Semantic Conventions

OTel HTTP spans using semantic conventions are automatically mapped:

| OTel Attribute | Aires Field |
|---------------|-------------|
| `http.request.method` or `http.method` | `http_method` |
| `url.path` or `http.target` | `http_path` |
| `http.response.status_code` or `http.status_code` | `http_status_code` |

The collector sets `category = "http"` for spans with HTTP attributes.

## Conversion: OTel Logs to Aires Events

OTLP log records are converted similarly:

| OTel Log Field | Aires Event Field |
|---------------|-------------------|
| `timeUnixNano` | `timestamp_ns` |
| `severityNumber` | `severity` (mapped: 1-4 → trace, 5-8 → debug, 9-12 → info, 13-16 → warn, 17-20 → error, 21-24 → fatal) |
| `severityText` | Used as fallback for severity |
| `body` (string) | `message` |
| `traceId` | `trace_id` |
| `spanId` | `span_id` |
| `attributes` | `attributes` |
| Resource `service.name` | `service` |

## Firehose Mode

Firehose mode passes OTel data through with minimal transformation — it preserves the original attribute names and values without mapping to Aires-specific fields. This is useful when you want raw OTel data in ClickHouse for custom analysis.

Enable firehose mode via environment variable:

```bash
export AIRES_OTEL_FIREHOSE=true
```

In firehose mode:
- All OTel attributes are stored as-is in the `attributes` map
- No semantic convention mapping is applied
- The `kind` field is set to `"otel-span"` or `"otel-log"` for easy filtering
- Original span/log bytes can be stored in the `body` field

### Querying Firehose Data

```sql
-- Find all OTel spans
SELECT *
FROM events
WHERE kind = 'otel-span'
  AND timestamp > now() - INTERVAL 1 HOUR;

-- Query using original OTel attribute names
SELECT
    message,
    attributes['http.request.method'] AS method,
    attributes['url.path'] AS path,
    attributes['http.response.status_code'] AS status
FROM events
WHERE kind = 'otel-span'
  AND attributes['http.request.method'] != '';
```

## Mixed Mode

You can send both native Aires events and OTel data to the same collector. They'll coexist in the same ClickHouse table:

```sql
-- See the mix of native and OTel events
SELECT
    kind,
    sdk_name,
    count() AS event_count
FROM events
WHERE timestamp > now() - INTERVAL 1 HOUR
GROUP BY kind, sdk_name;
```

Native Aires events will have `sdk_name = "aires-sdk-rust"` (or `"aires-sdk-ts"`, `"aires-sdk-python"`), while OTel events will have `sdk_name = "opentelemetry"`.

## Migration Strategy

1. **Phase 1**: Point your OTel exporters at the Aires collector. All existing instrumentation continues working. Query OTel data in ClickHouse.

2. **Phase 2**: Add Aires-native instrumentation alongside OTel for richer data (agent tracking, structured data fields, display text). Both coexist.

3. **Phase 3**: Gradually replace OTel instrumentation with native Aires SDKs where the richer event model adds value. Keep OTel for libraries and frameworks that only support OTel.

## Limitations

- **OTel Metrics**: OTLP metrics ingestion is not yet supported. Use Aires-native `metric()` calls for metrics, or use a separate OTel metrics backend (Prometheus).
- **Baggage propagation**: The collector doesn't propagate W3C Baggage. Use Aires SDK trace context propagation for cross-service correlation.
- **Span links**: OTel span links are stored in the `data` field as JSON, not as first-class fields.
