defmodule AiresCollector.Server do
  use GRPC.Server, service: Aires.V1.AiresCollector.Service

  require Logger

  def ingest(request, _stream) do
    events = request.events || []
    sdk_name = request.sdk_name || ""
    sdk_version = request.sdk_version || ""

    Logger.info(
      "[Server] Received batch: #{length(events)} events from #{sdk_name}/#{sdk_version}"
    )

    rows =
      Enum.map(events, fn event ->
        AiresCollector.Transform.event_to_row(event, sdk_name, sdk_version)
      end)

    case AiresCollector.Store.insert_batch(rows) do
      :ok ->
        %Aires.V1.IngestResponse{
          accepted: length(events),
          rejected: 0,
          errors: []
        }

      {:error, reason} ->
        Logger.error("[Server] Insert failed: #{reason}")

        %Aires.V1.IngestResponse{
          accepted: 0,
          rejected: length(events),
          errors: [reason]
        }
    end
  end

  def ingest_stream(request_stream, _stream) do
    {total_accepted, total_rejected} =
      Enum.reduce(request_stream, {0, 0}, fn request, {acc, rej} ->
        events = request.events || []
        sdk_name = request.sdk_name || ""
        sdk_version = request.sdk_version || ""

        rows =
          Enum.map(events, fn event ->
            AiresCollector.Transform.event_to_row(event, sdk_name, sdk_version)
          end)

        case AiresCollector.Store.insert_batch(rows) do
          :ok -> {acc + length(events), rej}
          {:error, _} -> {acc, rej + length(events)}
        end
      end)

    %Aires.V1.IngestResponse{
      accepted: total_accepted,
      rejected: total_rejected,
      errors: []
    }
  end
end
