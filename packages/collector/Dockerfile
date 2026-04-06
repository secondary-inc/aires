# Build stage
FROM elixir:1.17-otp-27-slim AS build

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

# Runtime stage
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y libstdc++6 openssl libncurses6 locales netcat-openbsd \
    && rm -rf /var/lib/apt/lists/* \
    && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen

WORKDIR /app

COPY --from=build /app/_build/prod/rel/aires_collector ./

ENV MIX_ENV=prod
ENV LANG=en_US.UTF-8

EXPOSE 4317

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD nc -z localhost 4317 || exit 1

CMD ["bin/aires_collector", "start"]
