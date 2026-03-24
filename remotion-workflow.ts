import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { spawn, type ChildProcess } from 'node:child_process'

import { ensureFinalCutManifest, resolveFinalCutProps } from './final-cut'
import { captureWorkflowEvent, shutdownPostHog } from './posthog'
import { startWorkspaceAssetServer } from './workspace-asset-server'

type RemotionMode = 'studio' | 'render'

export interface ManagedRemotionStudio {
  url: string
  stop: () => Promise<void>
}

function getRemotionBinary(cwd: string) {
  return path.resolve(cwd, 'node_modules', '.bin', 'remotion')
}

async function writeResolvedPropsFile(cwd: string, props: unknown) {
  const propsDir = await mkdtemp(path.join(os.tmpdir(), 'video-remotion-'))
  const propsPath = path.resolve(propsDir, 'final-cut-props.json')

  await writeFile(propsPath, `${JSON.stringify(props, null, 2)}\n`, 'utf8')

  return propsPath
}

async function prepareRemotionRuntime(cwd: string) {
  await ensureFinalCutManifest(cwd)
  const assetServer = await startWorkspaceAssetServer(cwd)
  const props = await resolveFinalCutProps(cwd, { assetBaseUrl: assetServer.url })
  const propsPath = await writeResolvedPropsFile(cwd, props)
  const propsDir = path.dirname(propsPath)

  return {
    assetServer,
    propsPath,
    async cleanup() {
      await assetServer.stop()
      await rm(propsDir, { recursive: true, force: true })
    },
  }
}

function extractStudioUrl(line: string) {
  const match = line.match(/Local:\s+(https?:\/\/[^\s,]+)/i)

  return match?.[1] ?? null
}

function waitForStudioUrl(
  child: ChildProcess & {
    stdout: NodeJS.ReadableStream
    stderr: NodeJS.ReadableStream
  },
) {
  return new Promise<string>((resolve, reject) => {
    let settled = false
    let recentOutput = ''

    const onData = (chunk: Buffer) => {
      const text = chunk.toString()
      recentOutput = `${recentOutput}${text}`.slice(-4000)

      for (const line of text.split(/\r?\n/)) {
        const url = extractStudioUrl(line)

        if (url) {
          settled = true
          child.stdout.resume()
          child.stderr.resume()
          cleanup()
          resolve(url)
          return
        }
      }
    }

    const onExit = (code: number | null) => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      reject(
        new Error(
          `Remotion Studio exited before reporting its URL (code ${code ?? 1}). ${recentOutput.trim()}`,
        ),
      )
    }

    const onError = (error: Error) => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      reject(error)
    }

    const cleanup = () => {
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
      child.off('close', onExit)
      child.off('error', onError)
    }

    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('close', onExit)
    child.on('error', onError)
  })
}

export async function startManagedRemotionStudio(
  cwd = process.cwd(),
  extraArgs: string[] = [],
): Promise<ManagedRemotionStudio> {
  const runtime = await prepareRemotionRuntime(cwd)
  const entryPoint = path.resolve(cwd, 'remotion', 'index.ts')
  const remotionBinary = getRemotionBinary(cwd)
  const child = spawn(
    remotionBinary,
    ['studio', entryPoint, '--props', runtime.propsPath, '--no-open', '--force-new', ...extraArgs],
    {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  try {
    const url = await waitForStudioUrl(child)
    let stopPromise: Promise<void> | null = null

    return {
      url,
      stop() {
        if (!stopPromise) {
          stopPromise = (async () => {
            if (!child.killed && child.exitCode === null) {
              child.kill('SIGTERM')
            }

            if (child.exitCode === null) {
              await new Promise<void>((resolve) => {
                child.once('close', () => resolve())
                child.once('error', () => resolve())
              })
            }
            await runtime.cleanup()
          })()
        }

        return stopPromise
      },
    }
  } catch (error) {
    if (!child.killed) {
      child.kill('SIGTERM')
    }
    await runtime.cleanup()
    throw error
  }
}

function hasFlag(args: string[], flag: string) {
  return args.some(
    (arg, index) => arg === flag || args[index - 1] === flag || arg.startsWith(`${flag}=`),
  )
}

async function runRemotion(mode: RemotionMode, extraArgs: string[]) {
  const cwd = process.cwd()
  const runtime = await prepareRemotionRuntime(cwd)

  try {
    const entryPoint = path.resolve(cwd, 'remotion', 'index.ts')
    const remotionBinary = getRemotionBinary(cwd)
    const renderArgs =
      mode === 'studio'
        ? ['studio', entryPoint, '--props', runtime.propsPath, ...extraArgs]
        : [
            'render',
            entryPoint,
            'final-cut',
            ...(hasFlag(extraArgs, '--output') ? [] : [path.resolve(cwd, 'outputs', 'final.mp4')]),
            '--props',
            runtime.propsPath,
            ...extraArgs,
          ]

    captureWorkflowEvent('remotion_render_started', { mode })

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(remotionBinary, renderArgs, {
        cwd,
        stdio: 'inherit',
      })

      child.on('error', reject)
      child.on('close', (code) => resolve(code ?? 1))
    })

    if (exitCode !== 0) {
      process.exit(exitCode)
    }
  } finally {
    await runtime.cleanup()
  }
}

async function main() {
  const [modeArg, ...extraArgs] = process.argv.slice(2)

  if (modeArg !== 'studio' && modeArg !== 'render') {
    throw new Error('Usage: bun remotion-workflow.ts <studio|render> [remotion args...]')
  }

  await runRemotion(modeArg, extraArgs)
}

if (import.meta.main) {
  await main().finally(() => shutdownPostHog())
}
