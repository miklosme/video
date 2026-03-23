import { access } from 'node:fs/promises'
import path from 'node:path'

import { resolveRepoPath } from './workflow-data'

export interface WorkspaceAssetServer {
  port: number
  url: string
  stop: () => Promise<void>
}

const COMMON_HEADERS = {
  'access-control-allow-origin': '*',
  'cache-control': 'no-store',
}

async function fileExists(filePath: string) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function decodeRepoRelativePath(urlPath: string) {
  const decoded = urlPath
    .split('/')
    .map((segment) => decodeURIComponent(segment))
    .join('/')
  const normalized = path.posix.normalize(decoded)

  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Path escapes the repository root.')
  }

  return normalized
}

export async function startWorkspaceAssetServer(cwd = process.cwd(), preferredPort = 3111) {
  const createServer = (port: number) =>
    Bun.serve({
      port,
      fetch(request) {
        const url = new URL(request.url)

        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return new Response('Method Not Allowed', {
            status: 405,
            headers: {
              ...COMMON_HEADERS,
              allow: 'GET, HEAD',
            },
          })
        }

        if (!url.pathname.startsWith('/repo/')) {
          return new Response('Not Found', {
            status: 404,
            headers: COMMON_HEADERS,
          })
        }

        let repoRelativePath: string

        try {
          repoRelativePath = decodeRepoRelativePath(url.pathname.slice('/repo/'.length))
        } catch (error) {
          return new Response(error instanceof Error ? error.message : 'Bad Request', {
            status: 400,
            headers: COMMON_HEADERS,
          })
        }

        const absolutePath = resolveRepoPath(repoRelativePath, cwd)

        return fileExists(absolutePath).then((exists) => {
          if (!exists) {
            return new Response('Not Found', {
              status: 404,
              headers: COMMON_HEADERS,
            })
          }

          return new Response(Bun.file(absolutePath), {
            headers: COMMON_HEADERS,
          })
        })
      },
    })

  let server: Bun.Server<undefined>

  try {
    server = createServer(preferredPort)
  } catch {
    server = createServer(0)
  }

  if (typeof server.port !== 'number') {
    throw new Error('Workspace asset server started without a bound port.')
  }

  return {
    port: server.port,
    url: server.url.toString().replace(/\/+$/, ''),
    async stop() {
      await server.stop(true)
    },
  } satisfies WorkspaceAssetServer
}
