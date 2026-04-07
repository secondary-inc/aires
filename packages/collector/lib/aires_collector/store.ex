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

    case Ch.start_link(
           hostname: host,
           port: port,
           database: database,
           username: username,
           password: password
         ) do
      {:ok, conn} ->
        Logger.info("[Store] Connected to ClickHouse at #{host}:#{port}/#{database}")
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
    columns = [
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
      :http_method,
      :http_path,
      :http_status_code,
      :http_duration_ms,
      :metric_name,
      :metric_value,
      :error_type,
      :error_message,
      :error_stack,
      :error_handled,
      :sdk_name,
      :sdk_version,
      :sdk_language
    ]

    col_names = Enum.map_join(columns, ", ", &Atom.to_string/1)

    values =
      Enum.map_join(rows, ", ", fn row ->
        vals =
          Enum.map_join(columns, ", ", fn col ->
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

        "(#{vals})"
      end)

    sql = "INSERT INTO events (#{col_names}) VALUES #{values}"

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

  defp escape_string(nil), do: "''"
  defp escape_string(val) when is_binary(val), do: "'#{String.replace(val, "'", "\\'")}'"
  defp escape_string(val), do: "'#{to_string(val)}'"
end
