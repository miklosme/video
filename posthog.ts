import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { PostHog } from 'posthog-node'

export interface WorkflowEventProperties {
  [key: string]: unknown
}

export interface AiGenerationUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}

export interface AiGenerationEventInput {
  traceId: string
  spanId?: string
  spanName?: string
  parentId?: string
  provider: string
  model: string
  input: unknown
  outputChoices?: unknown
  toolCalls?: unknown
  toolResults?: unknown
  modelParameters?: unknown
  providerMetadata?: unknown
  metadata?: Record<string, unknown>
  requestBody?: unknown
  responseBody?: unknown
  responseId?: string
  statusCode?: number
  latencyMs?: number
  usage?: AiGenerationUsage
  finishReason?: string
  rawFinishReason?: string
  error?: {
    name?: string
    message: string
  } | null
}

export interface PostHogClientLike {
  capture: (message: {
    distinctId: string
    event: string
    properties?: Record<string, unknown>
  }) => void
  shutdown: () => Promise<void> | void
}

interface PostHogTelemetryOptions {
  apiKey?: string
  host?: string
  installIdPath?: string
  createClient?: (apiKey: string, options: { host?: string }) => PostHogClientLike
  generateId?: () => string
}

export interface PostHogTelemetry {
  readonly isEnabled: boolean
  readonly distinctId: string
  readonly sessionId: string
  createTraceId: () => string
  captureWorkflowEvent: (event: string, properties?: WorkflowEventProperties) => void
  captureAiGeneration: (event: AiGenerationEventInput) => void
  shutdown: () => Promise<void>
}

const DEFAULT_INSTALL_ID_PATH = path.join(os.homedir(), '.video-agent', 'posthog-anonymous-id')

function readOrCreateInstallId(installIdPath: string, generateId: () => string) {
  try {
    if (existsSync(installIdPath)) {
      const existingId = readFileSync(installIdPath, 'utf8').trim()

      if (existingId.length > 0) {
        return existingId
      }
    }

    const nextId = generateId()
    mkdirSync(path.dirname(installIdPath), { recursive: true })
    writeFileSync(installIdPath, `${nextId}\n`, 'utf8')
    return nextId
  } catch {
    return generateId()
  }
}

function toSerializableValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => toSerializableValue(item))
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toSerializableValue(item)]),
    )
  }

  return String(value)
}

function createBaseProperties(sessionId: string, properties: WorkflowEventProperties = {}) {
  return {
    $process_person_profile: false,
    session_id: sessionId,
    ...Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, toSerializableValue(value)]),
    ),
  }
}

export function createPostHogTelemetry(options: PostHogTelemetryOptions = {}): PostHogTelemetry {
  const generateId = options.generateId ?? randomUUID
  const distinctId = readOrCreateInstallId(
    options.installIdPath ?? DEFAULT_INSTALL_ID_PATH,
    generateId,
  )
  const sessionId = generateId()

  const apiKey = options.apiKey ?? process.env.POSTHOG_KEY
  const host = options.host ?? process.env.POSTHOG_HOST
  const client =
    apiKey && apiKey.trim().length > 0
      ? (options.createClient?.(apiKey, { host }) ??
        new PostHog(apiKey, {
          ...(host ? { host } : {}),
          enableExceptionAutocapture: true,
        }))
      : null

  function captureWorkflowEvent(event: string, properties: WorkflowEventProperties = {}) {
    if (!client) {
      return
    }

    client.capture({
      distinctId,
      event,
      properties: createBaseProperties(sessionId, properties),
    })
  }

  function captureAiGeneration(event: AiGenerationEventInput) {
    if (!client) {
      return
    }

    const statusCode = event.statusCode ?? (event.error ? 500 : 200)
    const properties: Record<string, unknown> = createBaseProperties(sessionId, {
      trace_id: event.traceId,
      span_id: event.spanId,
      span_name: event.spanName,
      parent_id: event.parentId,
      step_metadata: event.metadata,
      provider_metadata: event.providerMetadata,
      finish_reason: event.finishReason,
      raw_finish_reason: event.rawFinishReason,
      response_id: event.responseId,
    })

    properties.$ai_lib = 'video-agent'
    properties.$ai_trace_id = event.traceId
    properties.$ai_span_id = event.spanId ?? generateId()
    properties.$ai_span_name = event.spanName ?? 'video_agent_turn'
    properties.$ai_parent_id = event.parentId
    properties.$ai_provider = event.provider
    properties.$ai_model = event.model
    properties.$ai_model_parameters = toSerializableValue(event.modelParameters)
    properties.$ai_input = toSerializableValue(event.input)
    properties.$ai_output_choices = toSerializableValue(event.outputChoices)
    properties.$ai_tools = toSerializableValue(event.toolCalls)
    properties.$ai_tool_results = toSerializableValue(event.toolResults)
    properties.$ai_http_status = statusCode
    properties.$ai_latency = event.latencyMs !== undefined ? event.latencyMs / 1000 : undefined
    properties.$ai_framework = 'ai-sdk'
    properties.$ai_request = toSerializableValue(event.requestBody)
    properties.$ai_response = toSerializableValue(event.responseBody)

    if (event.error) {
      properties.$ai_error = event.error.message
      properties.$ai_is_error = true
    } else {
      properties.$ai_is_error = false
    }

    if (event.usage?.inputTokens !== undefined) {
      properties.$ai_input_tokens = event.usage.inputTokens
    }

    if (event.usage?.outputTokens !== undefined) {
      properties.$ai_output_tokens = event.usage.outputTokens
    }

    if (event.usage?.totalTokens !== undefined) {
      properties.$ai_total_tokens = event.usage.totalTokens
    }

    if (event.usage?.reasoningTokens !== undefined) {
      properties.$ai_reasoning_tokens = event.usage.reasoningTokens
    }

    if (event.usage?.cacheReadInputTokens !== undefined) {
      properties.$ai_cache_read_input_tokens = event.usage.cacheReadInputTokens
    }

    if (event.usage?.cacheCreationInputTokens !== undefined) {
      properties.$ai_cache_creation_input_tokens = event.usage.cacheCreationInputTokens
    }

    client.capture({
      distinctId,
      event: '$ai_generation',
      properties,
    })
  }

  return {
    isEnabled: client !== null,
    distinctId,
    sessionId,
    createTraceId: generateId,
    captureWorkflowEvent,
    captureAiGeneration,
    async shutdown() {
      await client?.shutdown()
    },
  }
}

export const posthogTelemetry = createPostHogTelemetry()

export const distinctId = posthogTelemetry.distinctId
export const sessionId = posthogTelemetry.sessionId
export const createTraceId = posthogTelemetry.createTraceId
export const captureWorkflowEvent = posthogTelemetry.captureWorkflowEvent
export const captureAiGeneration = posthogTelemetry.captureAiGeneration

export async function shutdownPostHog() {
  await posthogTelemetry.shutdown()
}
