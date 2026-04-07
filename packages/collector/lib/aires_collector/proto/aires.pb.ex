defmodule Aires.V1.Severity do
  @moduledoc false

  use Protobuf,
    enum: true,
    full_name: "aires.v1.Severity",
    protoc_gen_elixir_version: "0.16.0",
    syntax: :proto3

  field(:SEVERITY_UNSPECIFIED, 0)
  field(:TRACE, 1)
  field(:DEBUG, 2)
  field(:INFO, 3)
  field(:WARN, 4)
  field(:ERROR, 5)
  field(:FATAL, 6)
end

defmodule Aires.V1.MetricType do
  @moduledoc false

  use Protobuf,
    enum: true,
    full_name: "aires.v1.MetricType",
    protoc_gen_elixir_version: "0.16.0",
    syntax: :proto3

  field(:METRIC_UNSPECIFIED, 0)
  field(:GAUGE, 1)
  field(:COUNTER, 2)
  field(:HISTOGRAM, 3)
  field(:SUMMARY, 4)
end

defmodule Aires.V1.Event.AttributesEntry do
  @moduledoc false

  use Protobuf,
    full_name: "aires.v1.Event.AttributesEntry",
    map: true,
    protoc_gen_elixir_version: "0.16.0",
    syntax: :proto3

  field(:key, 1, type: :string)
  field(:value, 2, type: :string)
end

defmodule Aires.V1.Event.DataEntry do
  @moduledoc false

  use Protobuf,
    full_name: "aires.v1.Event.DataEntry",
    map: true,
    protoc_gen_elixir_version: "0.16.0",
    syntax: :proto3

  field(:key, 1, type: :string)
  field(:value, 2, type: :bytes)
end

defmodule Aires.V1.Event do
  @moduledoc false

  use Protobuf, full_name: "aires.v1.Event", protoc_gen_elixir_version: "0.16.0", syntax: :proto3

  field(:id, 1, type: :string)
  field(:timestamp_ns, 2, type: :fixed64, json_name: "timestampNs")
  field(:observed_timestamp_ns, 3, type: :fixed64, json_name: "observedTimestampNs")
  field(:service, 4, type: :string)
  field(:environment, 5, type: :string)
  field(:host, 6, type: :string)
  field(:instance, 7, type: :string)
  field(:severity, 8, type: Aires.V1.Severity, enum: true)
  field(:message, 9, type: :string)
  field(:display_text, 10, type: :string, json_name: "displayText")
  field(:body, 11, type: :bytes)
  field(:trace_id, 12, type: :string, json_name: "traceId")
  field(:span_id, 13, type: :string, json_name: "spanId")
  field(:parent_span_id, 14, type: :string, json_name: "parentSpanId")
  field(:subtrace_id, 15, type: :string, json_name: "subtraceId")
  field(:session_id, 16, type: :string, json_name: "sessionId")
  field(:user_id, 17, type: :string, json_name: "userId")
  field(:agent_id, 18, type: :string, json_name: "agentId")
  field(:source_file, 19, type: :string, json_name: "sourceFile")
  field(:source_line, 20, type: :int32, json_name: "sourceLine")
  field(:source_function, 21, type: :string, json_name: "sourceFunction")
  field(:category, 22, type: :string)
  field(:kind, 23, type: :string)
  field(:tags, 24, repeated: true, type: :string)
  field(:attributes, 25, repeated: true, type: Aires.V1.Event.AttributesEntry, map: true)
  field(:data, 26, repeated: true, type: Aires.V1.Event.DataEntry, map: true)
  field(:related, 27, repeated: true, type: Aires.V1.RelatedObject)
  field(:metric, 28, type: Aires.V1.MetricValue)
  field(:http, 29, type: Aires.V1.HttpInfo)
  field(:error, 30, type: Aires.V1.ErrorInfo)
  field(:resource, 31, type: Aires.V1.ResourceInfo)
end

defmodule Aires.V1.RelatedObject do
  @moduledoc false

  use Protobuf,
    full_name: "aires.v1.RelatedObject",
    protoc_gen_elixir_version: "0.16.0",
    syntax: :proto3

  field(:type, 1, type: :string)
  field(:id, 2, type: :string)
  field(:label, 3, type: :string)
  field(:url, 4, type: :string)
