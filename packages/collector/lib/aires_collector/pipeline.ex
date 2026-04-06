defmodule AiresCollector.Pipeline do
  use Broadway

  def start_link(_opts) do
    Broadway.start_link(__MODULE__,
      name: __MODULE__,
      producer: [
        module: {AiresCollector.Pipeline.Producer, []},
        concurrency: 1
      ],
      processors: [
        default: [concurrency: System.schedulers_online()]
      ],
      batchers: [
        clickhouse: [
          concurrency: 4,
          batch_size: 1000,
          batch_timeout: 500
        ]
      ]
    )
  end

  def ingest(events, sdk_name, sdk_version) do
    rows =
      Enum.map(events, fn event ->
        AiresCollector.Transform.event_to_row(event, sdk_name, sdk_version)
      end)

    accepted = length(rows)
    Broadway.push_messages(__MODULE__, Enum.map(rows, &wrap_message/1))
    {:ok, accepted, 0, []}
  end

  @impl true
  def handle_message(:default, message, _context) do
    message
    |> Broadway.Message.put_batcher(:clickhouse)
  end

  @impl true
  def handle_batch(:clickhouse, messages, _batch_info, _context) do
    rows = Enum.map(messages, fn msg -> msg.data end)

    case AiresCollector.Store.insert_batch(rows) do
      :ok ->
        messages

      {:error, reason} ->
        Enum.map(messages, fn msg ->
          Broadway.Message.failed(msg, reason)
        end)
    end
  end

  defp wrap_message(row) do
    %Broadway.Message{
      data: row,
      acknowledger: {Broadway.NoopAcknowledger, nil, nil}
    }
  end
end
