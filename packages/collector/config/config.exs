import Config

if config_env() == :test do
  config :aires_collector, start_services: false
end
