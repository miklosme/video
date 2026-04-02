import { expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import {
  createProject,
  ensureActiveWorkspace,
  listProjects,
  runProjectWorkspaceCli,
  switchActiveProject,
  validateProjectName,
} from './project-workspace'

async function writeRepoFile(rootDir: string, relativePath: string, content: string) {
  const filePath = path.resolve(rootDir, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')
}

async function createTempRepo() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-project-workspace-'))

  return {
    rootDir,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true })
    },
  }
}

async function createProjectDir(rootDir: string, projectName: string) {
  await mkdir(path.resolve(rootDir, 'projects', projectName), { recursive: true })
}

async function linkWorkspaceToProject(rootDir: string, projectName: string) {
  await symlink(path.join('projects', projectName), path.resolve(rootDir, 'workspace'), 'dir')
}

function createCaptureStream() {
  const stream = new PassThrough()
  let output = ''
  stream.on('data', (chunk) => {
    output += chunk.toString()
  })

  return {
    stream,
    read() {
      return output
    },
  }
}

test('listProjects sorts project folders and marks the active project', async () => {
  const repo = await createTempRepo()

  try {
    await createProjectDir(repo.rootDir, 'panda')
    await createProjectDir(repo.rootDir, 'florence')
    await linkWorkspaceToProject(repo.rootDir, 'panda')

    const projects = await listProjects(repo.rootDir)

    expect(projects.map((project) => project.name)).toEqual(['florence', 'panda'])
    expect(projects.map((project) => project.isActive)).toEqual([false, true])
  } finally {
    await repo.cleanup()
  }
})

test('validateProjectName rejects empty and path-like names', () => {
  for (const invalidName of ['', '   ', '.', '..', 'foo/bar', 'foo\\bar']) {
    expect(() => validateProjectName(invalidName)).toThrow()
  }

  expect(validateProjectName('florence')).toBe('florence')
})

test('switchActiveProject creates the workspace symlink for an existing project', async () => {
  const repo = await createTempRepo()

  try {
    await createProjectDir(repo.rootDir, 'panda')

    const result = await switchActiveProject('panda', repo.rootDir)
    const workspacePath = path.resolve(repo.rootDir, 'workspace')

    expect(result.alreadyActive).toBe(false)
    expect((await lstat(workspacePath)).isSymbolicLink()).toBe(true)
    expect(path.normalize(await readlink(workspacePath))).toBe(path.normalize('projects/panda'))
  } finally {
    await repo.cleanup()
  }
})

test('createProject creates a new project folder and auto-switches workspace', async () => {
  const repo = await createTempRepo()

  try {
    const result = await createProject('florence', repo.rootDir)

    expect(result.projectName).toBe('florence')
    expect((await lstat(path.resolve(repo.rootDir, 'workspace'))).isSymbolicLink()).toBe(true)
    expect(path.normalize(await readlink(path.resolve(repo.rootDir, 'workspace')))).toBe(
      path.normalize('projects/florence'),
    )
  } finally {
    await repo.cleanup()
  }
})

test('switchActiveProject replaces the legacy placeholder workspace directory', async () => {
  const repo = await createTempRepo()

  try {
    await createProjectDir(repo.rootDir, 'panda')
    await writeRepoFile(repo.rootDir, 'workspace/.gitkeep', '')

    await switchActiveProject('panda', repo.rootDir)

    expect((await lstat(path.resolve(repo.rootDir, 'workspace'))).isSymbolicLink()).toBe(true)
  } finally {
    await repo.cleanup()
  }
})

test('switchActiveProject refuses to replace a non-empty workspace directory', async () => {
  const repo = await createTempRepo()

  try {
    await createProjectDir(repo.rootDir, 'panda')
    await writeRepoFile(repo.rootDir, 'workspace/IDEA.md', '# IDEA\n')

    await expect(switchActiveProject('panda', repo.rootDir)).rejects.toThrow(
      'Refusing to replace non-empty workspace/',
    )
  } finally {
    await repo.cleanup()
  }
})

test('ensureActiveWorkspace explains how to activate a project when workspace is missing', async () => {
  const repo = await createTempRepo()

  try {
    await expect(ensureActiveWorkspace(repo.rootDir)).rejects.toThrow(
      'No active workspace. Run bun run switch <project-name> or bun run new <project-name> first.',
    )
  } finally {
    await repo.cleanup()
  }
})

test('ensureActiveWorkspace accepts a workspace symlink into projects', async () => {
  const repo = await createTempRepo()

  try {
    await createProjectDir(repo.rootDir, 'florence')
    await linkWorkspaceToProject(repo.rootDir, 'florence')

    await expect(ensureActiveWorkspace(repo.rootDir)).resolves.toMatchObject({
      kind: 'symlink',
      projectName: 'florence',
    })
  } finally {
    await repo.cleanup()
  }
})

test('runProjectWorkspaceCli supports interactive selection when switch has no project name', async () => {
  const repo = await createTempRepo()

  try {
    await createProjectDir(repo.rootDir, 'florence')
    await createProjectDir(repo.rootDir, 'panda')
    await linkWorkspaceToProject(repo.rootDir, 'florence')

    const stdin = Object.assign(new PassThrough(), { isTTY: true })
    const stdout = createCaptureStream()
    const stderr = createCaptureStream()

    stdin.end('2\n')

    const exitCode = await runProjectWorkspaceCli(['switch'], {
      cwd: repo.rootDir,
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
    })

    expect(exitCode).toBe(0)
    expect(stdout.read()).toContain('1. florence (active)')
    expect(stdout.read()).toContain('2. panda')
    expect(stdout.read()).toContain('Select a project by number:')
    expect(stderr.read()).toBe('')
    expect(path.normalize(await readlink(path.resolve(repo.rootDir, 'workspace')))).toBe(
      path.normalize('projects/panda'),
    )
  } finally {
    await repo.cleanup()
  }
})

test('runProjectWorkspaceCli lists projects and exits with guidance in non-TTY mode', async () => {
  const repo = await createTempRepo()

  try {
    await createProjectDir(repo.rootDir, 'florence')
    await createProjectDir(repo.rootDir, 'panda')

    const stdin = Object.assign(new PassThrough(), { isTTY: false })
    const stdout = createCaptureStream()
    const stderr = createCaptureStream()

    const exitCode = await runProjectWorkspaceCli(['switch'], {
      cwd: repo.rootDir,
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
    })

    expect(exitCode).toBe(1)
    expect(stdout.read()).toContain('Available projects:')
    expect(stdout.read()).toContain('1. florence')
    expect(stdout.read()).toContain('2. panda')
    expect(stderr.read()).toContain('Interactive selection requires a TTY.')
  } finally {
    await repo.cleanup()
  }
})
