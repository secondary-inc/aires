-- Aires ClickHouse Schema — Migration 002
-- LLM token/cost aggregation views + system metrics rollups
--
-- These materialized views auto-aggregate metric events from the workforce API
-- for fast dashboard queries without scanning the raw events table.

-- ═══════════════════════════════════════════════════════════════════════════
-- LLM Token Usage — per model, per agent, 1-minute buckets
-- ═══════════════════════════════════════════════════════════════════════════

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_llm_token_usage
ENGINE = SummingMergeTree()
PARTITION BY toDate(bucket)
ORDER BY (service, model_id, agent_id, source, bucket)
AS SELECT
    service,
    attributes['modelId'] AS model_id,
    agent_id,
    attributes['source'] AS source,
    toStartOfMinute(timestamp) AS bucket,
    -- Token counters
    sumIf(metric_value, metric_name = 'llm.tokens.prompt') AS prompt_tokens,
    sumIf(metric_value, metric_name = 'llm.tokens.completion') AS completion_tokens,
    sumIf(metric_value, metric_name = 'llm.tokens.total') AS total_tokens,
    sumIf(metric_value, metric_name = 'llm.tokens.cache_read') AS cache_read_tokens,
    sumIf(metric_value, metric_name = 'llm.tokens.cache_write') AS cache_write_tokens,
    -- Cost accumulators (USD)
    sumIf(metric_value, metric_name = 'llm.cost.total') AS total_cost,
    sumIf(metric_value, metric_name = 'llm.cost.input') AS input_cost,
    sumIf(metric_value, metric_name = 'llm.cost.output') AS output_cost,
    sumIf(metric_value, metric_name = 'llm.cost.cache_read') AS cache_read_cost,
    sumIf(metric_value, metric_name = 'llm.cost.cache_write') AS cache_write_cost,
    -- Execution stats
    sumIf(metric_value, metric_name = 'llm.steps.count') AS total_steps,
    sumIf(metric_value, metric_name = 'llm.request.duration_ms') AS total_duration_ms,
    -- Call count (count prompt_tokens events as proxy for call count)
    countIf(metric_name = 'llm.tokens.prompt') AS call_count
FROM events
WHERE metric_name LIKE 'llm.%'
GROUP BY service, model_id, agent_id, source, bucket;

-- ═══════════════════════════════════════════════════════════════════════════
-- LLM Cost — daily rollup per model + agent (for billing/budget dashboards)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_llm_daily_cost
ENGINE = SummingMergeTree()
PARTITION BY toDate(day)
ORDER BY (service, model_id, agent_id, provider, day)
AS SELECT
    service,
    attributes['modelId'] AS model_id,
    agent_id,
    attributes['provider'] AS provider,
    toDate(timestamp) AS day,
    sumIf(metric_value, metric_name = 'llm.cost.total') AS total_cost,
    sumIf(metric_value, metric_name = 'llm.tokens.prompt') AS prompt_tokens,
    sumIf(metric_value, metric_name = 'llm.tokens.completion') AS completion_tokens,
    sumIf(metric_value, metric_name = 'llm.tokens.total') AS total_tokens,
    countIf(metric_name = 'llm.tokens.prompt') AS call_count
FROM events
WHERE metric_name LIKE 'llm.%'
GROUP BY service, model_id, agent_id, provider, day;

-- ═══════════════════════════════════════════════════════════════════════════
-- DB Query Performance — per model, per operation, 1-minute buckets
-- ═══════════════════════════════════════════════════════════════════════════

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_db_query_performance
ENGINE = AggregatingMergeTree()
PARTITION BY toDate(bucket)
ORDER BY (service, db_model, db_operation, bucket)
AS SELECT
    service,
    attributes['model'] AS db_model,
    attributes['operation'] AS db_operation,
    toStartOfMinute(timestamp) AS bucket,
    countState() AS query_count,
    sumState(metric_value) AS total_duration_ms,
    avgState(metric_value) AS avg_duration_ms,
    quantileState(0.95)(metric_value) AS p95_duration_ms,
    quantileState(0.99)(metric_value) AS p99_duration_ms,
    maxState(metric_value) AS max_duration_ms
FROM events
WHERE metric_name = 'db.query.duration_ms'
GROUP BY service, db_model, db_operation, bucket;

-- ═══════════════════════════════════════════════════════════════════════════
-- System Metrics — 1-minute rollups for CPU, memory, RPS
-- ═══════════════════════════════════════════════════════════════════════════

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_system_metrics
ENGINE = AggregatingMergeTree()
PARTITION BY toDate(bucket)
ORDER BY (service, metric_name, bucket)
AS SELECT
    service,
    metric_name,
    toStartOfMinute(timestamp) AS bucket,
    avgState(metric_value) AS avg_value,
    maxState(metric_value) AS max_value,
    minState(metric_value) AS min_value,
    countState() AS sample_count
FROM events
WHERE metric_name LIKE 'system.%'
GROUP BY service, metric_name, bucket;

-- ═══════════════════════════════════════════════════════════════════════════
-- HTTP Request Performance — per route, 1-minute buckets
-- ═══════════════════════════════════════════════════════════════════════════

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_http_request_performance
ENGINE = AggregatingMergeTree()
PARTITION BY toDate(bucket)
ORDER BY (service, route, bucket)
AS SELECT
    service,
    attributes['path'] AS route,
    toStartOfMinute(timestamp) AS bucket,
    countState() AS request_count,
    sumState(metric_value) AS total_duration_ms,
    avgState(metric_value) AS avg_duration_ms,
    quantileState(0.95)(metric_value) AS p95_duration_ms,
    quantileState(0.99)(metric_value) AS p99_duration_ms
FROM events
WHERE metric_name = 'http.request.duration_ms'
GROUP BY service, route, bucket;

-- ═══════════════════════════════════════════════════════════════════════════
-- Indexes for the new metric patterns
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE events ADD INDEX IF NOT EXISTS idx_metric_name metric_name TYPE bloom_filter(0.01) GRANULARITY 4;
