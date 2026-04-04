import { expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'

import { runAppCli } from './app-cli'

function createCaptureStream() {
  const stream = new PassThrough()
  let output = ''
  stream.on('data', (chunk) => {
    output += chunk.toString()
  })

  return {
    stream,
    read() {
      return output
    },
  }
}

test('runAppCli passes a named project to switch before launching the app', async () => {
  const stdout = createCaptureStream()
  const stderr = createCaptureStream()
  const stdin = Object.assign(new PassThrough(), { isTTY: true })
  const calls: string[] = []
  let receivedArgv: string[] | undefined

  const exitCode = await runAppCli(['foo'], {
    stdin,
    stdout: stdout.stream,
    stderr: stderr.stream,
    runSwitch: async (argv) => {
      calls.push('switch')
      receivedArgv = argv
      return 0
    },
    runApp: async () => {
      calls.push('app')
    },
  })

  expect(exitCode).toBe(0)
  expect(receivedArgv).toEqual(['switch', 'foo'])
  expect(calls).toEqual(['switch', 'app'])
  expect(stdout.read()).toBe('')
  expect(stderr.read()).toBe('')
})

test('runAppCli prompts project selection when no project name is provided', async () => {
  const stdin = Object.assign(new PassThrough(), { isTTY: true })
  let receivedArgv: string[] | undefined

  await runAppCli([], {
    stdin,
    runSwitch: async (argv) => {
      receivedArgv = argv
      return 0
    },
    runApp: async () => {},
  })

  expect(receivedArgv).toEqual(['switch'])
})

test('runAppCli stops before launching the app when switch fails', async () => {
  let launchedApp = false

  const exitCode = await runAppCli(['foo'], {
    runSwitch: async () => 1,
    runApp: async () => {
      launchedApp = true
    },
  })

  expect(exitCode).toBe(1)
  expect(launchedApp).toBe(false)
})

test('runAppCli rejects extra arguments with usage guidance', async () => {
  const stderr = createCaptureStream()
  let ranSwitch = false
  let ranApp = false

  const exitCode = await runAppCli(['foo', 'bar'], {
    stderr: stderr.stream,
    runSwitch: async () => {
      ranSwitch = true
      return 0
    },
    runApp: async () => {
      ranApp = true
    },
  })

  expect(exitCode).toBe(1)
  expect(ranSwitch).toBe(false)
  expect(ranApp).toBe(false)
  expect(stderr.read()).toContain('Usage: bun app [project-name]')
})
