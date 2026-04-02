import { lstat, mkdir, readdir, readlink, rm, stat, symlink } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'

import { WORKSPACE_DIR } from './workflow-data'

export const PROJECTS_DIR = 'projects'

const LEGACY_WORKSPACE_PLACEHOLDER_FILES = new Set(['.DS_Store', '.gitkeep'])

export interface ProjectInfo {
  name: string
  path: string
  isActive: boolean
}

export interface ActiveWorkspaceInfo {
  workspacePath: string
  kind: 'directory' | 'symlink'
  projectName: string | null
}

interface ProjectCommandResult {
  projectName: string
  projectPath: string
  workspacePath: string
  alreadyActive: boolean
}

interface ProjectWorkspaceCliOptions {
  cwd?: string
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean }
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
}

function resolveWorkspacePath(cwd: string) {
  return path.resolve(cwd, WORKSPACE_DIR)
}

function resolveProjectsPath(cwd: string) {
  return path.resolve(cwd, PROJECTS_DIR)
}

function resolveProjectPath(cwd: string, projectName: string) {
  return path.resolve(resolveProjectsPath(cwd), projectName)
}

function writeLine(stream: Pick<NodeJS.WriteStream, 'write'>, line = '') {
  stream.write(`${line}\n`)
}

function isDirectChildOfProjects(projectPath: string, projectsPath: string) {
  const relativePath = path.relative(projectsPath, projectPath)

  return (
    relativePath.length > 0 &&
    !relativePath.startsWith(`..${path.sep}`) &&
    relativePath !== '..' &&
    !path.isAbsolute(relativePath) &&
    !relativePath.includes(path.sep)
  )
}

function getActivateWorkspaceMessage() {
  return 'No active workspace. Run bun run switch <project-name> or bun run new <project-name> first.'
}

async function pathExists(targetPath: string) {
  try {
    await lstat(targetPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }

    throw error
  }
}

async function readProjectEntries(
  cwd: string,
): Promise<Array<{ name: string; isDirectory: () => boolean }>> {
  const projectsPath = resolveProjectsPath(cwd)

  try {
    return await readdir(projectsPath, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }

    throw error
  }
}

async function isWorkspaceLinkedToProject(cwd: string, projectName: string) {
  const workspacePath = resolveWorkspacePath(cwd)

  try {
    const workspaceEntry = await lstat(workspacePath)

    if (!workspaceEntry.isSymbolicLink()) {
      return false
    }

    const linkTarget = await readlink(workspacePath)
    const resolvedTarget = path.resolve(path.dirname(workspacePath), linkTarget)

    return path.normalize(resolvedTarget) === path.normalize(resolveProjectPath(cwd, projectName))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }

    throw error
  }
}

