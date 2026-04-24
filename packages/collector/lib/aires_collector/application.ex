defmodule AiresCollector.Application do
  use Application

  @impl true
  def start(_type, _args) do
    children =
      if Application.get_env(:aires_collector, :start_services, true) do
        [
          {AiresCollector.Store, []},
          {GRPC.Server.Supervisor,
           endpoint: AiresCollector.Endpoint, port: grpc_port(), start_server: true},
          {Bandit, plug: AiresCollector.HttpRouter, scheme: :http, port: http_port()}
        ]
      else
        []
      end

    opts = [strategy: :one_for_one, name: AiresCollector.Supervisor]
    Supervisor.start_link(children, opts)
  end

  def grpc_port do
    System.get_env("GRPC_PORT", "4317") |> String.to_integer()
  end

  def http_port do
    System.get_env("HTTP_PORT", "4318") |> String.to_integer()
  end

  # Kept for backwards compat with any existing callers.
  def port, do: grpc_port()
end
