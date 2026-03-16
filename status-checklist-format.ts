import type { Phase, TodoData } from './workflow-data'

interface PendingItemSummary {
  sectionTitle: string
  text: string
  sourceFiles: string[]
}

function formatSourceFiles(sourceFiles: string[]) {
  if (sourceFiles.length === 0) {
    return ''
  }

  return ` _(source: ${sourceFiles.map((fileName) => `\`${fileName}\``).join(', ')})_`
}

export function formatChecklistItem(
  checked: boolean,
  text: string,
  sourceFiles: string[],
  sectionTitle?: string,
) {
  const sectionLabel = sectionTitle ? ` (${sectionTitle})` : ''

  return `- [${checked ? 'x' : ' '}] ${text}${sectionLabel}${formatSourceFiles(sourceFiles)}`
}

export function renderStatusChecklist(
  status: TodoData,
  options: {
    includeTitle?: boolean
    phase?: Phase | null
  } = {},
) {
  const { includeTitle = false, phase = null } = options
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
  const lines: string[] = []

  if (includeTitle) {
    lines.push('# Project Status Checklist')
    lines.push('')
  }

  if (phase) {
    lines.push(`Current phase: \`${phase}\``)
  }

  lines.push(`Progress: ${checkedItems}/${totalItems} complete`)
  lines.push('')

  if (pendingItems.length > 0) {
    lines.push('## Next Up')

    for (const item of pendingItems.slice(0, 5)) {
      lines.push(formatChecklistItem(false, item.text, item.sourceFiles, item.sectionTitle))
    }

    lines.push('')
  }

  for (const section of status.sections) {
    lines.push(`## ${section.title}`)

    for (const item of section.items) {
      lines.push(formatChecklistItem(item.checked, item.text, item.sourceFiles))
    }

    lines.push('')
  }

  return lines.join('\n').trimEnd()
}