async function assertProjectExists(cwd: string, projectName: string) {
  const projectPath = resolveProjectPath(cwd, projectName)
  let projectStats: Awaited<ReturnType<typeof stat>>

  try {
    projectStats = await stat(projectPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Project "${projectName}" does not exist under ${PROJECTS_DIR}/.`)
    }

    throw error
  }

  if (!projectStats.isDirectory()) {
    throw new Error(`Project "${projectName}" is not a directory under ${PROJECTS_DIR}/.`)
  }

  return projectPath
}

async function removeWorkspaceMountPoint(cwd: string) {
  const workspacePath = resolveWorkspacePath(cwd)

  try {
    const workspaceEntry = await lstat(workspacePath)

    if (workspaceEntry.isSymbolicLink()) {
      await rm(workspacePath, { force: true })
      return
    }

    if (!workspaceEntry.isDirectory()) {
      throw new Error(
        `Refusing to replace ${WORKSPACE_DIR}/ because it is not a directory or symlink.`,
      )
    }

    const entryNames = (await readdir(workspacePath)).filter(
      (entryName) => !LEGACY_WORKSPACE_PLACEHOLDER_FILES.has(entryName),
    )

    if (entryNames.length > 0) {
      throw new Error(
        `Refusing to replace non-empty ${WORKSPACE_DIR}/. Move or remove it manually before switching projects.`,
      )
    }

    await rm(workspacePath, { recursive: true, force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }

    throw error
  }
}

async function createWorkspaceSymlink(cwd: string, projectName: string) {
  const workspacePath = resolveWorkspacePath(cwd)
  const projectPath = resolveProjectPath(cwd, projectName)
  const relativeTarget = path.relative(path.dirname(workspacePath), projectPath)

  await symlink(relativeTarget, workspacePath, process.platform === 'win32' ? 'junction' : 'dir')

  return workspacePath
}

async function promptForProjectSelection(
  projects: ProjectInfo[],
  options: Required<Pick<ProjectWorkspaceCliOptions, 'stdin' | 'stdout'>>,
) {
  const readline = createInterface({
    input: options.stdin,
    output: options.stdout,
  })

  try {
    while (true) {
      const answer = (await readline.question('Select a project by number: ')).trim()

      if (answer.length === 0) {
        throw new Error('No project selected.')
      }

      const selection = Number.parseInt(answer, 10)

      if (Number.isInteger(selection) && selection >= 1 && selection <= projects.length) {
        const selectedProject = projects[selection - 1]

        if (selectedProject) {
          return selectedProject.name
        }
      }

      writeLine(options.stdout, `Invalid selection "${answer}". Enter 1-${projects.length}.`)
    }
  } finally {
    readline.close()
  }
}

export function validateProjectName(projectName: string) {
  const normalizedProjectName = projectName.trim()

  if (normalizedProjectName.length === 0) {
    throw new Error('Project name must not be empty.')
  }

  if (normalizedProjectName === '.' || normalizedProjectName === '..') {
    throw new Error('Project name must be a single folder name.')
  }

  if (normalizedProjectName.includes('/') || normalizedProjectName.includes('\\')) {
    throw new Error(
      'Project name must be a single folder name and must not include path separators.',
    )
  }

  return normalizedProjectName
}

export async function getActiveProjectName(cwd = process.cwd()) {
  const workspacePath = resolveWorkspacePath(cwd)

  try {
    const workspaceEntry = await lstat(workspacePath)

    if (!workspaceEntry.isSymbolicLink()) {
      return null
    }

    const linkTarget = await readlink(workspacePath)
    const resolvedTarget = path.resolve(path.dirname(workspacePath), linkTarget)
    const projectsPath = resolveProjectsPath(cwd)

    if (!isDirectChildOfProjects(resolvedTarget, projectsPath)) {
      return null
    }

    return path.basename(resolvedTarget)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    throw error
  }
}

export async function listProjects(cwd = process.cwd()): Promise<ProjectInfo[]> {
  const [entries, activeProjectName] = await Promise.all([
    readProjectEntries(cwd),
    getActiveProjectName(cwd),
  ])

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
    .map((projectName) => ({
      name: projectName,
      path: resolveProjectPath(cwd, projectName),
      isActive: projectName === activeProjectName,
    }))
}

export function formatProjectList(projects: ProjectInfo[]) {
  return projects
    .map((project, index) => `${index + 1}. ${project.name}${project.isActive ? ' (active)' : ''}`)
    .join('\n')
}

export async function ensureActiveWorkspace(cwd = process.cwd()): Promise<ActiveWorkspaceInfo> {
  const workspacePath = resolveWorkspacePath(cwd)

  let workspaceEntry: Awaited<ReturnType<typeof lstat>>

  try {
    workspaceEntry = await lstat(workspacePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(getActivateWorkspaceMessage())
    }

    throw error
  }

  if (workspaceEntry.isSymbolicLink()) {
    let targetStats: Awaited<ReturnType<typeof stat>>

    try {
      targetStats = await stat(workspacePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `The active ${WORKSPACE_DIR}/ symlink is broken. Run bun run switch <project-name> or bun run new <project-name> first.`,
        )
      }

      throw error
    }

    if (!targetStats.isDirectory()) {
      throw new Error(
        `${WORKSPACE_DIR}/ must point to a project directory. Run bun run switch <project-name> to repair it.`,
      )
    }

    return {
      workspacePath,
      kind: 'symlink',
      projectName: await getActiveProjectName(cwd),
    }
  }

  if (workspaceEntry.isDirectory()) {
    return {
      workspacePath,
      kind: 'directory',
      projectName: null,
    }
  }

  throw new Error(
    `${WORKSPACE_DIR}/ must be a directory or symlink. Run bun run switch <project-name> or bun run new <project-name> first.`,
  )
}

export async function switchActiveProject(
  projectName: string,
  cwd = process.cwd(),
): Promise<ProjectCommandResult> {
  const normalizedProjectName = validateProjectName(projectName)
  const projectPath = await assertProjectExists(cwd, normalizedProjectName)
  const alreadyActive = await isWorkspaceLinkedToProject(cwd, normalizedProjectName)

  if (!alreadyActive) {
    await removeWorkspaceMountPoint(cwd)
    await createWorkspaceSymlink(cwd, normalizedProjectName)
  }

  return {
    projectName: normalizedProjectName,
    projectPath,
    workspacePath: resolveWorkspacePath(cwd),
    alreadyActive,
  }
}

export async function createProject(
  projectName: string,
  cwd = process.cwd(),
): Promise<ProjectCommandResult> {
  const normalizedProjectName = validateProjectName(projectName)
  const projectsPath = resolveProjectsPath(cwd)
  const projectPath = resolveProjectPath(cwd, normalizedProjectName)

  await mkdir(projectsPath, { recursive: true })

  if (await pathExists(projectPath)) {
    throw new Error(`Project "${normalizedProjectName}" already exists under ${PROJECTS_DIR}/.`)
  }

  await mkdir(projectPath)

  return switchActiveProject(normalizedProjectName, cwd)
}

async function runSwitchCommand(
  projectName: string | undefined,
  options: Required<ProjectWorkspaceCliOptions>,
) {
  if (projectName) {
    const result = await switchActiveProject(projectName, options.cwd)

    writeLine(
      options.stdout,
      result.alreadyActive
        ? `Project "${result.projectName}" is already active at ${WORKSPACE_DIR}/.`
        : `Switched ${WORKSPACE_DIR}/ to ${PROJECTS_DIR}/${result.projectName}.`,
    )

    return 0
  }

  const projects = await listProjects(options.cwd)

  if (projects.length === 0) {
    writeLine(
      options.stderr,
      `No projects found under ${PROJECTS_DIR}/. Run bun run new <project-name> first.`,
    )
    return 1
  }

  writeLine(options.stdout, 'Available projects:')
  writeLine(options.stdout, formatProjectList(projects))

  if (!options.stdin.isTTY) {
    writeLine(
      options.stderr,
      `Interactive selection requires a TTY. Rerun with bun run switch <project-name>.`,
    )
    return 1
  }

  writeLine(options.stdout)
  const selectedProjectName = await promptForProjectSelection(projects, options)
  const result = await switchActiveProject(selectedProjectName, options.cwd)

  writeLine(
    options.stdout,
    result.alreadyActive
      ? `Project "${result.projectName}" is already active at ${WORKSPACE_DIR}/.`
      : `Switched ${WORKSPACE_DIR}/ to ${PROJECTS_DIR}/${result.projectName}.`,
  )

  return 0
}

async function runNewCommand(
  projectName: string | undefined,
  options: Required<Pick<ProjectWorkspaceCliOptions, 'cwd' | 'stdout'>>,
) {
  if (!projectName) {
    throw new Error('Usage: bun run new <project-name>')
  }

  const result = await createProject(projectName, options.cwd)

  writeLine(options.stdout, `Created ${PROJECTS_DIR}/${result.projectName}.`)
  writeLine(options.stdout, `Switched ${WORKSPACE_DIR}/ to ${PROJECTS_DIR}/${result.projectName}.`)

  return 0
}

export async function runProjectWorkspaceCli(
  argv = process.argv.slice(2),
  options: ProjectWorkspaceCliOptions = {},
) {
  const [command, projectName, ...extraArgs] = argv
  const resolvedOptions: Required<ProjectWorkspaceCliOptions> = {
    cwd: options.cwd ?? process.cwd(),
    stdin: options.stdin ?? process.stdin,
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
  }

  if (command !== 'switch' && command !== 'new') {
    writeLine(
      resolvedOptions.stderr,
      'Usage: bun project-workspace.ts <switch [project-name]|new <project-name>>',
    )
    return 1
  }

  if (extraArgs.length > 0) {
    throw new Error(
      command === 'switch'
        ? 'Usage: bun run switch [project-name]'
        : 'Usage: bun run new <project-name>',
    )
  }

  if (command === 'switch') {
    return runSwitchCommand(projectName, resolvedOptions)
  }

  return runNewCommand(projectName, resolvedOptions)
}

if (import.meta.main) {
  runProjectWorkspaceCli()
    .then((exitCode) => {
      process.exitCode = exitCode
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
