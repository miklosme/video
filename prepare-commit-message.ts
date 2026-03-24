import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_PREFIX = 'wip'
const DEFAULT_SUFFIX = 'update project files'
const MAX_SUBJECT_LENGTH = 100

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function extractSubjectLine(messageText: string): string {
  for (const line of messageText.split(/\r?\n/)) {
    const trimmedLine = line.trim()

    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue
    }

    return trimmedLine
  }

  return ''
}

export function shouldSkipPrepareCommitMessage(source?: string): boolean {
  return source === 'merge' || source === 'squash'
}

export function isManualSubject(subject: string): boolean {
  return subject.length > 10 || subject.includes(' ') || subject.includes(':')
}

export function selectPrefix(subject: string): string | null {
  const normalizedSubject = collapseWhitespace(subject).toLowerCase()

  if (!normalizedSubject || isManualSubject(normalizedSubject)) {
    return null
  }

  return normalizedSubject
}

export function buildCommitSubject(prefix: string | null, suffix: string): string {
  const safePrefix = prefix ?? DEFAULT_PREFIX
  const safeSuffix = collapseWhitespace(suffix) || DEFAULT_SUFFIX

  return `${safePrefix}: ${safeSuffix}`.slice(0, MAX_SUBJECT_LENGTH).trimEnd()
}

function loadSuggestedSuffix(repoRoot: string): string {
  const scratchPath = path.resolve(repoRoot, '.current-commit-message')

  try {
    return collapseWhitespace(readFileSync(scratchPath, 'utf8')) || DEFAULT_SUFFIX
  } catch {
    return DEFAULT_SUFFIX
  }
}

function clearSuggestedSuffix(repoRoot: string) {
  const scratchPath = path.resolve(repoRoot, '.current-commit-message')

  try {
    writeFileSync(scratchPath, '', 'utf8')
  } catch {
    // Keep commit flow resilient if the scratch file is missing or unwritable.
  }
}

export function applyPreparedCommitMessage(options: {
  messageFilePath: string
  source?: string
  repoRoot?: string
}): boolean {
  if (shouldSkipPrepareCommitMessage(options.source)) {
    return false
  }

  const repoRoot = options.repoRoot ?? process.cwd()
  const currentMessage = readFileSync(options.messageFilePath, 'utf8')
  const subject = extractSubjectLine(currentMessage)

  if (subject && isManualSubject(subject)) {
    clearSuggestedSuffix(repoRoot)
    return false
  }

  const nextSubject = buildCommitSubject(selectPrefix(subject), loadSuggestedSuffix(repoRoot))
  writeFileSync(options.messageFilePath, `${nextSubject}\n`, 'utf8')
  clearSuggestedSuffix(repoRoot)

  return true
}

if (import.meta.main) {
  const [messageFilePath, source] = process.argv.slice(2)

  if (!messageFilePath) {
    process.exit(0)
  }

  try {
    applyPreparedCommitMessage({
      messageFilePath,
      source,
      repoRoot: process.cwd(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[WARN] prepare-commit-msg fallback failed: ${message}`)
  }
}
