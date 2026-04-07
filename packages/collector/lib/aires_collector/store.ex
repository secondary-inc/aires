defmodule AiresCollector.Store do
  use GenServer

  require Logger

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, [], name: __MODULE__)
  end

  def insert_batch(rows) when is_list(rows) do
    GenServer.call(__MODULE__, {:insert_batch, rows}, 30_000)
  end

  @impl true
  def init(_) do
    host = System.get_env("CLICKHOUSE_HOST", "localhost")
    port = String.to_integer(System.get_env("CLICKHOUSE_PORT", "8123"))
    database = System.get_env("CLICKHOUSE_DATABASE", "aires")
    username = System.get_env("CLICKHOUSE_USER", "default")
    password = System.get_env("CLICKHOUSE_PASSWORD", "")

    # Resolve hostname to IP at init time to avoid Mint DNS issues
    resolved_host =
      case :inet.getaddr(String.to_charlist(host), :inet) do
        {:ok, ip} ->
          ip_str = ip |> Tuple.to_list() |> Enum.join(".")
          Logger.info("[Store] Resolved #{host} → #{ip_str}")
          ip_str

        {:error, _} ->
          Logger.warning("[Store] DNS resolution failed for #{host}, using as-is")
          host
      end

    case Ch.start_link(
           hostname: resolved_host,
           port: port,
           database: database,
           username: username,
           password: password
         ) do
      {:ok, conn} ->
        Logger.info("[Store] Connected to ClickHouse at #{resolved_host}:#{port}/#{database}")
        {:ok, %{conn: conn}}

      {:error, reason} ->
        Logger.error("[Store] Failed to connect to ClickHouse: #{inspect(reason)}")
        {:stop, reason}
    end
  end

  @impl true
  def handle_call({:insert_batch, rows}, _from, %{conn: conn} = state) do
    result = do_insert(conn, rows)
    {:reply, result, state}
  end

  defp do_insert(_conn, []), do: :ok

  defp do_insert(conn, rows) do
    # Scalar columns (string, int, enum)
    scalar_columns = [
      :service,
      :environment,
      :severity,
      :message,
      :display_text,
      :trace_id,
      :span_id,
      :parent_span_id,
      :subtrace_id,
      :session_id,
      :user_id,
      :agent_id,
      :source_file,
      :source_line,
      :source_function,
      :category,
      :kind,
      :host,
      :instance,
      :http_method,
      :http_path,
      :http_status_code,
      :http_duration_ms,
      :metric_name,
      :metric_value,
      :metric_unit,
      :error_type,
      :error_message,
      :error_stack,
      :error_handled,
      :sdk_name,
      :sdk_version,
      :sdk_language
    ]

    # Map and Array columns handled separately
    all_col_names =
      Enum.map_join(scalar_columns, ", ", &Atom.to_string/1) <>
        ", attributes, data, tags"

    values =
      Enum.map_join(rows, ", ", fn row ->
        scalar_vals =
          Enum.map_join(scalar_columns, ", ", fn col ->
            val = Map.get(row, col)

            case col do
              :source_line -> to_string(val || 0)
              :http_status_code -> to_string(val || 0)
              :http_duration_ms -> to_string(val || 0)
              :metric_value -> to_string(val || 0.0)
              :error_handled -> if val == false, do: "0", else: "1"
              _ -> escape_string(val)
            end
          end)

        # Format Map(String, String) columns
        attrs = format_map(Map.get(row, :attributes))
        data_map = format_map(Map.get(row, :data))

        # Format Array(String) column
        tags = format_array(Map.get(row, :tags))

        "(#{scalar_vals}, #{attrs}, #{data_map}, #{tags})"
      end)

    sql = "INSERT INTO events (#{all_col_names}) VALUES #{values}"

    try do
      Ch.query!(conn, sql)
      Logger.info("[Store] Inserted #{length(rows)} events")
      :ok
    rescue
      e ->
        Logger.error("[Store] Insert failed: #{Exception.message(e)}")
        {:error, Exception.message(e)}
    end
  end

  # Format an Elixir map as ClickHouse Map(String, String) literal
  defp format_map(nil), do: "map()"
  defp format_map(m) when is_map(m) and map_size(m) == 0, do: "map()"

  defp format_map(m) when is_map(m) do
    entries =
      Enum.map_join(m, ", ", fn {k, v} ->
        "#{escape_string(to_string(k))}, #{escape_string(to_string(v))}"
      end)

    "map(#{entries})"
  end

  defp format_map(_), do: "map()"

  # Format a list as ClickHouse Array(String) literal
  defp format_array(nil), do: "[]"
  defp format_array([]), do: "[]"

  defp format_array(list) when is_list(list) do
    entries = Enum.map_join(list, ", ", fn v -> escape_string(to_string(v)) end)
    "[#{entries}]"
  end

  defp format_array(_), do: "[]"

  defp escape_string(nil), do: "''"
  defp escape_string(val) when is_binary(val), do: "'#{String.replace(val, "'", "\\'")}'"
  defp escape_string(val), do: "'#{to_string(val)}'"
end