end

defmodule Aires.V1.MetricValue do
  @moduledoc false

  use Protobuf,
    full_name: "aires.v1.MetricValue",
    protoc_gen_elixir_version: "0.16.0",
    syntax: :proto3

  field(:name, 1, type: :string)
  field(:value, 2, type: :double)
  field(:unit, 3, type: :string)
  field(:type, 4, type: Aires.V1.MetricType, enum: true)
end

defmodule Aires.V1.HttpInfo do
  @moduledoc false

  use Protobuf,
    full_name: "aires.v1.HttpInfo",
    protoc_gen_elixir_version: "0.16.0",
    syntax: :proto3

  field(:method, 1, type: :string)
  field(:url, 2, type: :string)
  field(:path, 3, type: :string)
  field(:status_code, 4, type: :int32, json_name: "statusCode")
  field(:request_size, 5, type: :int64, json_name: "requestSize")
  field(:response_size, 6, type: :int64, json_name: "responseSize")
  field(:duration_ms, 7, type: :int64, json_name: "durationMs")
  field(:user_agent, 8, type: :string, json_name: "userAgent")
  field(:remote_addr, 9, type: :string, json_name: "remoteAddr")
end

defmodule Aires.V1.ErrorInfo do
  @moduledoc false

  use Protobuf,
    full_name: "aires.v1.ErrorInfo",
    protoc_gen_elixir_version: "0.16.0",
    syntax: :proto3

  field(:type, 1, type: :string)
  field(:message, 2, type: :string)
  field(:stack, 3, type: :string)
  field(:handled, 4, type: :bool)
end

defmodule Aires.V1.ResourceInfo.LabelsEntry do
  @moduledoc false

  use Protobuf,
    full_name: "aires.v1.ResourceInfo.LabelsEntry",
    map: true,
    protoc_gen_elixir_version: "0.16.0",
    syntax: :proto3

  field(:key, 1, type: :string)
  field(:value, 2, type: :string)
end

defmodule Aires.V1.ResourceInfo do
  @moduledoc false

  use Protobuf,
    full_name: "aires.v1.ResourceInfo",
    protoc_gen_elixir_version: "0.16.0",
    syntax: :proto3

  field(:cluster, 1, type: :string)
  field(:namespace, 2, type: :string)
  field(:pod, 3, type: :string)
  field(:container, 4, type: :string)
  field(:node, 5, type: :string)
  field(:labels, 6, repeated: true, type: Aires.V1.ResourceInfo.LabelsEntry, map: true)
end

defmodule Aires.V1.EventBatch do
  @moduledoc false

  use Protobuf,
    full_name: "aires.v1.EventBatch",
    protoc_gen_elixir_version: "0.16.0",
    syntax: :proto3

  field(:events, 1, repeated: true, type: Aires.V1.Event)
  field(:sdk_name, 2, type: :string, json_name: "sdkName")
  field(:sdk_version, 3, type: :string, json_name: "sdkVersion")
  field(:sdk_language, 4, type: :string, json_name: "sdkLanguage")
end

defmodule Aires.V1.IngestResponse do
  @moduledoc false

  use Protobuf,
    full_name: "aires.v1.IngestResponse",
    protoc_gen_elixir_version: "0.16.0",
    syntax: :proto3

  field(:accepted, 1, type: :int64)
  field(:rejected, 2, type: :int64)
  field(:errors, 3, repeated: true, type: :string)
end

defmodule Aires.V1.AiresCollector.Service do
  @moduledoc false

  use GRPC.Service, name: "aires.v1.AiresCollector", protoc_gen_elixir_version: "0.16.0"

  rpc(:Ingest, Aires.V1.EventBatch, Aires.V1.IngestResponse)

  rpc(:IngestStream, stream(Aires.V1.EventBatch), Aires.V1.IngestResponse)
end

defmodule Aires.V1.AiresCollector.Stub do
  @moduledoc false

  use GRPC.Stub, service: Aires.V1.AiresCollector.Service
end
