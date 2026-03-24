import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createPostHogTelemetry } from './posthog'

test('createPostHogTelemetry is a no-op when PostHog is not configured', async () => {
  const installDir = await mkdtemp(path.join(os.tmpdir(), 'posthog-test-noop-'))

  try {
    const telemetry = createPostHogTelemetry({
      apiKey: '',
      installIdPath: path.join(installDir, 'anonymous-id'),
    })

    expect(telemetry.isEnabled).toBe(false)
    expect(() => telemetry.captureWorkflowEvent('config_saved')).not.toThrow()
    expect(() =>
      telemetry.captureAiGeneration({
        traceId: 'trace-noop',
        provider: 'gateway',
        model: 'openai/gpt-5.4',
        input: [],
      }),
    ).not.toThrow()
    await expect(telemetry.shutdown()).resolves.toBeUndefined()
  } finally {
    await rm(installDir, { recursive: true, force: true })
  }
})

test('createPostHogTelemetry reuses a stable install id and creates fresh session and trace ids', async () => {
  const installDir = await mkdtemp(path.join(os.tmpdir(), 'posthog-test-stable-'))
  const installIdPath = path.join(installDir, 'anonymous-id')

  try {
    const firstTelemetry = createPostHogTelemetry({
      apiKey: 'test-key',
      installIdPath,
      createClient: () => ({
        capture: () => {},
        shutdown: async () => {},
      }),
    })
    const secondTelemetry = createPostHogTelemetry({
      apiKey: 'test-key',
      installIdPath,
      createClient: () => ({
        capture: () => {},
        shutdown: async () => {},
      }),
    })

    expect(firstTelemetry.distinctId).toBe(secondTelemetry.distinctId)
    expect(firstTelemetry.sessionId).not.toBe(secondTelemetry.sessionId)
    expect(firstTelemetry.createTraceId()).not.toBe(firstTelemetry.createTraceId())
  } finally {
    await rm(installDir, { recursive: true, force: true })
  }
})

test('createPostHogTelemetry flushes the underlying PostHog client on shutdown', async () => {
  const installDir = await mkdtemp(path.join(os.tmpdir(), 'posthog-test-shutdown-'))
  let shutdownCount = 0

  try {
    const telemetry = createPostHogTelemetry({
      apiKey: 'test-key',
      installIdPath: path.join(installDir, 'anonymous-id'),
      createClient: () => ({
        capture: () => {},
        shutdown: async () => {
          shutdownCount += 1
        },
      }),
    })

    await telemetry.shutdown()
    expect(shutdownCount).toBe(1)
  } finally {
    await rm(installDir, { recursive: true, force: true })
  }
})
