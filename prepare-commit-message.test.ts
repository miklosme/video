import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  applyPreparedCommitMessage,
  buildCommitSubject,
  collapseWhitespace,
} from './prepare-commit-message'

async function createScratchRepo() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-commit-message-'))

  return {
    rootDir,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true })
    },
  }
}

test('collapses whitespace for the agent-written suffix', () => {
  expect(collapseWhitespace('  tighten   commit   messaging \n flow  ')).toBe(
    'tighten commit messaging flow',
  )
})

test('buildCommitSubject falls back to a default prefix and suffix', () => {
  expect(buildCommitSubject(null, '')).toBe('wip: update project files')
})

test('expands a short type-only subject with the agent summary', async () => {
  const repo = await createScratchRepo()

  try {
    const messageFilePath = path.resolve(repo.rootDir, 'COMMIT_EDITMSG')
    await writeFile(
      path.resolve(repo.rootDir, '.current-commit-message'),
      'Ship hook-backed commit summaries\n',
    )
    await writeFile(messageFilePath, 'FIX\n', 'utf8')

    const changed = applyPreparedCommitMessage({
      messageFilePath,
      source: 'message',
      repoRoot: repo.rootDir,
    })

    expect(changed).toBe(true)
    expect(await readFile(messageFilePath, 'utf8')).toBe('fix: Ship hook-backed commit summaries\n')
  } finally {
    await repo.cleanup()
  }
})

test('leaves a longer manual commit subject untouched', async () => {
  const repo = await createScratchRepo()

  try {
    const messageFilePath = path.resolve(repo.rootDir, 'COMMIT_EDITMSG')
    await writeFile(path.resolve(repo.rootDir, '.current-commit-message'), 'Should not be used\n')
    await writeFile(messageFilePath, 'refactor auth flow\n', 'utf8')

    const changed = applyPreparedCommitMessage({
      messageFilePath,
      source: 'message',
      repoRoot: repo.rootDir,
    })

    expect(changed).toBe(false)
    expect(await readFile(messageFilePath, 'utf8')).toBe('refactor auth flow\n')
  } finally {
    await repo.cleanup()
  }
})

test('uses wip when the commit subject starts empty', async () => {
  const repo = await createScratchRepo()

  try {
    const messageFilePath = path.resolve(repo.rootDir, 'COMMIT_EDITMSG')
    await writeFile(
      path.resolve(repo.rootDir, '.current-commit-message'),
      'Describe the validated tooling update\n',
    )
    await writeFile(messageFilePath, '\n', 'utf8')

    applyPreparedCommitMessage({
      messageFilePath,
      repoRoot: repo.rootDir,
    })

    expect(await readFile(messageFilePath, 'utf8')).toBe(
      'wip: Describe the validated tooling update\n',
    )
  } finally {
    await repo.cleanup()
  }
})

test('falls back when the scratch message is missing and truncates long subjects', async () => {
  const repo = await createScratchRepo()

  try {
    const messageFilePath = path.resolve(repo.rootDir, 'COMMIT_EDITMSG')
    await writeFile(messageFilePath, '\n', 'utf8')

    applyPreparedCommitMessage({
      messageFilePath,
      repoRoot: repo.rootDir,
    })

    expect(await readFile(messageFilePath, 'utf8')).toBe('wip: update project files\n')

    await writeFile(path.resolve(repo.rootDir, '.current-commit-message'), 'a'.repeat(140), 'utf8')
    await writeFile(messageFilePath, '\n', 'utf8')

    applyPreparedCommitMessage({
      messageFilePath,
      source: 'message',
      repoRoot: repo.rootDir,
    })

    const subject = (await readFile(messageFilePath, 'utf8')).trimEnd()
    expect(subject.length).toBe(100)
    expect(subject.startsWith('wip: ')).toBe(true)
  } finally {
    await repo.cleanup()
  }
})

test('skips merge and squash commits', async () => {
  const repo = await createScratchRepo()

  try {
    const messageFilePath = path.resolve(repo.rootDir, 'COMMIT_EDITMSG')
    await writeFile(path.resolve(repo.rootDir, '.current-commit-message'), 'Should not be used\n')
    await writeFile(messageFilePath, 'Merge branch feature\n', 'utf8')

    const skippedMerge = applyPreparedCommitMessage({
      messageFilePath,
      source: 'merge',
      repoRoot: repo.rootDir,
    })

    expect(skippedMerge).toBe(false)
    expect(await readFile(messageFilePath, 'utf8')).toBe('Merge branch feature\n')

    const skippedSquash = applyPreparedCommitMessage({
      messageFilePath,
      source: 'squash',
      repoRoot: repo.rootDir,
    })

    expect(skippedSquash).toBe(false)
    expect(await readFile(messageFilePath, 'utf8')).toBe('Merge branch feature\n')
  } finally {
    await repo.cleanup()
  }
})
