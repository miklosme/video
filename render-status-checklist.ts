import { renderStatusChecklist } from './status-checklist-format'
import { loadStatus } from './workflow-data'

async function main() {
  const status = await loadStatus(process.cwd())

  console.log(
    renderStatusChecklist(status, {
      includeTitle: true,
    }),
  )
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
