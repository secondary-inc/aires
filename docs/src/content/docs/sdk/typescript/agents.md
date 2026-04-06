---
title: "TypeScript SDK: AI Agent Observability"
description: Tracking AI agent activities — task execution, LLM calls, tool use, subagent runs, and computer use sessions.
---

## Overview

Aires has first-class support for observing AI agent systems. The event schema includes dedicated fields for agent tracking (`agent_id`, `session_id`, `subtrace_id`) and structured `data` for capturing tool calls, LLM interactions, and multi-step reasoning.

## Agent Identity

Every agent event should include:

- **`agentId`** — identifies the agent (e.g. `"planner"`, `"coder"`, `"reviewer"`)
- **`sessionId`** — identifies the session/conversation (persistent across multiple turns)
- **`traceId`** — identifies the current operation (e.g. one user request)
- **`subtraceId`** — groups events within a sub-operation (e.g. one tool invocation chain)

```typescript
import { aires } from "@aires/sdk"
import { randomUUID } from "crypto"

const sessionId = "sess-user-42-abc"
const traceId = randomUUID()
const agentId = "planner-v2"
```

## Tracking Agent Lifecycle

### Agent start/stop

```typescript
aires.info("agent started", {
  agentId,
  sessionId,
  traceId,
  category: "ai",
  tags: ["agent-lifecycle"],
  attr: {
    model: "claude-sonnet-4-20250514",
    maxTurns: "10",
    systemPrompt: "You are a helpful assistant...",
  },
})

// ... agent runs ...

aires.info("agent completed", {
  agentId,
  sessionId,
  traceId,
  category: "ai",
  tags: ["agent-lifecycle"],
  attr: {
    turns: "4",
    tokensUsed: "12847",
    durationMs: "8423",
    outcome: "success",
  },
})
```

## Tracking LLM Calls

Record each LLM API call with model, token counts, and latency:

```typescript
const llmStart = performance.now()

const completion = await anthropic.messages.create({
  model: "claude-sonnet-4-20250514",
  messages: [{ role: "user", content: userMessage }],
  tools: toolDefinitions,
})

const llmDurationMs = performance.now() - llmStart

aires.info("LLM call completed", {
  agentId,
  sessionId,
  traceId,
  category: "ai",
  tags: ["llm-call"],
  attr: {
    model: "claude-sonnet-4-20250514",
    inputTokens: String(completion.usage.input_tokens),
    outputTokens: String(completion.usage.output_tokens),
    stopReason: completion.stop_reason,
    durationMs: String(Math.round(llmDurationMs)),
  },
  data: {
    // Store the full request/response for debugging
    request: {
      messageCount: messages.length,
      toolCount: toolDefinitions.length,
    },
    response: {
      contentBlocks: completion.content.length,
      stopReason: completion.stop_reason,
    },
  },
})

// Record token usage as a metric
aires.metric("ai.llm.tokens.total", completion.usage.input_tokens + completion.usage.output_tokens, {
  agentId,
  attr: {
    model: "claude-sonnet-4-20250514",
    direction: "total",
  },
})

aires.metric("ai.llm.duration_ms", llmDurationMs, {
  agentId,
  attr: { model: "claude-sonnet-4-20250514" },
})
```

## Tracking Tool Use

When an agent invokes a tool, record both the invocation and the result:

```typescript
// Tool invocation
aires.info(`tool invoked: ${toolName}`, {
  agentId,
  sessionId,
  traceId,
  subtraceId: toolCallId,  // group tool call + result
  category: "ai",
  tags: ["tool-use", toolName],
  attr: {
    toolName,
    toolCallId,
  },
  data: {
    toolInput: toolInput,  // the arguments passed to the tool
  },
})

const toolStart = performance.now()
const result = await executeTool(toolName, toolInput)
const toolDurationMs = performance.now() - toolStart

// Tool result
aires.info(`tool completed: ${toolName}`, {
  agentId,
  sessionId,
  traceId,
  subtraceId: toolCallId,
  category: "ai",
  tags: ["tool-result", toolName],
  attr: {
    toolName,
    toolCallId,
    durationMs: String(Math.round(toolDurationMs)),
    success: String(result.success),
  },
  data: {
    toolOutput: result.output,
  },
})

// Record tool duration metric
aires.metric("ai.tool.duration_ms", toolDurationMs, {
  agentId,
  attr: { tool: toolName },
})
```

## Tracking Task Execution

For agents that work on discrete tasks:

