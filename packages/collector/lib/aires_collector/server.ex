defmodule AiresCollector.Server do
  use GRPC.Server, service: Aires.V1.AiresCollector.Service

  def ingest(request, _stream) do
    events = request.events
    sdk_name = request.sdk_name
    sdk_version = request.sdk_version

    case AiresCollector.Pipeline.ingest(events, sdk_name, sdk_version) do
      {:ok, accepted, rejected, errors} ->
        %Aires.V1.IngestResponse{
          accepted: accepted,
          rejected: rejected,
          errors: errors
        }

      {:error, reason} ->
        raise GRPC.RPCError, status: :internal, message: "ingestion failed: #{reason}"
    end
  end

  def ingest_stream(request_stream, _stream) do
    total_accepted = 0
    total_rejected = 0
    all_errors = []

    Enum.reduce(request_stream, {0, 0, []}, fn request, {acc, rej, errs} ->
      case AiresCollector.Pipeline.ingest(request.events, request.sdk_name, request.sdk_version) do
        {:ok, accepted, rejected, errors} ->
          {acc + accepted, rej + rejected, errs ++ errors}

        {:error, _reason} ->
          {acc, rej + length(request.events), errs}
      end
    end)
    |> then(fn {accepted, rejected, errors} ->
      %Aires.V1.IngestResponse{
        accepted: accepted,
        rejected: rejected,
        errors: errors
      }
    end)
  end
end
