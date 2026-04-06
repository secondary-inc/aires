// Integration tests that require a running ClickHouse instance.
// Run with: cargo test -p aires-sdk --test clickhouse_test
//
// Requires: docker run -d --name aires-clickhouse -p 8123:8123 clickhouse/clickhouse-server:latest
// And the schema from packages/store/migrations/001_events.sql applied.
#[cfg(test)]
mod tests {

    const CH_URL: &str = "http://localhost:8123/?database=aires";

    fn ch_query(sql: &str) -> Result<String, Box<dyn std::error::Error>> {
        let client = reqwest::blocking::Client::new();
        let resp = client.post(CH_URL).body(sql.to_string()).send()?;
        if !resp.status().is_success() {
            return Err(format!("ClickHouse error: {}", resp.text()?).into());
        }
        Ok(resp.text()?)
    }

    fn ch_available() -> bool {
        reqwest::blocking::get("http://localhost:8123/ping").is_ok()
    }

    #[test]
    fn insert_and_query_basic_event() {
        if !ch_available() {
            eprintln!("SKIP: ClickHouse not available at localhost:8123");
            return;
        }

        let tag = format!("test-{}", uuid::Uuid::now_v7());

        ch_query(&format!(
            "INSERT INTO events (service, severity, message, trace_id, session_id, user_id, kind, category, tags) \
             VALUES ('rust-test', 'info', 'integration test event', '{tag}', 'sess-1', 'user-1', 'log', 'test', ['integration'])"
        )).expect("insert failed");

        std::thread::sleep(std::time::Duration::from_millis(500));

        let rows = ch_query(&format!(
            "SELECT service, severity, message, trace_id, session_id, user_id, kind, category \
             FROM events WHERE trace_id = '{tag}' FORMAT JSONEachRow"
        ))
        .expect("query failed");

        assert!(!rows.is_empty(), "expected at least one row");
        assert!(rows.contains("rust-test"));
        assert!(rows.contains("integration test event"));
        assert!(rows.contains("sess-1"));
        assert!(rows.contains("user-1"));
    }

    #[test]
    fn insert_all_severity_levels() {
        if !ch_available() {
            eprintln!("SKIP: ClickHouse not available at localhost:8123");
            return;
        }

        let tag = format!("sev-{}", uuid::Uuid::now_v7());

        for level in ["trace", "debug", "info", "warn", "error", "fatal"] {
            ch_query(&format!(
                "INSERT INTO events (service, severity, message, trace_id) \
                 VALUES ('rust-test', '{level}', 'level test {level}', '{tag}')"
            ))
            .expect("insert failed");
        }

        std::thread::sleep(std::time::Duration::from_millis(500));

        let count = ch_query(&format!(
            "SELECT count() FROM events WHERE trace_id = '{tag}'"
        ))
        .expect("count failed");

        assert_eq!(count.trim(), "6", "expected 6 events (one per severity)");
    }

    #[test]
    fn insert_with_http_fields() {
        if !ch_available() {
            eprintln!("SKIP: ClickHouse not available at localhost:8123");
            return;
        }

        let tag = format!("http-{}", uuid::Uuid::now_v7());

        ch_query(&format!(
            "INSERT INTO events (service, severity, message, trace_id, kind, \
             http_method, http_path, http_status_code, http_duration_ms) \
             VALUES ('rust-test', 'info', 'POST /agents/list', '{tag}', 'log', \
             'POST', '/agents/list', 200, 42)"
        ))
        .expect("insert failed");

        std::thread::sleep(std::time::Duration::from_millis(500));

        let row = ch_query(&format!(
            "SELECT http_method, http_path, http_status_code, http_duration_ms \
             FROM events WHERE trace_id = '{tag}' FORMAT JSONEachRow"
        ))
        .expect("query failed");

        assert!(row.contains("POST"));
        assert!(row.contains("agents/list") || row.contains("agents\\/list"));
        assert!(row.contains("200"));
        assert!(row.contains("42"));
    }

