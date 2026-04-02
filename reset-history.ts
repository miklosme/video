import { access, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { ensureActiveWorkspace } from './project-workspace'

const WORKSPACE_HISTORY_PATH = path.resolve(process.cwd(), 'workspace/HISTORY.json')
const LEGACY_HISTORY_PATH = path.resolve(process.cwd(), 'HISTORY.json')

type TranscriptRole = 'assistant' | 'user' | 'tool'

interface TranscriptEntry {
  id: string
  role: TranscriptRole
  text: string
}

interface PersistedAgentState {
  version: number
  transcript: TranscriptEntry[]
  composerValue?: string
  recentChanges?: string[]
  runtimeError?: string | null
}

async function fileExists(targetPath: string) {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

async function main() {
  await ensureActiveWorkspace()
  const historyPath =
    (await fileExists(WORKSPACE_HISTORY_PATH)) || !(await fileExists(LEGACY_HISTORY_PATH))
      ? WORKSPACE_HISTORY_PATH
      : LEGACY_HISTORY_PATH
  const raw = await readFile(historyPath, 'utf8')
  const state = JSON.parse(raw) as PersistedAgentState

  if (!Array.isArray(state.transcript)) {
    throw new Error('Invalid history format: transcript must be an array.')
  }

  const lastUserIndex = state.transcript.map((entry) => entry.role).lastIndexOf('user')

  if (lastUserIndex === -1) {
    return
  }

  const deletedEntries = state.transcript.slice(lastUserIndex)

  console.log(JSON.stringify(deletedEntries, null, 2))
  state.transcript = state.transcript.slice(0, lastUserIndex)
  await writeFile(historyPath, `${JSON.stringify(state, null, 2)}\n`)
}

main().catch((error: unknown) => {
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
    process.exit(0)
  }

  console.error(error)
  process.exit(1)
})