```typescript
const taskId = randomUUID()

aires.info("task started", {
  agentId,
  sessionId,
  traceId,
  category: "ai",
  tags: ["task"],
  attr: {
    taskId,
    taskType: "code-review",
    priority: "high",
  },
  data: {
    taskDescription: "Review PR #42 for security issues",
    context: {
      repo: "acme/api",
      prNumber: 42,
      files: ["src/auth.ts", "src/middleware.ts"],
    },
  },
})

// ... task execution with LLM calls and tool use ...

aires.info("task completed", {
  agentId,
  sessionId,
  traceId,
  category: "ai",
  tags: ["task"],
  attr: {
    taskId,
    taskType: "code-review",
    outcome: "completed",
    durationMs: "12450",
    llmCalls: "3",
    toolCalls: "5",
  },
  data: {
    result: {
      findings: 2,
      severity: "medium",
      summary: "Found 2 potential SQL injection vectors",
    },
  },
})
```

## Tracking Subagent Runs

When one agent delegates to another:

```typescript
const parentAgentId = "orchestrator"
const childAgentId = "researcher"
const delegationId = randomUUID()

// Parent agent delegates
aires.info("delegating to subagent", {
  agentId: parentAgentId,
  sessionId,
  traceId,
  subtraceId: delegationId,
  category: "ai",
  tags: ["delegation"],
  attr: {
    delegateAgent: childAgentId,
    delegationId,
    taskDescription: "Research quarterly revenue data",
  },
})

// Child agent runs (uses the same traceId and sessionId)
aires.info("subagent started", {
  agentId: childAgentId,
  sessionId,
  traceId,
  subtraceId: delegationId,
  category: "ai",
  tags: ["subagent"],
  attr: {
    parentAgent: parentAgentId,
    delegationId,
  },
})

// ... child agent does work ...

aires.info("subagent completed", {
  agentId: childAgentId,
  sessionId,
  traceId,
  subtraceId: delegationId,
  category: "ai",
  tags: ["subagent"],
  attr: {
    parentAgent: parentAgentId,
    delegationId,
    outcome: "success",
  },
})
```

## Computer Use Sessions

For agents that interact with browsers, terminals, or desktops:

```typescript
aires.info("computer use: navigating", {
  agentId,
  sessionId,
  traceId,
  category: "ai",
  tags: ["computer-use", "browser"],
  attr: {
    action: "navigate",
    url: "https://dashboard.example.com",
  },
})

aires.info("computer use: screenshot taken", {
  agentId,
  sessionId,
  traceId,
  category: "ai",
  tags: ["computer-use", "screenshot"],
  attr: {
    action: "screenshot",
    width: "1920",
    height: "1080",
  },
})

aires.info("computer use: clicking element", {
  agentId,
  sessionId,
  traceId,
  category: "ai",
  tags: ["computer-use", "click"],
  attr: {
    action: "click",
    selector: "#submit-button",
    coordinates: "960,540",
  },
})

aires.info("computer use: typing", {
  agentId,
  sessionId,
  traceId,
  category: "ai",
  tags: ["computer-use", "type"],
  attr: {
    action: "type",
    target: "input#search",
    textLength: "42",
  },
})
```

## Dashboard Queries

### Agent activity over time

```sql
SELECT
    toStartOfMinute(timestamp) AS minute,
    agent_id,
    count() AS events,
    countIf(severity = 'error') AS errors
FROM events
WHERE category = 'ai'
  AND timestamp > now() - INTERVAL 1 HOUR
GROUP BY minute, agent_id
ORDER BY minute;
```

### LLM cost analysis

```sql
SELECT
    agent_id,
    attributes['model'] AS model,
    count() AS calls,
    sum(toFloat64OrZero(attributes['inputTokens'])) AS total_input_tokens,
    sum(toFloat64OrZero(attributes['outputTokens'])) AS total_output_tokens,
    avg(toFloat64OrZero(attributes['durationMs'])) AS avg_latency_ms
FROM events
WHERE category = 'ai'
  AND has(tags, 'llm-call')
  AND timestamp > now() - INTERVAL 24 HOUR
GROUP BY agent_id, model
ORDER BY total_input_tokens DESC;
```

### Tool usage breakdown

```sql
SELECT
    attributes['toolName'] AS tool,
    count() AS invocations,
    avg(toFloat64OrZero(attributes['durationMs'])) AS avg_duration_ms,
    countIf(attributes['success'] = 'false') AS failures
FROM events
WHERE category = 'ai'
  AND has(tags, 'tool-result')
  AND timestamp > now() - INTERVAL 24 HOUR
GROUP BY tool
ORDER BY invocations DESC;
```

### Session replay (reconstruct agent behavior)

```sql
SELECT
    timestamp,
    agent_id,
    message,
    arrayStringConcat(tags, ', ') AS tags,
    attributes['toolName'] AS tool,
    subtrace_id
FROM events
WHERE session_id = 'sess-user-42-abc'
  AND category = 'ai'
ORDER BY timestamp;
```
