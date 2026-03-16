import path from 'node:path'

import { renderStatusChecklist } from './status-checklist-format'
import { WORKFLOW_FILES, loadProject, loadStatus } from './workflow-data'

const WORKSPACE_DIR = 'workspace'

function resolveWorkspacePath(fileName: string, cwd = process.cwd()) {
  return path.resolve(cwd, WORKSPACE_DIR, fileName)
}

async function main() {
  const cwd = process.cwd()
  const statusPath = resolveWorkspacePath(WORKFLOW_FILES.status, cwd)
  const projectPath = resolveWorkspacePath(WORKFLOW_FILES.project, cwd)

  const status = await loadStatus(cwd)
  let project = null

  try {
    project = await loadProject(cwd)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    if (!message.includes(path.relative(cwd, projectPath)) && !message.includes(projectPath)) {
      throw error
    }
  }

  console.log(
    renderStatusChecklist(status, {
      includeTitle: true,
      phase: project?.currentPhase ?? null,
    }),
  )
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
