import { WORKFLOW_FILES } from './workflow-data'

const EDITOR_PREREQUISITE_FILES = new Set([WORKFLOW_FILES.shotPrompts, WORKFLOW_FILES.finalCut])

function normalizePath(filePath: string) {
  return filePath.replace(/\\/g, '/')
}

function isMissingEditorPrerequisite(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false
  }

  const candidate = error as NodeJS.ErrnoException & { path?: string }

  if (candidate.code !== 'ENOENT') {
    return false
  }

  const errorPath = typeof candidate.path === 'string' ? normalizePath(candidate.path) : null
  const errorMessage = candidate.message

  return [...EDITOR_PREREQUISITE_FILES].some((fileName) => {
    const workspacePath = `/workspace/${fileName}`

    return (
      errorPath?.endsWith(workspacePath) === true ||
      errorPath === `workspace/${fileName}` ||
      errorMessage.includes(workspacePath)
    )
  })
}

export function getEditorStatus(error: unknown) {
  if (isMissingEditorPrerequisite(error)) {
    return 'Not yet available'
  }

  return `Unavailable: ${error instanceof Error ? error.message : String(error)}`
}
