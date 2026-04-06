defmodule AiresCollector.Application do
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      # ClickHouse connection pool
      {AiresCollector.Store, []},

      # gRPC server
      {GRPC.Server.Supervisor,
       endpoint: AiresCollector.Endpoint, port: port(), start_server: true},

      # Broadway pipeline for batched ClickHouse inserts
      {AiresCollector.Pipeline, []},

      # Telemetry
      AiresCollector.Telemetry
    ]

    opts = [strategy: :one_for_one, name: AiresCollector.Supervisor]
    Supervisor.start_link(children, opts)
  end

  defp port do
    System.get_env("GRPC_PORT", "4317") |> String.to_integer()
  end
end
