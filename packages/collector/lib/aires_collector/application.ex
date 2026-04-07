defmodule AiresCollector.Application do
  use Application

  @impl true
  def start(_type, _args) do
    children =
      if Application.get_env(:aires_collector, :start_services, true) do
        [
          {AiresCollector.Store, []},
          {AiresCollector.Pipeline, []},
          {GRPC.Server.Supervisor,
           endpoint: AiresCollector.Endpoint, port: port(), start_server: true}
        ]
      else
        []
      end

    opts = [strategy: :one_for_one, name: AiresCollector.Supervisor]
    Supervisor.start_link(children, opts)
  end

  def port do
    System.get_env("GRPC_PORT", "4317") |> String.to_integer()
  end
end
