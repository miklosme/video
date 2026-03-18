import type { StatusData } from './workflow-data'

function formatRelatedFiles(relatedFiles: string[]) {
  if (relatedFiles.length === 0) {
    return ''
  }

  return ` _(related: ${relatedFiles.map((fileName) => `\`${fileName}\``).join(', ')})_`
}

export function formatChecklistItem(
  index: number,
  checked: boolean,
  title: string,
  relatedFiles: string[],
) {
  return `- [${checked ? 'x' : ' '}] ${index + 1}. ${title}${formatRelatedFiles(relatedFiles)}`
}

export function renderStatusChecklist(
  status: StatusData,
  options: {
    includeTitle?: boolean
  } = {},
) {
  const { includeTitle = false } = options
  const totalItems = status.length
  const checkedItems = status.filter((item) => item.checked).length
  const pendingItems = status
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.checked)
  const lines: string[] = []

  if (includeTitle) {
    lines.push('# Project Status Checklist')
    lines.push('')
  }

  lines.push(`Progress: ${checkedItems}/${totalItems} complete`)
  lines.push('')

  if (pendingItems.length > 0) {
    lines.push('## Next Up')

    for (const { item, index } of pendingItems.slice(0, 5)) {
      lines.push(formatChecklistItem(index, false, item.title, item.relatedFiles))
    }

    lines.push('')
  }

  lines.push('## Checklist')

  for (const [index, item] of status.entries()) {
    lines.push(formatChecklistItem(index, item.checked, item.title, item.relatedFiles))
  }

  return lines.join('\n').trimEnd()
}
