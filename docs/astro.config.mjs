// @ts-check
import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"
import starlightThemeNova from "starlight-theme-nova"

export default defineConfig({
  site: "https://aires.secondary.ai",
  base: "/",
  integrations: [
    starlight({
      title: "Aires",
      description: "High-performance observability for modern applications",
      plugins: [starlightThemeNova()],
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/secondary-inc/aires" },
      ],
      customCss: ["./src/styles/custom.css"],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Overview", slug: "guides/overview" },
            { label: "Quick Start", slug: "guides/quickstart" },
            { label: "Architecture", slug: "guides/architecture" },
            { label: "Benchmarks", slug: "guides/benchmarks" },
          ],
        },
        {
          label: "TypeScript SDK",
          items: [
            { label: "Installation", slug: "sdk/typescript/install" },
            { label: "Basic Logging", slug: "sdk/typescript/logging" },
            { label: "Tracing", slug: "sdk/typescript/tracing" },
            { label: "Metrics", slug: "sdk/typescript/metrics" },
            { label: "HTTP Middleware", slug: "sdk/typescript/http" },
            { label: "Agent Observability", slug: "sdk/typescript/agents" },
          ],
        },
        {
          label: "Rust SDK",
          items: [
            { label: "Installation", slug: "sdk/rust/install" },
            { label: "Usage", slug: "sdk/rust/usage" },
            { label: "Configuration", slug: "sdk/rust/config" },
          ],
        },
        {
          label: "Python SDK",
          items: [
            { label: "Installation", slug: "sdk/python/install" },
            { label: "Usage", slug: "sdk/python/usage" },
          ],
        },
        {
          label: "Collector",
          items: [
            { label: "Setup", slug: "collector/setup" },
            { label: "Configuration", slug: "collector/config" },
            { label: "OpenTelemetry", slug: "collector/otel" },
          ],
        },
        {
          label: "Storage",
          items: [
            { label: "ClickHouse Schema", slug: "storage/schema" },
            { label: "Retention", slug: "storage/retention" },
            { label: "Materialized Views", slug: "storage/views" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Proto Schema", slug: "reference/proto" },
            { label: "Event Fields", slug: "reference/fields" },
            { label: "Severity Levels", slug: "reference/severity" },
          ],
        },
      ],
    }),
  ],
})
