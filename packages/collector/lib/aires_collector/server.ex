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

    case AiresCollector.Pipeline.ingest(events, sdk_name, sdk_version) do
      {:ok, accepted, rejected, _errors} ->
        %Aires.V1.IngestResponse{
          accepted: accepted,
          rejected: rejected,
          errors: []
        }

      {:error, reason} ->
        Logger.error("[Server] Ingestion failed: #{inspect(reason)}")
        raise GRPC.RPCError, status: :internal, message: "ingestion failed: #{inspect(reason)}"
    end
  end

  def ingest_stream(request_stream, _stream) do
    {total_accepted, total_rejected} =
      Enum.reduce(request_stream, {0, 0}, fn request, {acc, rej} ->
        events = request.events || []
        sdk_name = request.sdk_name || ""
        sdk_version = request.sdk_version || ""

        case AiresCollector.Pipeline.ingest(events, sdk_name, sdk_version) do
          {:ok, accepted, rejected, _} ->
            {acc + accepted, rej + rejected}

          {:error, _} ->
            {acc, rej + length(events)}
        end
      end)

    %Aires.V1.IngestResponse{
      accepted: total_accepted,
      rejected: total_rejected,
      errors: []
    }
  end
end
