---
title: "Storage: Retention & Tiered Storage"
description: TTL policies, hot/warm/cold storage tiers, and S3 integration for long-term Aires event retention.
---

## TTL (Time-To-Live) Policies

ClickHouse TTL policies automatically expire old data. The default Aires schema sets a 30-day TTL:

```sql
TTL toDateTime(timestamp) + INTERVAL 30 DAY
```

When a partition exceeds the TTL, ClickHouse drops it during background merges. No manual cleanup is needed.

### Customizing TTL

Change the retention period by altering the table:

```sql
-- Extend to 90 days
ALTER TABLE aires.events
MODIFY TTL toDateTime(timestamp) + INTERVAL 90 DAY;

-- Extend to 1 year
ALTER TABLE aires.events
MODIFY TTL toDateTime(timestamp) + INTERVAL 365 DAY;

-- Remove TTL (keep forever)
ALTER TABLE aires.events
REMOVE TTL;
```

### Per-Severity TTL

Keep errors longer than debug logs:

```sql
ALTER TABLE aires.events
MODIFY TTL
    toDateTime(timestamp) + INTERVAL 7 DAY
        DELETE WHERE severity IN ('trace', 'debug'),
    toDateTime(timestamp) + INTERVAL 30 DAY
        DELETE WHERE severity = 'info',
    toDateTime(timestamp) + INTERVAL 90 DAY
        DELETE WHERE severity IN ('warn', 'error', 'fatal');
```

This keeps:
- `trace` and `debug` events for 7 days
- `info` events for 30 days
- `warn`, `error`, and `fatal` events for 90 days

### Per-Category TTL

Keep HTTP request logs shorter than business events:

```sql
ALTER TABLE aires.events
MODIFY TTL
    toDateTime(timestamp) + INTERVAL 7 DAY
        DELETE WHERE category = 'http' AND severity IN ('trace', 'debug', 'info'),
    toDateTime(timestamp) + INTERVAL 30 DAY
        DELETE WHERE category = 'http' AND severity IN ('warn', 'error', 'fatal'),
    toDateTime(timestamp) + INTERVAL 90 DAY;
```

## Tiered Storage

ClickHouse supports tiered storage policies that move data between storage volumes as it ages. This lets you keep recent data on fast NVMe drives and older data on cheaper storage.

### Storage Policy Configuration

Configure storage policies in ClickHouse's `config.xml` (or the `config.d/` directory):

```xml
<!-- /etc/clickhouse-server/config.d/storage.xml -->
<clickhouse>
  <storage_configuration>
    <disks>
      <hot>
        <path>/data/clickhouse/hot/</path>
      </hot>
      <warm>
        <path>/data/clickhouse/warm/</path>
      </warm>
      <cold>
        <type>s3</type>
        <endpoint>https://s3.us-east-1.amazonaws.com/aires-cold-storage/data/</endpoint>
        <access_key_id>AKIA...</access_key_id>
        <secret_access_key>...</secret_access_key>
      </cold>
    </disks>

    <policies>
      <tiered>
        <volumes>
          <hot>
            <disk>hot</disk>
          </hot>
          <warm>
            <disk>warm</disk>
          </warm>
          <cold>
            <disk>cold</disk>
          </cold>
        </volumes>
      </tiered>
    </policies>
  </storage_configuration>
</clickhouse>
```

### Apply Storage Policy to Table

```sql
-- Create table with tiered storage
CREATE TABLE aires.events
(
    -- ... columns ...
)
ENGINE = MergeTree()
PARTITION BY toDate(timestamp)
ORDER BY (service, severity, timestamp)
TTL
    toDateTime(timestamp) + INTERVAL 7 DAY TO VOLUME 'warm',
    toDateTime(timestamp) + INTERVAL 30 DAY TO VOLUME 'cold',
    toDateTime(timestamp) + INTERVAL 365 DAY DELETE
SETTINGS
    storage_policy = 'tiered',
    index_granularity = 8192;
```

Or alter an existing table:

```sql
ALTER TABLE aires.events
MODIFY SETTING storage_policy = 'tiered';

ALTER TABLE aires.events
MODIFY TTL
    toDateTime(timestamp) + INTERVAL 7 DAY TO VOLUME 'warm',
    toDateTime(timestamp) + INTERVAL 30 DAY TO VOLUME 'cold',
    toDateTime(timestamp) + INTERVAL 365 DAY DELETE;
```

### Tier Strategy

| Tier | Storage | Age | Use Case |
|------|---------|-----|----------|
| **Hot** | NVMe SSD | 0-7 days | Real-time dashboards, alerting, active debugging |
| **Warm** | SATA SSD / HDD | 7-30 days | Incident investigation, trend analysis |
| **Cold** | S3 / GCS / MinIO | 30-365 days | Compliance, audit trails, historical analysis |

## S3 Integration

### AWS S3

```xml
<cold>
  <type>s3</type>
  <endpoint>https://s3.us-east-1.amazonaws.com/my-bucket/aires/</endpoint>
  <access_key_id>AKIA...</access_key_id>
  <secret_access_key>...</secret_access_key>
</cold>
```

### S3-Compatible (MinIO)

For self-hosted S3-compatible storage:

```xml
<cold>
  <type>s3</type>
  <endpoint>http://minio:9000/aires-bucket/data/</endpoint>
  <access_key_id>minioadmin</access_key_id>
  <secret_access_key>minioadmin</secret_access_key>
  <use_environment_credentials>false</use_environment_credentials>
</cold>
```

### Google Cloud Storage

```xml
<cold>
  <type>s3</type>
  <endpoint>https://storage.googleapis.com/my-bucket/aires/</endpoint>
  <access_key_id>GOOG...</access_key_id>
  <secret_access_key>...</secret_access_key>
</cold>
```

GCS works with ClickHouse's S3 disk type via the S3-compatible API.

## Manual Partition Management

### List partitions

```sql
SELECT
    partition,
    name,
    rows,
    formatReadableSize(bytes_on_disk) AS size,
    disk_name
FROM system.parts
WHERE database = 'aires' AND table = 'events'
  AND active
ORDER BY partition DESC;
```

### Move a partition to cold storage

```sql
ALTER TABLE aires.events
MOVE PARTITION '2024-01-15' TO VOLUME 'cold';
```

### Drop a specific day

```sql
ALTER TABLE aires.events
DROP PARTITION '2024-01-15';
```

### Detach and re-attach (for backup)

```sql
-- Detach (removes from active table, keeps files)
ALTER TABLE aires.events
DETACH PARTITION '2024-01-15';

-- Re-attach later
ALTER TABLE aires.events
ATTACH PARTITION '2024-01-15';
```

## Cost Estimation

Assuming 10x compression and the following event volumes:

| Daily Volume | Raw/Day | Compressed/Day | Hot (7d) | Warm (30d) | Cold (365d) |
|-------------|---------|-----------------|----------|------------|-------------|
| 10M events | 5 GB | 0.5 GB | 3.5 GB | 15 GB | 183 GB |
| 100M events | 50 GB | 5 GB | 35 GB | 150 GB | 1.8 TB |
| 1B events | 500 GB | 50 GB | 350 GB | 1.5 TB | 18 TB |

With S3 at ~$0.023/GB/month, 1 year of cold storage for 100M events/day costs ~$41/month. Compare this to Datadog at $0.10/GB ingested: 50 GB/day * 30 days * $0.10 = $150/day = **$4,500/month**.
