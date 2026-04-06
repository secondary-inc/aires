defmodule AiresCollector.Transform do
  @moduledoc """
  Transforms proto Event structs into flat maps for ClickHouse insertion.
  """

  def event_to_row(event, sdk_name, sdk_version) do
    %{
      id: Map.get(event, :id) || :crypto.strong_rand_bytes(16) |> Base.encode16(case: :lower),
      timestamp: ns_to_datetime(Map.get(event, :timestamp_ns)),
      service: Map.get(event, :service) || "",
      environment: Map.get(event, :environment) || "",
      host: Map.get(event, :host) || "",
      instance: Map.get(event, :instance) || "",
      severity: severity_to_string(Map.get(event, :severity)),
      message: Map.get(event, :message) || "",
      display_text: Map.get(event, :display_text) || "",
      body: Map.get(event, :body) || "",
      trace_id: Map.get(event, :trace_id) || "",
      span_id: Map.get(event, :span_id) || "",
      parent_span_id: Map.get(event, :parent_span_id) || "",
      subtrace_id: Map.get(event, :subtrace_id) || "",
      session_id: Map.get(event, :session_id) || "",
      user_id: Map.get(event, :user_id) || "",
      agent_id: Map.get(event, :agent_id) || "",
      source_file: Map.get(event, :source_file) || "",
      source_line: Map.get(event, :source_line) || 0,
      source_function: Map.get(event, :source_function) || "",
      category: Map.get(event, :category) || "",
      kind: Map.get(event, :kind) || "log",
      tags: Map.get(event, :tags) || [],
      http_method: deep_get(event, [:http, :method]) || "",
      http_path: deep_get(event, [:http, :path]) || "",
      http_status_code: deep_get(event, [:http, :status_code]) || 0,
      http_duration_ms: deep_get(event, [:http, :duration_ms]) || 0,
      metric_name: deep_get(event, [:metric, :name]) || "",
      metric_value: deep_get(event, [:metric, :value]) || 0.0,
      error_type: deep_get(event, [:error, :type]) || "",
      error_message: deep_get(event, [:error, :message]) || "",
      error_stack: deep_get(event, [:error, :stack]) || "",
      error_handled: deep_get(event, [:error, :handled]) || true,
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

  defp deep_get(map, keys) when is_map(map) do
    Enum.reduce_while(keys, map, fn key, acc ->
      case acc do
        %{^key => value} -> {:cont, value}
        _ -> {:halt, nil}
      end
    end)
  end

  defp deep_get(_, _), do: nil
end
