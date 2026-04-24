defmodule AiresCollector.Query do
  @moduledoc """
  Executes read queries against the ClickHouse `events` table on behalf of
  authenticated clients.

  Two entry points:
    * `search/1` — bounded range query returning a list of events.
    * `tail/2` — polling tail; caller passes a `since` cursor and gets back
      new events + an updated cursor. Repeatedly invoked by HTTP streaming
      handlers to emit SSE chunks.

  All queries are parameterized; no client input is concatenated into SQL.
  """

  require Logger

  @max_limit 10_000
  @default_limit 200

  @type search_params :: %{
          optional(:service) => String.t() | nil,
          optional(:services) => [String.t()],
          optional(:level) => String.t() | nil,
          optional(:from) => DateTime.t() | nil,
          optional(:to) => DateTime.t() | nil,
          optional(:message_contains) => String.t() | nil,
          optional(:trace_id) => String.t() | nil,
          optional(:limit) => pos_integer()
        }

  @type event :: %{
          timestamp: String.t(),
          service: String.t(),
          severity: String.t(),
          message: String.t(),
          trace_id: String.t(),
          attributes: map(),
          kind: String.t()
        }

  @spec search(search_params()) :: {:ok, [event()]} | {:error, String.t()}
  def search(params) do
    {where, sql_params} = build_where(params)
    limit = clamp_limit(params[:limit])

    sql = """
    SELECT
      toString(timestamp) AS ts,
      service,
      toString(severity) AS severity,
      message,
      trace_id,
      attributes,
      kind,
      http_method,
      http_path,
      http_status_code,
      http_duration_ms,
      error_type,
      error_message
    FROM events
    #{where}
    ORDER BY timestamp DESC
    LIMIT #{limit}
    """

    run_query(sql, sql_params)
  end

  @doc """
  Tail query. `since` is the timestamp of the latest event the caller has
  already seen (inclusive strict-greater-than). Returns at most `limit`
  new events in ascending order so callers can emit them in arrival order,
  plus the new max timestamp to use as the next cursor.
  """
  @spec tail(search_params(), String.t() | nil) ::
          {:ok, [event()], String.t() | nil} | {:error, String.t()}
  def tail(params, since) do
    params = Map.put(params, :from, since)
    {where, sql_params} = build_where(params, inclusive_from: false)
    limit = clamp_limit(params[:limit] || 500)

    sql = """
    SELECT
      toString(timestamp) AS ts,
      service,
      toString(severity) AS severity,
      message,
      trace_id,
      attributes,
      kind,
      http_method,
      http_path,
      http_status_code,
      http_duration_ms,
      error_type,
      error_message
    FROM events
    #{where}
    ORDER BY timestamp ASC
    LIMIT #{limit}
    """

    case run_query(sql, sql_params) do
      {:ok, []} -> {:ok, [], since}
      {:ok, events} -> {:ok, events, List.last(events).timestamp}
      err -> err
    end
  end

  # ── Internals ───────────────────────────────────────────────────────────

  defp clamp_limit(nil), do: @default_limit
  defp clamp_limit(n) when is_integer(n) and n > 0, do: min(n, @max_limit)
  defp clamp_limit(_), do: @default_limit

  defp build_where(params, opts \\ []) do
    inclusive_from = Keyword.get(opts, :inclusive_from, true)
    clauses = []
    sql_params = %{}

    # Service filter: exact service, explicit list, or glob patterns
    {clauses, sql_params} =
      cond do
        is_binary(params[:service]) ->
          {clauses ++ ["service = {service:String}"],
           Map.put(sql_params, "service", params[:service])}

        is_list(params[:services]) and params[:services] == [] ->
          {clauses ++ ["1 = 0"], sql_params}

        is_list(params[:services]) ->
          arr = params[:services] |> Enum.map(&"'#{escape(&1)}'") |> Enum.join(",")
          {clauses ++ ["service IN (#{arr})"], sql_params}

        is_list(params[:service_patterns]) ->
          patterns_to_clause(params[:service_patterns], clauses, sql_params)

        true ->
          {clauses, sql_params}
      end

    {clauses, sql_params} =
      case params[:level] do
        nil ->
          {clauses, sql_params}

        level when is_binary(level) ->
          {clauses ++ ["severity = {level:String}"], Map.put(sql_params, "level", level)}

        _ ->
          {clauses, sql_params}
      end

    {clauses, sql_params} =
      case params[:from] do
        nil ->
          {clauses, sql_params}

        from when is_binary(from) ->
          op = if inclusive_from, do: ">=", else: ">"

          {clauses ++ ["timestamp #{op} parseDateTime64BestEffort({from:String}, 9)"],
           Map.put(sql_params, "from", from)}

        %DateTime{} = from ->
          op = if inclusive_from, do: ">=", else: ">"

          {clauses ++ ["timestamp #{op} parseDateTime64BestEffort({from:String}, 9)"],
           Map.put(sql_params, "from", DateTime.to_iso8601(from))}

        _ ->
          {clauses, sql_params}
      end

    {clauses, sql_params} =
      case params[:to] do
        nil ->
          {clauses, sql_params}

        to when is_binary(to) ->
          {clauses ++ ["timestamp <= parseDateTime64BestEffort({to:String}, 9)"],
           Map.put(sql_params, "to", to)}

        %DateTime{} = to ->
          {clauses ++ ["timestamp <= parseDateTime64BestEffort({to:String}, 9)"],
           Map.put(sql_params, "to", DateTime.to_iso8601(to))}

        _ ->
          {clauses, sql_params}
      end

    {clauses, sql_params} =
      case params[:message_contains] do
        nil ->
          {clauses, sql_params}

        "" ->
          {clauses, sql_params}

        term ->
          {clauses ++ ["positionCaseInsensitive(message, {term:String}) > 0"],
           Map.put(sql_params, "term", term)}
      end

    {clauses, sql_params} =
      case params[:trace_id] do
        nil ->
          {clauses, sql_params}

        "" ->
          {clauses, sql_params}

        id ->
          {clauses ++ ["trace_id = {tid:String}"], Map.put(sql_params, "tid", id)}
      end

    where =
      case clauses do
        [] -> ""
        _ -> "WHERE " <> Enum.join(clauses, " AND ")
      end

    {where, sql_params}
  end

  defp run_query(sql, params) do
    conn = AiresCollector.Store.connection()

    try do
      {:ok, result} = Ch.query(conn, sql, params)
      {:ok, rows_to_events(result)}
    rescue
      e ->
        Logger.error("[Query] failed: #{Exception.message(e)}")
        {:error, Exception.message(e)}
    end
  end

  defp rows_to_events(%Ch.Result{rows: rows, columns: _cols}) do
    Enum.map(rows, fn
      [
        ts,
        service,
        severity,
        message,
        trace_id,
        attributes,
        kind,
        http_method,
        http_path,
        http_status,
        http_duration,
        err_type,
        err_msg
      ] ->
        %{
          timestamp: ts,
          service: service,
          severity: severity,
          message: message,
          trace_id: trace_id,
          attributes: normalize_map(attributes),
          kind: kind,
          http_method: http_method,
          http_path: http_path,
          http_status_code: http_status,
          http_duration_ms: http_duration,
          error_type: err_type,
          error_message: err_msg
        }
    end)
  end

  defp normalize_map(nil), do: %{}
  defp normalize_map(m) when is_map(m), do: m
  defp normalize_map(list) when is_list(list), do: Map.new(list)
  defp normalize_map(_), do: %{}

  defp escape(s) when is_binary(s), do: String.replace(s, "'", "\\'")

  # Converts a list of service-scope globs (e.g. ["ws-*", "int-evergreen"]) to
  # a single service clause that matches any of them. A bare "*" is a no-op.
  # Empty list → match nothing.
  defp patterns_to_clause([], clauses, params), do: {clauses ++ ["1 = 0"], params}

  defp patterns_to_clause(patterns, clauses, params) do
    if Enum.any?(patterns, &(&1 == "*")) do
      {clauses, params}
    else
      parts =
        patterns
        |> Enum.map(fn pat ->
          cond do
            String.ends_with?(pat, "*") ->
              prefix = String.slice(pat, 0, String.length(pat) - 1)
              "service LIKE '#{escape(prefix)}%'"

            true ->
              "service = '#{escape(pat)}'"
          end
        end)
        |> Enum.join(" OR ")

      {clauses ++ ["(#{parts})"], params}
    end
  end
end
