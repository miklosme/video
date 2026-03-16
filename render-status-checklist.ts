import path from 'node:path'

import { WORKFLOW_FILES, loadProject, loadStatus } from './workflow-data'

const WORKSPACE_DIR = 'workspace'

interface PendingItemSummary {
  sectionTitle: string
  text: string
  sourceFiles: string[]
}

function resolveWorkspacePath(fileName: string, cwd = process.cwd()) {
  return path.resolve(cwd, WORKSPACE_DIR, fileName)
}

function formatSourceFiles(sourceFiles: string[]) {
  if (sourceFiles.length === 0) {
    return ''
  }

  return ` _(source: ${sourceFiles.map((fileName) => `\`${fileName}\``).join(', ')})_`
}

function formatChecklistItem(
  checked: boolean,
  text: string,
  sourceFiles: string[],
  sectionTitle?: string,
) {
  const sectionLabel = sectionTitle ? ` (${sectionTitle})` : ''

  return `- [${checked ? 'x' : ' '}] ${text}${sectionLabel}${formatSourceFiles(sourceFiles)}`
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
  const totalItems = status.sections.reduce((sum, section) => sum + section.items.length, 0)
  const checkedItems = status.sections.reduce(
    (sum, section) => sum + section.items.filter((item) => item.checked).length,
    0,
  )
  const pendingItems: PendingItemSummary[] = status.sections.flatMap((section) =>
    section.items
      .filter((item) => !item.checked)
      .map((item) => ({
        sectionTitle: section.title,
        text: item.text,
        sourceFiles: item.sourceFiles,
      })),
  )

  console.log('# Project Status Checklist')
  console.log()

  if (project) {
    console.log(`Current phase: \`${project.currentPhase}\``)
  }

  console.log(`Progress: ${checkedItems}/${totalItems} complete`)
  console.log()

  if (pendingItems.length > 0) {
    console.log('## Next Up')

    for (const item of pendingItems.slice(0, 5)) {
      console.log(formatChecklistItem(false, item.text, item.sourceFiles, item.sectionTitle))
    }

    console.log()
  }

  for (const section of status.sections) {
    console.log(`## ${section.title}`)

    for (const item of section.items) {
      console.log(formatChecklistItem(item.checked, item.text, item.sourceFiles))
    }

    console.log()
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
