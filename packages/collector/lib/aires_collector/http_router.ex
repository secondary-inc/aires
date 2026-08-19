defmodule AiresCollector.HttpRouter do
  @moduledoc """
  HTTP front-end for the aires query API.

  Four routes:
    * `POST /auth/mint` — body { root_key, scope: [...], ttl_hours }
                          → { token, exp }
    * `POST /query/search` — body { service?, level?, from?, to?, ... }
                             → { events: [...] }
    * `POST /query/metrics` — body { service?, names?, from?, to? }
                              → { points: [{name, t, v}] }
    * `POST /query/tail` — body { service, since?, level?, limit?, interval_ms? }
                           → SSE stream of events

  All query routes require `Authorization: Bearer <token>`. The token's
  `scope` array is intersected with the requested `service` (or used as
  a `service IN (...)` filter when no service is specified).
  """

  use Plug.Router

  require Logger

  plug(Plug.Logger, log: :info)
  plug(:match)
  plug(Plug.Parsers, parsers: [:json], json_decoder: Jason, pass: ["application/json"])
  plug(:dispatch)

  # ── /health ─────────────────────────────────────────────────────────────

  get "/health" do
    send_resp(conn, 200, "ok")
  end

  # ── /auth/mint ──────────────────────────────────────────────────────────

  post "/auth/mint" do
    with %{"root_key" => root_key, "scope" => scope, "ttl_hours" => ttl} <- conn.body_params,
         true <- is_list(scope),
         true <- Plug.Crypto.secure_compare(root_key, AiresCollector.Auth.root_key()),
         {:ok, token} <- AiresCollector.Auth.mint(scope, ttl) do
      exp = System.system_time(:second) + ttl * 3600

      conn
      |> put_resp_header("content-type", "application/json")
      |> send_resp(200, Jason.encode!(%{token: token, exp: exp}))
    else
      false ->
        send_json(conn, 401, %{error: "invalid root_key"})

      {:error, reason} ->
        send_json(conn, 400, %{error: reason})

      _ ->
        send_json(conn, 400, %{error: "expected { root_key, scope: [\"glob\", ...], ttl_hours }"})
    end
  end

  # ── /query/search ───────────────────────────────────────────────────────

  post "/query/search" do
    with {:ok, payload} <- authorize(conn),
         {:ok, params} <- parse_params(conn.body_params, payload),
         {:ok, events} <- AiresCollector.Query.search(params) do
      send_json(conn, 200, %{events: events})
    else
      {:error, status, reason} -> send_json(conn, status, %{error: reason})
      {:error, reason} -> send_json(conn, 500, %{error: reason})
    end
  end

  # ── /query/metrics ──────────────────────────────────────────────────────

  post "/query/metrics" do
    with {:ok, payload} <- authorize(conn),
         {:ok, params} <- parse_params(conn.body_params, payload),
         {:ok, points} <- AiresCollector.Query.metrics(Map.put(params, :metric_names, conn.body_params["names"] || [])) do
      send_json(conn, 200, %{points: points})
    else
      {:error, status, reason} -> send_json(conn, status, %{error: reason})
      {:error, reason} -> send_json(conn, 500, %{error: reason})
    end
  end

  # ── /query/tail ─────────────────────────────────────────────────────────

  post "/query/tail" do
    with {:ok, payload} <- authorize(conn),
         {:ok, params} <- parse_params(conn.body_params, payload) do
      interval = clamp_interval(conn.body_params["interval_ms"])
      since = conn.body_params["since"]

      conn
      |> put_resp_header("content-type", "text/event-stream")
      |> put_resp_header("cache-control", "no-cache")
      |> put_resp_header("x-accel-buffering", "no")
      |> send_chunked(200)
      |> tail_loop(params, since, interval)
    else
      {:error, status, reason} -> send_json(conn, status, %{error: reason})
      {:error, reason} -> send_json(conn, 403, %{error: reason})
    end
  end

  match _ do
    send_resp(conn, 404, "not found")
  end

  # ── Helpers ─────────────────────────────────────────────────────────────

  defp authorize(conn) do
    with ["Bearer " <> token] <- get_req_header(conn, "authorization"),
         {:ok, payload} <- AiresCollector.Auth.verify(token) do
      {:ok, payload}
    else
      [] -> {:error, 401, "missing Authorization header"}
      [_] -> {:error, 401, "expected 'Bearer <token>'"}
      {:error, reason} -> {:error, 401, reason}
    end
  end

  defp parse_params(body, payload) do
    allowed_scope = AiresCollector.Auth.scope(payload)
    requested_service = body["service"]

    base = %{
      level: body["level"],
      from: body["from"],
      to: body["to"],
      message_contains: body["message_contains"],
      trace_id: body["trace_id"],
      limit: body["limit"]
    }

    cond do
      is_binary(requested_service) and AiresCollector.Auth.in_scope?(payload, requested_service) ->
        {:ok, Map.put(base, :service, requested_service)}

      is_binary(requested_service) ->
        {:error, 403, "service '#{requested_service}' not in token scope"}

      true ->
        # No specific service — inject scope as service_patterns for Query
        {:ok, Map.put(base, :service_patterns, allowed_scope)}
    end
  end

  defp clamp_interval(nil), do: 2_000
  defp clamp_interval(n) when is_integer(n) and n >= 500 and n <= 60_000, do: n
  defp clamp_interval(_), do: 2_000

  defp tail_loop(conn, params, since, interval) do
    case AiresCollector.Query.tail(params, since) do
      {:ok, [], _} ->
        Process.sleep(interval)

        case chunk(conn, ":keepalive\n\n") do
          {:ok, conn} -> tail_loop(conn, params, since, interval)
          {:error, _} -> conn
        end

      {:ok, events, new_since} ->
        encoded =
          events
          |> Enum.map(fn ev ->
            "data: " <> Jason.encode!(ev) <> "\n\n"
          end)
          |> IO.iodata_to_binary()

        case chunk(conn, encoded) do
          {:ok, conn} ->
            Process.sleep(interval)
            tail_loop(conn, params, new_since, interval)

          {:error, _} ->
            conn
        end

      {:error, reason} ->
        Logger.error("[HttpRouter] tail failed: #{reason}")

        case chunk(conn, "event: error\ndata: #{Jason.encode!(%{error: reason})}\n\n") do
          _ -> conn
        end
    end
  end

  defp send_json(conn, status, body) do
    conn
    |> put_resp_header("content-type", "application/json")
    |> send_resp(status, Jason.encode!(body))
  end
end
