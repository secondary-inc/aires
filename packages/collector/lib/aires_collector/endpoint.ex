defmodule AiresCollector.Endpoint do
  use GRPC.Endpoint

  intercept(GRPC.Server.Interceptors.Logger)
  run(AiresCollector.Server)
end
