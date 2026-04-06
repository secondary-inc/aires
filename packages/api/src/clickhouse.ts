import { createClient } from "@clickhouse/client"

export const clickhouse = createClient({
  url: process.env.CLICKHOUSE_URL || "http://localhost:8123",
  database: process.env.CLICKHOUSE_DATABASE || "aires",
  username: process.env.CLICKHOUSE_USER || "default",
  password: process.env.CLICKHOUSE_PASSWORD || "",
  clickhouse_settings: {
    output_format_json_quote_64bit_integers: 0,
  },
})
