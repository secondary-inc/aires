defmodule AiresCollector.Transform do
  @moduledoc """
  Transforms proto Event structs into flat maps for ClickHouse insertion.
  """

  def event_to_row(event, sdk_name, sdk_version) do
    %{
      id: event.id || UUID.uuid4(),
      timestamp: ns_to_datetime(event.timestamp_ns),
      service: event.service || "",
      environment: event.environment || "",
      host: event.host || "",
      instance: event.instance || "",
      severity: severity_to_string(event.severity),
      message: event.message || "",
      display_text: event.display_text || "",
      body: event.body || "",
      trace_id: event.trace_id || "",
      span_id: event.span_id || "",
      parent_span_id: event.parent_span_id || "",
      subtrace_id: event.subtrace_id || "",
      session_id: event.session_id || "",
      user_id: event.user_id || "",
      agent_id: event.agent_id || "",
      source_file: event.source_file || "",
      source_line: event.source_line || 0,
      source_function: event.source_function || "",
      category: event.category || "",
      kind: event.kind || "log",
      tags: event.tags || [],
      http_method: get_in(event, [:http, :method]) || "",
      http_path: get_in(event, [:http, :path]) || "",
      http_status_code: get_in(event, [:http, :status_code]) || 0,
      http_duration_ms: get_in(event, [:http, :duration_ms]) || 0,
      metric_name: get_in(event, [:metric, :name]) || "",
      metric_value: get_in(event, [:metric, :value]) || 0.0,
      error_type: get_in(event, [:error, :type]) || "",
      error_message: get_in(event, [:error, :message]) || "",
      error_stack: get_in(event, [:error, :stack]) || "",
      error_handled: get_in(event, [:error, :handled]) || true,
      sdk_name: sdk_name || "",
      sdk_version: sdk_version || "",
      sdk_language: "rust"
    }
  end

  defp ns_to_datetime(0), do: DateTime.utc_now()
  defp ns_to_datetime(nil), do: DateTime.utc_now()

  defp ns_to_datetime(ns) when is_integer(ns) do
    seconds = div(ns, 1_000_000_000)
    nanoseconds = rem(ns, 1_000_000_000)

    DateTime.from_unix!(seconds, :second)
    |> DateTime.add(nanoseconds, :nanosecond)
  end

  defp severity_to_string(0), do: "unspecified"
  defp severity_to_string(1), do: "trace"
  defp severity_to_string(2), do: "debug"
  defp severity_to_string(3), do: "info"
  defp severity_to_string(4), do: "warn"
  defp severity_to_string(5), do: "error"
  defp severity_to_string(6), do: "fatal"
  defp severity_to_string(_), do: "unspecified"

  defp get_in(map, keys) when is_map(map) do
    Enum.reduce_while(keys, map, fn key, acc ->
      case acc do
        %{^key => value} -> {:cont, value}
        _ -> {:halt, nil}
      end
    end)
  end

  defp get_in(_, _), do: nil
end
