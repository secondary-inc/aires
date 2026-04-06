defmodule AiresCollector.TransformTest do
  use ExUnit.Case

  alias AiresCollector.Transform

  test "event_to_row produces map with all required fields" do
    event = %{
      id: "evt-001",
      timestamp_ns: 1_704_067_200_000_000_000,
      service: "test-svc",
      environment: "test",
      host: "pod-1",
      instance: "replica-0",
      severity: 3,
      message: "hello world",
      display_text: "Hello World",
      body: "",
      trace_id: "trace-abc",
      span_id: "span-xyz",
      parent_span_id: "",
      subtrace_id: "",
      session_id: "sess-1",
      user_id: "user-1",
      agent_id: "agent-1",
      source_file: "lib/test.ex",
      source_line: 42,
      source_function: "handle_call",
      category: "http",
      kind: "request",
      tags: ["api", "v2"],
      http: %{method: "POST", path: "/events", status_code: 200, duration_ms: 15},
      metric: nil,
      error: nil
    }

    row = Transform.event_to_row(event, "aires-sdk-test", "0.1.0")

    assert row.id == "evt-001"
    assert row.service == "test-svc"
    assert row.environment == "test"
    assert row.severity == "info"
    assert row.message == "hello world"
    assert row.trace_id == "trace-abc"
    assert row.session_id == "sess-1"
    assert row.user_id == "user-1"
    assert row.agent_id == "agent-1"
    assert row.source_file == "lib/test.ex"
    assert row.source_line == 42
    assert row.category == "http"
    assert row.kind == "request"
    assert row.tags == ["api", "v2"]
    assert row.http_method == "POST"
    assert row.http_path == "/events"
    assert row.http_status_code == 200
    assert row.http_duration_ms == 15
    assert row.sdk_name == "aires-sdk-test"
    assert row.sdk_version == "0.1.0"
  end

  test "severity mapping covers all values" do
    assert Transform.event_to_row(%{severity: 0}, "", "").severity == "unspecified"
    assert Transform.event_to_row(%{severity: 1}, "", "").severity == "trace"
    assert Transform.event_to_row(%{severity: 2}, "", "").severity == "debug"
    assert Transform.event_to_row(%{severity: 3}, "", "").severity == "info"
    assert Transform.event_to_row(%{severity: 4}, "", "").severity == "warn"
    assert Transform.event_to_row(%{severity: 5}, "", "").severity == "error"
    assert Transform.event_to_row(%{severity: 6}, "", "").severity == "fatal"
    assert Transform.event_to_row(%{severity: 99}, "", "").severity == "unspecified"
  end

  test "nil fields default gracefully" do
    row = Transform.event_to_row(%{}, "", "")

    assert row.message == ""
    assert row.trace_id == ""
    assert row.tags == []
    assert row.source_line == 0
    assert row.http_method == ""
    assert row.http_status_code == 0
    assert row.metric_value == 0.0
    assert row.error_handled == true
  end

  test "timestamp conversion from nanoseconds" do
    # 2024-01-01 00:00:00 UTC in nanoseconds
    ns = 1_704_067_200_000_000_000
    row = Transform.event_to_row(%{timestamp_ns: ns}, "", "")

    assert %DateTime{} = row.timestamp
    assert row.timestamp.year == 2024
    assert row.timestamp.month == 1
    assert row.timestamp.day == 1
  end

  test "zero timestamp defaults to now" do
    row = Transform.event_to_row(%{timestamp_ns: 0}, "", "")
    assert %DateTime{} = row.timestamp
    # Should be roughly now
    assert DateTime.diff(DateTime.utc_now(), row.timestamp) < 2
  end

  test "metric fields extracted" do
    event = %{
      metric: %{name: "http.latency", value: 42.5, unit: "ms"}
    }

    row = Transform.event_to_row(event, "", "")

    assert row.metric_name == "http.latency"
    assert row.metric_value == 42.5
  end

  test "error fields extracted" do
    event = %{
      error: %{type: "RuntimeError", message: "boom", stack: "at line 1", handled: false}
    }

    row = Transform.event_to_row(event, "", "")

    assert row.error_type == "RuntimeError"
    assert row.error_message == "boom"
    assert row.error_stack == "at line 1"
    assert row.error_handled == false
  end
end
