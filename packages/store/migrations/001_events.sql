-- Aires ClickHouse Schema
-- Events table: the core storage for all observability data

CREATE TABLE IF NOT EXISTS events (
    -- Identity
    id UUID DEFAULT generateUUIDv4(),
    timestamp DateTime64(9, 'UTC'),
    observed_timestamp DateTime64(9, 'UTC') DEFAULT now64(9),

    -- Classification
    service LowCardinality(String),
    environment LowCardinality(String),
    host String DEFAULT '',
    instance String DEFAULT '',
    severity Enum8(
        'unspecified' = 0,
        'trace' = 1,
        'debug' = 2,
        'info' = 3,
        'warn' = 4,
        'error' = 5,
        'fatal' = 6
    ),

    -- Content
    message String,
    display_text String DEFAULT '',
    body String DEFAULT '',

    -- Tracing
    trace_id String DEFAULT '',
    span_id String DEFAULT '',
    parent_span_id String DEFAULT '',
    subtrace_id String DEFAULT '',

    -- Session
    session_id String DEFAULT '',
    user_id String DEFAULT '',
    agent_id String DEFAULT '',

    -- Source
    source_file String DEFAULT '',
    source_line UInt32 DEFAULT 0,
    source_function String DEFAULT '',

    -- Categorization
    category LowCardinality(String) DEFAULT '',
    kind LowCardinality(String) DEFAULT 'log',
    tags Array(String) DEFAULT [],

    -- Structured data (stored as JSON strings)
    attributes Map(String, String),
    data Map(String, String),

    -- Related objects
    related Nested(
        type String,
        id String,
        label String,
        url String
    ),

    -- HTTP
    http_method LowCardinality(String) DEFAULT '',
    http_path String DEFAULT '',
    http_status_code UInt16 DEFAULT 0,
    http_request_size UInt64 DEFAULT 0,
    http_response_size UInt64 DEFAULT 0,
    http_duration_ms Int64 DEFAULT 0,
    http_user_agent String DEFAULT '',
    http_remote_addr String DEFAULT '',

    -- Metrics
    metric_name String DEFAULT '',
    metric_value Float64 DEFAULT 0,
    metric_unit LowCardinality(String) DEFAULT '',
    metric_type Enum8(
        'unspecified' = 0,
        'gauge' = 1,
        'counter' = 2,
        'histogram' = 3,
        'summary' = 4
    ) DEFAULT 'unspecified',

    -- Error
    error_type String DEFAULT '',
    error_message String DEFAULT '',
    error_stack String DEFAULT '',
    error_handled Bool DEFAULT true,

    -- Resource (set by collector)
    resource_cluster String DEFAULT '',
    resource_namespace String DEFAULT '',
    resource_pod String DEFAULT '',
    resource_container String DEFAULT '',
    resource_node String DEFAULT '',

    -- SDK
    sdk_name LowCardinality(String) DEFAULT '',
    sdk_version String DEFAULT '',
    sdk_language LowCardinality(String) DEFAULT ''
)
ENGINE = MergeTree()
PARTITION BY toDate(timestamp)
ORDER BY (service, timestamp, trace_id)
TTL toDate(timestamp) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- Secondary indexes for common queries
ALTER TABLE events ADD INDEX idx_trace_id trace_id TYPE bloom_filter(0.01) GRANULARITY 4;
ALTER TABLE events ADD INDEX idx_session_id session_id TYPE bloom_filter(0.01) GRANULARITY 4;
ALTER TABLE events ADD INDEX idx_user_id user_id TYPE bloom_filter(0.01) GRANULARITY 4;
ALTER TABLE events ADD INDEX idx_agent_id agent_id TYPE bloom_filter(0.01) GRANULARITY 4;
ALTER TABLE events ADD INDEX idx_severity severity TYPE set(0) GRANULARITY 1;
ALTER TABLE events ADD INDEX idx_category category TYPE set(0) GRANULARITY 1;
ALTER TABLE events ADD INDEX idx_kind kind TYPE set(0) GRANULARITY 1;
ALTER TABLE events ADD INDEX idx_message message TYPE tokenbf_v1(10240, 3, 0) GRANULARITY 4;

-- Materialized view: per-service error rate (1-minute buckets)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_error_rate
ENGINE = SummingMergeTree()
PARTITION BY toDate(bucket)
ORDER BY (service, bucket)
AS SELECT
    service,
    toStartOfMinute(timestamp) AS bucket,
    countIf(severity IN ('error', 'fatal')) AS error_count,
    count() AS total_count
FROM events
GROUP BY service, bucket;

-- Materialized view: per-service request latency (for http events)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_http_latency
ENGINE = AggregatingMergeTree()
PARTITION BY toDate(bucket)
ORDER BY (service, http_path, bucket)
AS SELECT
    service,
    http_path,
    toStartOfMinute(timestamp) AS bucket,
    quantileState(0.5)(http_duration_ms) AS p50,
    quantileState(0.95)(http_duration_ms) AS p95,
    quantileState(0.99)(http_duration_ms) AS p99,
    count() AS request_count,
    avg(http_duration_ms) AS avg_ms
FROM events
WHERE kind = 'http' AND http_duration_ms > 0
GROUP BY service, http_path, bucket;
