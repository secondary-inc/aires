---
title: "Python SDK: Usage"
description: Using the Aires Python SDK — initialization, log levels, keyword arguments for attributes, and metrics.
---

## Initialization

Initialize the SDK once at application startup:

```python
import aires

aires.init(
    "my-service",
    "http://localhost:4317",
    environment="production",
    batch_size=256,
    queue_capacity=8192,
    tls=True,
    api_key="sk-aires-xxxx",
)
```

### `init()` Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `service` | `str` | Yes | — | Service name |
| `endpoint` | `str` | Yes | — | Collector gRPC endpoint |
| `environment` | `str` | No | `"production"` | Environment name |
| `batch_size` | `int` | No | `256` | Events per batch |
| `queue_capacity` | `int` | No | `8192` | Max buffered events |
| `tls` | `bool` | No | `True` | Enable TLS |
| `api_key` | `str` | No | `None` | API key |

`init()` can only be called once. Calling it a second time raises `RuntimeError("aires already initialized")`.

## Log Levels

Six severity levels are available as module-level functions:

```python
import aires

aires.trace("entering inner loop")
aires.debug("parsed 42 config entries")
aires.info("server listening on :8000")
aires.warn("connection pool at 80%")
aires.error("request handler raised exception")
aires.fatal("database unreachable")
```

All logging functions accept the message as the first positional argument and optional keyword arguments for context.

## Keyword Arguments

Any keyword argument passed to a logging function is processed as follows:

- **Known keys** (`trace_id`, `span_id`, `session_id`, `user_id`, `agent_id`, `category`) are mapped to their corresponding event fields
- **All other keys** are stored as string attributes

```python
# Known keys are mapped to event fields
aires.info("user logged in",
    trace_id="trace-abc-123",
    span_id="span-001",
    session_id="sess-789",
    user_id="user-42",
    agent_id="planner-v2",
    category="auth",
)

# Unknown keys become attributes
aires.info("order processed",
    order_id="ord-456",
    amount="14999",
    currency="usd",
    payment_method="stripe",
)
```

All values must be strings. The SDK passes keyword arguments as `HashMap<String, String>` to the Rust core.

### Complete Example

```python
import aires

aires.init("order-service", "http://localhost:4317", environment="production")

# Simple log
aires.info("service started", port="8000", version="1.2.0")

# With tracing context
aires.info("processing order",
    trace_id="trace-abc-123",
    span_id="span-001",
    category="payment",
    order_id="ord-456",
    customer="cust-789",
)

# Error with context
try:
    result = db.execute("SELECT ...")
except Exception as e:
    aires.error(f"database query failed: {e}",
        trace_id="trace-abc-123",
        category="db",
        error_type=type(e).__name__,
        query="SELECT ...",
    )
```

## Metrics

Record metric values with `aires.metric()`:

```python
aires.metric("http.request.duration_ms", 47.2,
    method="POST",
    path="/api/tasks",
    status="201",
)

aires.metric("db.connections.active", 42.0,
    pool="primary",
)

aires.metric("queue.depth", 1523.0,
    queue="task-processing",
)
```

### `metric()` Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | `str` | Yes | Metric name (dot-separated) |
| `value` | `float` | Yes | Numeric value |
| `**kwargs` | `str` | No | Additional attributes (key-value pairs) |

## Django Integration

```python
# settings.py
import aires

aires.init(
    "django-app",
    "http://localhost:4317",
    environment="production",
)

# middleware.py
import time
import uuid
import aires

class AiresMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        trace_id = request.headers.get("X-Trace-Id", str(uuid.uuid4()))
        start = time.perf_counter()

        response = self.get_response(request)

        duration_ms = (time.perf_counter() - start) * 1000

        aires.info(f"{request.method} {request.path}",
            trace_id=trace_id,
            category="http",
            method=request.method,
            path=request.path,
            status=str(response.status_code),
            duration_ms=f"{duration_ms:.1f}",
        )

        aires.metric("http.request.duration_ms", duration_ms,
            method=request.method,
            path=request.path,
            status=str(response.status_code),
        )

        return response
```

## FastAPI Integration

```python
import time
import uuid
import aires
from fastapi import FastAPI, Request

app = FastAPI()

aires.init("fastapi-app", "http://localhost:4317", environment="production")

@app.middleware("http")
async def aires_middleware(request: Request, call_next):
    trace_id = request.headers.get("x-trace-id", str(uuid.uuid4()))
    start = time.perf_counter()

    response = await call_next(request)

    duration_ms = (time.perf_counter() - start) * 1000

    aires.info(f"{request.method} {request.url.path}",
        trace_id=trace_id,
        category="http",
        method=request.method,
        path=request.url.path,
        status=str(response.status_code),
        duration_ms=f"{duration_ms:.1f}",
    )

    aires.metric("http.request.duration_ms", duration_ms,
        method=request.method,
        path=request.url.path,
        status=str(response.status_code),
    )

    return response
```

## Flask Integration

```python
import time
import uuid
import aires
from flask import Flask, request, g

app = Flask(__name__)

aires.init("flask-app", "http://localhost:4317", environment="production")

@app.before_request
def before_request():
    g.trace_id = request.headers.get("X-Trace-Id", str(uuid.uuid4()))
    g.request_start = time.perf_counter()

@app.after_request
def after_request(response):
    duration_ms = (time.perf_counter() - g.request_start) * 1000

    aires.info(f"{request.method} {request.path}",
        trace_id=g.trace_id,
        category="http",
        method=request.method,
        path=request.path,
        status=str(response.status_code),
        duration_ms=f"{duration_ms:.1f}",
    )

    aires.metric("http.request.duration_ms", duration_ms,
        method=request.method,
        path=request.path,
        status=str(response.status_code),
    )

    return response
```

## Thread Safety

The Python SDK uses a `OnceLock<Aires>` in Rust — the global instance is thread-safe. You can call `aires.info()`, `aires.error()`, etc. from any thread (including `ThreadPoolExecutor` workers) without synchronization.

```python
from concurrent.futures import ThreadPoolExecutor
import aires

aires.init("worker", "http://localhost:4317")

def process_task(task_id):
    aires.info(f"processing task {task_id}", task_id=task_id)
    # ... work ...
    aires.info(f"completed task {task_id}", task_id=task_id)

with ThreadPoolExecutor(max_workers=8) as pool:
    pool.map(process_task, range(100))
```
