defmodule AiresCollector.Server do
  # TODO: Wire to gRPC service once proto codegen is set up
  # use GRPC.Server, service: Aires.V1.AiresCollector.Service

  def ingest(events, sdk_name, sdk_version) do
    AiresCollector.Pipeline.ingest(events, sdk_name, sdk_version)
  end
end
