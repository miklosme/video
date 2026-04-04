import process from 'node:process'

import { main as runAppMain } from './app'
import { runProjectWorkspaceCli } from './project-workspace'

interface AppCliOptions {
  cwd?: string
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean }
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
  runSwitch?: typeof runProjectWorkspaceCli
  runApp?: () => Promise<void>
}

function writeLine(stream: Pick<NodeJS.WriteStream, 'write'>, line = '') {
  stream.write(`${line}\n`)
}

export async function runAppCli(argv = process.argv.slice(2), options: AppCliOptions = {}) {
  const resolvedOptions = {
    cwd: options.cwd ?? process.cwd(),
    stdin: options.stdin ?? process.stdin,
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    runSwitch: options.runSwitch ?? runProjectWorkspaceCli,
    runApp: options.runApp ?? runAppMain,
  }

  if (argv.length > 1) {
    writeLine(resolvedOptions.stderr, 'Usage: bun app [project-name]')
    return 1
  }

  const switchArgs = argv[0] ? ['switch', argv[0]] : ['switch']
  const exitCode = await resolvedOptions.runSwitch(switchArgs, {
    cwd: resolvedOptions.cwd,
    stdin: resolvedOptions.stdin,
    stdout: resolvedOptions.stdout,
    stderr: resolvedOptions.stderr,
  })

  if (exitCode !== 0) {
    return exitCode
  }

  await resolvedOptions.runApp()
  return 0
}

if (import.meta.main) {
  runAppCli()
    .then((exitCode) => {
      process.exitCode = exitCode
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
