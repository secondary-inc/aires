defmodule AiresCollector.Auth do
  @moduledoc """
  Query token minting & verification.

  Tokens are compact HMAC-SHA256-signed blobs (JWT-like, but we roll our
  own minimal format to avoid a JOSE dependency for such a small scope).

  Layout:   base64url(payload) "." base64url(hmac)
  Payload:  JSON { "scope": ["svc-glob", ...], "exp": unix_ts, "aud": "aires-query" }

  Minting is gated by the shared `AIRES_ROOT_KEY` env var; only clients that
  know the root key can mint tokens. In production this is injected into
  Force via an empire secret.
  """

  require Logger

  @aud "aires-query"
  @max_ttl_hours 168

  @doc "Returns the root key used to mint tokens. Raises if unset."
  def root_key do
    case System.get_env("AIRES_ROOT_KEY") do
      nil ->
        raise "AIRES_ROOT_KEY env var is not set — query service cannot mint tokens"

      "" ->
        raise "AIRES_ROOT_KEY env var is empty — query service cannot mint tokens"

      key ->
        key
    end
  end

  @doc "HMAC-signing secret for tokens. Separate from root_key so token verification
  doesn't require the full root key to be distributed."
  def signing_secret do
    System.get_env("AIRES_SIGNING_SECRET") || root_key()
  end

  @spec mint([String.t()], pos_integer()) :: {:ok, String.t()} | {:error, String.t()}
  def mint(scope, ttl_hours) when is_list(scope) and is_integer(ttl_hours) do
    cond do
      scope == [] ->
        {:error, "scope must be non-empty"}

      ttl_hours <= 0 or ttl_hours > @max_ttl_hours ->
        {:error, "ttl_hours out of range (1..#{@max_ttl_hours})"}

      true ->
        exp = System.system_time(:second) + ttl_hours * 3600

        payload =
          Jason.encode!(%{
            scope: scope,
            exp: exp,
            aud: @aud,
            iat: System.system_time(:second)
          })

        encoded = Base.url_encode64(payload, padding: false)
        sig = sign(encoded)
        {:ok, encoded <> "." <> sig}
    end
  end

  @doc """
  Verifies a token and returns the decoded payload. Returns
  `{:error, reason}` if signature is invalid, token is expired, or
  audience mismatches.
  """
  @spec verify(String.t()) :: {:ok, map()} | {:error, String.t()}
  def verify(token) when is_binary(token) do
    with [encoded, sig] <- String.split(token, ".", parts: 2),
         true <- constant_time_eq(sig, sign(encoded)) or {:error, "bad signature"},
         {:ok, payload_bin} <- Base.url_decode64(encoded, padding: false),
         {:ok, payload} <- Jason.decode(payload_bin),
         :ok <- check_audience(payload),
         :ok <- check_expiry(payload) do
      {:ok, payload}
    else
      {:error, _} = err -> err
      false -> {:error, "bad signature"}
      _ -> {:error, "malformed token"}
    end
  end

  def verify(_), do: {:error, "missing token"}

  @doc """
  Checks whether `service` matches any scope glob in the token payload.
  Globs support trailing `*` (e.g. "ws-*") and exact matches.
  """
  def in_scope?(%{"scope" => globs}, service) when is_list(globs) and is_binary(service) do
    Enum.any?(globs, fn glob ->
      cond do
        glob == "*" ->
          true

        String.ends_with?(glob, "*") ->
          prefix = String.slice(glob, 0, String.length(glob) - 1)
          String.starts_with?(service, prefix)

        true ->
          glob == service
      end
    end)
  end

  def in_scope?(_, _), do: false

  @doc """
  Returns the allowed service globs from a verified payload. Used by
  the query handler to inject into WHERE clauses when the request
  doesn't pin a specific service.
  """
  def scope(%{"scope" => globs}) when is_list(globs), do: globs
  def scope(_), do: []

  # ── Internals ───────────────────────────────────────────────────────────

  defp sign(encoded) do
    :crypto.mac(:hmac, :sha256, signing_secret(), encoded)
    |> Base.url_encode64(padding: false)
  end

  defp constant_time_eq(a, b) when byte_size(a) != byte_size(b), do: false

  defp constant_time_eq(a, b) do
    :crypto.hash_equals(a, b)
  end

  defp check_audience(%{"aud" => @aud}), do: :ok
  defp check_audience(_), do: {:error, "bad audience"}

  defp check_expiry(%{"exp" => exp}) when is_integer(exp) do
    if exp > System.system_time(:second), do: :ok, else: {:error, "expired"}
  end

  defp check_expiry(_), do: {:error, "missing exp"}
end
