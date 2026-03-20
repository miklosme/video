import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const historyPath = path.resolve(process.cwd(), '.history.json')

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

async function main() {
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
