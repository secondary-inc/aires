defmodule AiresCollector.MixProject do
  use Mix.Project

  def project do
    [
      app: :aires_collector,
      version: "0.1.0",
      elixir: "~> 1.17",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      elixirc_paths: elixirc_paths(Mix.env())
    ]
  end

  def application do
    [
      extra_applications: [:logger],
      mod: {AiresCollector.Application, []}
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  defp deps do
    [
      # gRPC server
      {:grpc, "~> 0.9"},
      {:protobuf, "~> 0.13"},

      # ClickHouse client
      {:ch, "~> 0.3"},
      {:db_connection, "~> 2.7"},

      # Broadway for batched pipeline processing
      {:broadway, "~> 1.1"},

      # OpenTelemetry ingestion (OTLP format)
      {:opentelemetry_exporter, "~> 1.7", only: :dev},

      # Telemetry
      {:telemetry, "~> 1.3"},
      {:telemetry_metrics, "~> 1.0"},
      {:telemetry_poller, "~> 1.1"},

      # JSON
      {:jason, "~> 1.4"},

      # Config
      {:vapor, "~> 0.10"},

      # Testing
      {:mox, "~> 1.2", only: :test},
      {:stream_data, "~> 1.1", only: [:test, :dev]}
    ]
  end
end
