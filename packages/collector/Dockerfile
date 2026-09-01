# Compile BEAM bytecode on the builder's native architecture. BEAM bytecode is
# portable; the target-architecture Erlang runtime is supplied below.
FROM --platform=$BUILDPLATFORM elixir:1.17-otp-27-slim AS build

RUN apt-get update && apt-get install -y build-essential git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV MIX_ENV=prod

COPY mix.exs mix.lock ./
COPY config/ config/
COPY lib/ lib/

RUN mix local.hex --force && mix local.rebar --force
RUN mix deps.get --only prod
RUN mix compile
RUN mix release

# Generate the release on the native builder, but replace its architecture-
# specific ERTS with the runtime from the requested target platform.
FROM elixir:1.17-otp-27-slim AS target-erts

FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y libstdc++6 openssl libncurses6 locales netcat-openbsd \
    && rm -rf /var/lib/apt/lists/* \
    && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen

WORKDIR /app

COPY --from=build /app/_build/prod/rel/aires_collector ./
RUN rm -rf ./erts-*
COPY --from=target-erts /usr/local/lib/erlang/erts-15.2.7.12/ ./erts-15.2.7.12/

ENV MIX_ENV=prod
ENV LANG=en_US.UTF-8

EXPOSE 4317 4318

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD nc -z localhost 4317 && nc -z localhost 4318 || exit 1

CMD ["bin/aires_collector", "start"]
