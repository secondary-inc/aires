defmodule AiresCollector.Store do
  use GenServer

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, [], name: __MODULE__)
  end

  def insert_batch(rows) when is_list(rows) do
    GenServer.call(__MODULE__, {:insert_batch, rows}, 10_000)
  end

  @impl true
  def init(_) do
    {:ok, conn} =
      Ch.start_link(
        hostname: System.get_env("CLICKHOUSE_HOST", "localhost"),
        port: String.to_integer(System.get_env("CLICKHOUSE_PORT", "8123")),
        database: System.get_env("CLICKHOUSE_DATABASE", "aires"),
        username: System.get_env("CLICKHOUSE_USER", "default"),
        password: System.get_env("CLICKHOUSE_PASSWORD", "")
      )

    {:ok, %{conn: conn}}
  end

  @impl true
  def handle_call({:insert_batch, rows}, _from, %{conn: conn} = state) do
    result = do_insert(conn, rows)
    {:reply, result, state}
  end

  defp do_insert(conn, rows) do
    columns = [
      :id,
      :timestamp,
      :service,
      :environment,
      :host,
      :instance,
      :severity,
      :message,
      :display_text,
      :body,
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
      :tags,
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

    placeholders = Enum.map_join(columns, ", ", fn _ -> "?" end)
    col_names = Enum.map_join(columns, ", ", &Atom.to_string/1)
    sql = "INSERT INTO events (#{col_names}) VALUES (#{placeholders})"

    params =
      Enum.map(rows, fn row ->
        Enum.map(columns, fn col -> Map.get(row, col, default_for(col)) end)
      end)

    case Ch.query(conn, sql, params) do
      {:ok, _} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  defp default_for(:tags), do: []
  defp default_for(:source_line), do: 0
  defp default_for(:http_status_code), do: 0
  defp default_for(:http_duration_ms), do: 0
  defp default_for(:metric_value), do: 0.0
  defp default_for(:error_handled), do: true
  defp default_for(_), do: ""
end
