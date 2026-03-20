import type { StatusData } from './workflow-data'

export function formatChecklistItem(index: number, checked: boolean, title: string) {
  return `- [${checked ? 'x' : ' '}] ${index + 1}. ${title}`
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

  lines.push(`Progress: ${checkedItems}/${totalItems} milestones ready`)
  lines.push('')

  if (pendingItems.length > 0) {
    lines.push('## Next Up')

    for (const { item, index } of pendingItems.slice(0, 5)) {
      lines.push(formatChecklistItem(index, false, item.title))
    }

    lines.push('')
  }

  lines.push('## Checklist')

  for (const [index, item] of status.entries()) {
    lines.push(formatChecklistItem(index, item.checked, item.title))
  }

  return lines.join('\n').trimEnd()
}
