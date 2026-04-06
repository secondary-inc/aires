defmodule AiresCollector.Application do
  use Application

  @impl true
  def start(_type, _args) do
    children =
      if Application.get_env(:aires_collector, :start_services, true) do
        [
          {AiresCollector.Store, []},
          {AiresCollector.Pipeline, []},
          AiresCollector.Telemetry
        ]
      else
        []
      end

    opts = [strategy: :one_for_one, name: AiresCollector.Supervisor]
    Supervisor.start_link(children, opts)
  end

  @doc false
  def port do
    System.get_env("GRPC_PORT", "4317") |> String.to_integer()
  end
end
