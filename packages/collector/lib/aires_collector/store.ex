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

  @columns [
    :id,
    :timestamp,
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

  defp do_insert(_conn, rows) when rows == [], do: :ok

  defp do_insert(conn, rows) do
    col_names = Enum.map_join(@columns, ", ", &Atom.to_string/1)

    _types =
      Enum.map(@columns, fn col ->
        case col do
          :id -> "UUID"
          :timestamp -> "DateTime64(9, 'UTC')"
          :source_line -> "UInt32"
          :http_status_code -> "UInt16"
          :http_duration_ms -> "Int64"
          :metric_value -> "Float64"
          :error_handled -> "Bool"
          _ -> "String"
        end
      end)

    row_data =
      Enum.map(rows, fn row ->
        Enum.map(@columns, fn col ->
          val = Map.get(row, col)

          case col do
            :id ->
              case val do
                nil -> :crypto.strong_rand_bytes(16) |> Base.encode16(case: :lower)
                "" -> :crypto.strong_rand_bytes(16) |> Base.encode16(case: :lower)
                v -> v
              end

            :timestamp ->
              case val do
                %DateTime{} = dt -> DateTime.to_iso8601(dt)
                _ -> DateTime.to_iso8601(DateTime.utc_now())
              end

            :source_line ->
              val || 0

            :http_status_code ->
              val || 0

            :http_duration_ms ->
              val || 0

            :metric_value ->
              val || 0.0

            :error_handled ->
              if val == false, do: 0, else: 1

            _ ->
              val || ""
          end
        end)
      end)

    placeholders = Enum.map_join(@columns, ", ", fn _ -> "?" end)
    sql = "INSERT INTO events (#{col_names}) VALUES (#{placeholders})"

    try do
      Enum.each(row_data, fn params ->
        Ch.query!(conn, sql, params)
      end)

      :ok
    rescue
      e ->
        Logger.error("[Store] Insert failed: #{inspect(e)}")
        {:error, Exception.message(e)}
    end
  end
end