    #[test]
    fn insert_with_error_fields() {
        if !ch_available() {
            eprintln!("SKIP: ClickHouse not available at localhost:8123");
            return;
        }

        let tag = format!("err-{}", uuid::Uuid::now_v7());

        ch_query(&format!(
            "INSERT INTO events (service, severity, message, trace_id, \
             error_type, error_message, error_stack, error_handled) \
             VALUES ('rust-test', 'error', 'unhandled crash', '{tag}', \
             'TypeError', 'x is undefined', 'at line 42', false)"
        ))
        .expect("insert failed");

        std::thread::sleep(std::time::Duration::from_millis(500));

        let row = ch_query(&format!(
            "SELECT error_type, error_message, error_handled \
             FROM events WHERE trace_id = '{tag}' FORMAT JSONEachRow"
        ))
        .expect("query failed");

        assert!(row.contains("TypeError"));
        assert!(row.contains("x is undefined"));
        assert!(row.contains("false"));
    }

    #[test]
    fn insert_with_metric_fields() {
        if !ch_available() {
            eprintln!("SKIP: ClickHouse not available at localhost:8123");
            return;
        }

        let tag = format!("metric-{}", uuid::Uuid::now_v7());

        ch_query(&format!(
            "INSERT INTO events (service, severity, message, trace_id, kind, \
             metric_name, metric_value, metric_type) \
             VALUES ('rust-test', 'info', 'http.latency', '{tag}', 'log', \
             'http.latency_ms', 42.5, 'gauge')"
        ))
        .expect("insert failed");

        std::thread::sleep(std::time::Duration::from_millis(500));

        let row = ch_query(&format!(
            "SELECT metric_name, metric_value, metric_type \
             FROM events WHERE trace_id = '{tag}' FORMAT JSONEachRow"
        ))
        .expect("query failed");

        assert!(row.contains("http.latency_ms"));
        assert!(row.contains("42.5"));
    }

    #[test]
    fn query_by_bloom_filter_indexes() {
        if !ch_available() {
            eprintln!("SKIP: ClickHouse not available at localhost:8123");
            return;
        }

        let trace = format!("bloom-{}", uuid::Uuid::now_v7());
        let session = format!("bloom-sess-{}", uuid::Uuid::now_v7());
        let user = format!("bloom-user-{}", uuid::Uuid::now_v7());

        ch_query(&format!(
            "INSERT INTO events (service, severity, message, trace_id, session_id, user_id) \
             VALUES ('rust-test', 'info', 'bloom test', '{trace}', '{session}', '{user}')"
        ))
        .expect("insert failed");

        std::thread::sleep(std::time::Duration::from_millis(500));

        // Query by each indexed field
        let by_trace = ch_query(&format!(
            "SELECT count() FROM events WHERE trace_id = '{trace}'"
        ))
        .expect("query failed");
        assert_eq!(by_trace.trim(), "1");

        let by_session = ch_query(&format!(
            "SELECT count() FROM events WHERE session_id = '{session}'"
        ))
        .expect("query failed");
        assert_eq!(by_session.trim(), "1");

        let by_user = ch_query(&format!(
            "SELECT count() FROM events WHERE user_id = '{user}'"
        ))
        .expect("query failed");
        assert_eq!(by_user.trim(), "1");
    }

    #[test]
    fn timestamp_defaults_to_now() {
        if !ch_available() {
            eprintln!("SKIP: ClickHouse not available at localhost:8123");
            return;
        }

        let tag = format!("ts-{}", uuid::Uuid::now_v7());

        ch_query(&format!(
            "INSERT INTO events (service, severity, message, trace_id) \
             VALUES ('rust-test', 'info', 'timestamp test', '{tag}')"
        ))
        .expect("insert failed");

        std::thread::sleep(std::time::Duration::from_millis(500));

        let row = ch_query(&format!(
            "SELECT timestamp FROM events WHERE trace_id = '{tag}' FORMAT JSONEachRow"
        ))
        .expect("query failed");

        // Timestamp should be 2026-xx-xx, not 1970
        assert!(
            row.contains("2026"),
            "timestamp should be current year, got: {row}"
        );
    }
}
