---
title: "Collector: Setup"
description: Setting up the Aires collector — Elixir/Erlang installation, Docker deployment, and Kubernetes configuration.
---

## Overview

The Aires collector is an Elixir/OTP application that receives events via gRPC, transforms them from Protobuf to flat row format, and inserts them into ClickHouse using a Broadway pipeline.

## Docker (Recommended)

The easiest way to run the collector:

```bash
docker run -d \
  --name aires-collector \
  -p 4317:4317 \
  -e GRPC_PORT=4317 \
  -e CLICKHOUSE_HOST=clickhouse \
  -e CLICKHOUSE_PORT=8123 \
  -e CLICKHOUSE_DATABASE=aires \
  -e CLICKHOUSE_USER=default \
  -e CLICKHOUSE_PASSWORD="" \
  ghcr.io/secondary-inc/aires-collector:latest
```

### Docker Compose

For a complete stack with ClickHouse:

```yaml
# docker-compose.yml
services:
  clickhouse:
    image: clickhouse/clickhouse-server:24.8
    ports:
      - "8123:8123"
      - "9000:9000"
    volumes:
      - clickhouse_data:/var/lib/clickhouse
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql
    environment:
      CLICKHOUSE_DB: aires
      CLICKHOUSE_USER: default
      CLICKHOUSE_PASSWORD: ""
    healthcheck:
      test: ["CMD", "clickhouse-client", "--query", "SELECT 1"]
      interval: 5s
      timeout: 3s
      retries: 10

  collector:
    image: ghcr.io/secondary-inc/aires-collector:latest
    ports:
      - "4317:4317"
    environment:
      GRPC_PORT: "4317"
      CLICKHOUSE_HOST: clickhouse
      CLICKHOUSE_PORT: "8123"
      CLICKHOUSE_DATABASE: aires
      CLICKHOUSE_USER: default
      CLICKHOUSE_PASSWORD: ""
    depends_on:
      clickhouse:
        condition: service_healthy

volumes:
  clickhouse_data:
```

```bash
docker compose up -d
```

## Building from Source

### Prerequisites

- **Erlang/OTP 26+**: The BEAM VM
- **Elixir 1.17+**: The language and build tool
- **Protobuf compiler** (`protoc`): For compiling the gRPC service definitions

Install Erlang and Elixir (macOS):

```bash
brew install erlang elixir protobuf
```

Install Erlang and Elixir (Ubuntu):

```bash
# Using asdf (recommended)
asdf plugin add erlang
asdf plugin add elixir
asdf install erlang 26.2
asdf install elixir 1.17.0-otp-26
asdf global erlang 26.2
asdf global elixir 1.17.0-otp-26
```

### Build and Run

From the `packages/collector` directory:

```bash
# Install dependencies
mix deps.get

# Compile
mix compile

# Run in development
CLICKHOUSE_HOST=localhost mix run --no-halt

# Run in production
MIX_ENV=prod mix release
_build/prod/rel/aires_collector/bin/aires_collector start
```

### Project Structure

```
packages/collector/
├── mix.exs                          # Project configuration and dependencies
├── lib/
│   ├── aires_collector.ex           # Main module
│   └── aires_collector/
│       ├── application.ex           # OTP application supervisor
│       ├── endpoint.ex              # gRPC endpoint configuration
│       ├── server.ex                # gRPC request handlers (Ingest, IngestStream)
│       ├── pipeline.ex              # Broadway pipeline for batched inserts
│       ├── store.ex                 # ClickHouse connection and insert logic
│       └── transform.ex            # Proto Event → flat row transformation
```

### Dependencies

The collector uses these key dependencies (from `mix.exs`):

| Dependency | Version | Purpose |
|------------|---------|---------|
| `grpc` | ~> 0.9 | gRPC server framework |
| `protobuf` | ~> 0.13 | Protobuf encoding/decoding |
| `ch` | ~> 0.3 | ClickHouse client |
| `db_connection` | ~> 2.7 | Database connection pooling |
| `broadway` | ~> 1.1 | Batched pipeline processing |
| `jason` | ~> 1.4 | JSON encoding |
| `vapor` | ~> 0.10 | Configuration management |
| `telemetry` | ~> 1.3 | Metrics and instrumentation |

## Kubernetes Deployment

### Deployment

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: aires-collector
  labels:
    app: aires-collector
spec:
  replicas: 2
  selector:
    matchLabels:
      app: aires-collector
  template:
    metadata:
      labels:
        app: aires-collector
    spec:
      containers:
        - name: collector
          image: ghcr.io/secondary-inc/aires-collector:latest
          ports:
            - containerPort: 4317
              name: grpc
          env:
            - name: GRPC_PORT
              value: "4317"
            - name: CLICKHOUSE_HOST
              valueFrom:
                configMapKeyRef:
                  name: aires-config
                  key: clickhouse-host
            - name: CLICKHOUSE_PORT
              value: "8123"
            - name: CLICKHOUSE_DATABASE
              value: "aires"
            - name: CLICKHOUSE_USER
              valueFrom:
                secretKeyRef:
                  name: aires-secrets
                  key: clickhouse-user
            - name: CLICKHOUSE_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: aires-secrets
                  key: clickhouse-password
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
          readinessProbe:
            grpc:
              port: 4317
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            grpc:
              port: 4317
            initialDelaySeconds: 10
            periodSeconds: 30
```

### Service

```yaml
# k8s/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: aires-collector
spec:
  selector:
    app: aires-collector
  ports:
    - port: 4317
      targetPort: 4317
      protocol: TCP
      name: grpc
  type: ClusterIP
```

SDKs within the cluster connect to `aires-collector:4317`.

### Horizontal Pod Autoscaler

```yaml
# k8s/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: aires-collector
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: aires-collector
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
```

## OTP Supervision Tree

The collector starts four supervised children:

```
AiresCollector.Supervisor (one_for_one)
├── AiresCollector.Store         # GenServer: ClickHouse connection
├── GRPC.Server.Supervisor       # gRPC server on configured port
├── AiresCollector.Pipeline      # Broadway: batched processing
└── AiresCollector.Telemetry     # Telemetry event handlers
```

The `one_for_one` strategy means if any child crashes, only that child is restarted. The gRPC server and Broadway pipeline are independent — a ClickHouse connection failure doesn't take down gRPC ingestion (events will be retried via Broadway).

## Next Steps

- **[Configuration](/collector/config/)** — Environment variables and tuning options
- **[OpenTelemetry](/collector/otel/)** — OTLP ingestion compatibility
