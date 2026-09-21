/**
 * The blog directory facet (`/directory/blogs`): an opt-in list of public blog
 * documents hosted on this server, so a blog app can offer a "Discover" page.
 * No WAS server can answer "what public blogs do you host?" on its own -- the
 * protocol has no cross-Space listing -- so this is a small side service,
 * enabled with `WAS_BLOG_DIRECTORY=true` and absent (404) otherwise. It is not
 * part of the WAS protocol and lives outside the `fastifyWas` plugin.
 *
 * The directory holds nothing but blog URLs (plus when each was added):
 *
 * - `GET /directory/blogs` lists them, unauthenticated, paginated with
 *   `limit` / `cursor` and a `next` link like the WAS listings.
 * - `POST` / `DELETE /directory/blogs` with `{ blogUrl }` add or remove one.
 *   Both are capability invocations of the root capability for
 *   `/directory/blogs`, signed by the key the blog document publishes as its
 *   `signingKey`. So only the blog's own app can list or unlist it.
 *
 * Before accepting either write, the server reads the blog document the same
 * way an anonymous visitor would -- an in-process `GET` through the WAS
 * Resource route -- so "is this blog public?" is decided by the server's one
 * access-control path, not re-implemented here. A document that does not answer
 * that read, or is not shaped like a blog, is refused.
 *
 * Entries persist in one JSON file (by default `blog-directory.json` under the
 * data directory), rewritten atomically on every change and serialized through
 * a mutex. That is deliberately simple: a teaching-server directory stays
 * small, and it needs no backend support (so it works the same on Postgres).
 */
import { readFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type {
  FastifyInstance,
  FastifyPluginOptions,
  FastifyRequest
} from 'fastify'

import { handleError, InvalidRequestBodyError } from './errors.js'
import {
  parseAuthHeaders,
  requireAuthHeadersOrPublicRead
} from './auth-header-hooks.js'
import { captureRawBody, verifyBodyDigest } from './digest.js'
import { handleZcapVerify } from './zcap.js'
import { atomicWriteFile } from './lib/atomicFile.js'
import { KeyedMutex } from './lib/keyedMutex.js'
import { isValidController } from './lib/validateDid.js'
import {
  compareCodeUnits,
  nextPageUrl,
  parsePageParams,
  resolvePageSize,
  seekPage
} from './lib/pagination.js'
import type { IDID } from './types.js'

/** The directory's one URL path, the listing and the write target alike. */
export const BLOG_DIRECTORY_PATH = '/directory/blogs'

/** The request name used in error titles. */
const REQUEST_NAME = 'Blog Directory'

/**
 * A blog URL must address a Resource on this server: `/space/:spaceId/
 * :collectionId/:resourceId`, with no trailing slash, query, or fragment.
 */
const RESOURCE_PATH = /^\/space\/[^/]+\/[^/]+\/[^/]+$/

/** One listed blog. */
export interface BlogDirectoryEntry {
  blogUrl: string
  addedAt: string
}

/** The fields of a blog document this facet reads. */
interface BlogDocument {
  type?: unknown
  url?: unknown
  signingKey?: unknown
}

/** Options for {@link initBlogDirectoryRoutes}. */
export interface BlogDirectoryOptions extends FastifyPluginOptions {
  /** The JSON file the entries persist in; created on the first write. */
  file: string
}

/**
 * The entries file as stored on disk, keyed by blog URL so a re-add is a
 * no-op and a remove is a single delete.
 */
type EntriesFile = Record<string, { addedAt: string }>

/**
 * Registers the blog directory routes. Each registration owns its own entries
 * file and mutex, so parallel test servers stay isolated.
 *
 * @param app {import('fastify').FastifyInstance}
 * @param options {BlogDirectoryOptions}
 * @returns {Promise<void>}
 */
export async function initBlogDirectoryRoutes(
  app: FastifyInstance,
  options: BlogDirectoryOptions
): Promise<void> {
  const { file } = options
  const mutex = new KeyedMutex()

  app.setErrorHandler(handleError)
  // The same auth and digest chain the WAS route groups install: the GET is
  // public, a write must carry a signature, and a signed body must match its
  // `Digest`.
  app.addHook('onRequest', requireAuthHeadersOrPublicRead)
  app.addHook('onRequest', parseAuthHeaders)
  app.addHook('preParsing', captureRawBody)
  app.addHook('preValidation', verifyBodyDigest)

  /**
   * Reads the stored entries; a missing file is an empty directory.
   * @returns {Promise<EntriesFile>}
   */
  async function readEntries(): Promise<EntriesFile> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as EntriesFile
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {}
      }
      throw err
    }
  }

  /**
   * Applies `change` to the stored entries under the mutex, writing the file
   * back only when `change` reports it changed something.
   * @param change {(entries: EntriesFile) => boolean}
   * @returns {Promise<void>}
   */
  async function updateEntries(
    change: (entries: EntriesFile) => boolean
  ): Promise<void> {
    await mutex.run(file, async () => {
      const entries = await readEntries()
      if (!change(entries)) {
        return
      }
      await mkdir(path.dirname(file), { recursive: true })
      await atomicWriteFile({
        filePath: file,
        data: JSON.stringify(entries, null, 2)
      })
    })
  }

  /**
   * Reads the request body's `blogUrl` and checks that it addresses a Resource
   * on this server.
   * @param request {import('fastify').FastifyRequest}
   * @returns {string}
   */
  function blogUrlOf(request: FastifyRequest): string {
    const blogUrl = (request.body as { blogUrl?: unknown } | undefined)?.blogUrl
    if (typeof blogUrl !== 'string') {
      throw new InvalidRequestBodyError({
        requestName: REQUEST_NAME,
        detail: 'The body must be a JSON object with a string "blogUrl".',
        pointer: '#/blogUrl'
      })
    }
    let parsed: URL
    try {
      parsed = new URL(blogUrl)
    } catch {
      parsed = new URL('invalid:')
    }
    if (
      parsed.origin !== new URL(request.server.serverUrl).origin ||
      !RESOURCE_PATH.test(parsed.pathname) ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      parsed.href !== blogUrl
    ) {
      throw new InvalidRequestBodyError({
        requestName: REQUEST_NAME,
        detail: '"blogUrl" must be the URL of a Resource on this server.',
        pointer: '#/blogUrl'
      })
    }
    return blogUrl
  }

  /**
   * Reads the blog document exactly as an anonymous visitor would, through
   * this server's own Resource route, and returns the `signingKey` it
   * publishes. Refuses a URL that does not answer publicly with a blog
   * document naming itself and a `did:key` signing key.
   * @param blogUrl {string}
   * @returns {Promise<IDID>}
   */
  async function publicSigningKey(blogUrl: string): Promise<IDID> {
    const response = await app.inject({
      method: 'GET',
      url: new URL(blogUrl).pathname
    })
    let blog: BlogDocument | undefined
    if (response.statusCode === 200) {
      try {
        blog = response.json<BlogDocument>()
      } catch {
        blog = undefined
      }
    }
    if (!blog) {
      throw new InvalidRequestBodyError({
        requestName: REQUEST_NAME,
        detail: '"blogUrl" does not answer a public read with a JSON document.',
        pointer: '#/blogUrl'
      })
    }
    if (
      blog.type !== 'Blog' ||
      blog.url !== blogUrl ||
      !isValidController(blog.signingKey)
    ) {
      throw new InvalidRequestBodyError({
        requestName: REQUEST_NAME,
        detail:
          'The document at "blogUrl" is not a blog: it needs "type": "Blog", ' +
          'its own URL as "url", and a did:key "signingKey".',
        pointer: '#/blogUrl'
      })
    }
    return blog.signingKey
  }

  /**
   * Verifies a write: a root invocation of the directory URL, signed by the
   * blog's own `signingKey`. Returns the blog URL it is about.
   * @param request {import('fastify').FastifyRequest}
   * @returns {Promise<string>}
   */
  async function authorizeWrite(request: FastifyRequest): Promise<string> {
    const blogUrl = blogUrlOf(request)
    const signingKey = await publicSigningKey(blogUrl)
    const { serverUrl } = request.server
    await handleZcapVerify({
      url: request.url,
      allowedTarget: `${serverUrl}${BLOG_DIRECTORY_PATH}`,
      allowedAction: request.method,
      method: request.method,
      headers: request.headers,
      serverUrl,
      spaceController: signingKey,
      requestName: REQUEST_NAME,
      logger: request.log,
      // The root capability belongs to the blog's key, not to a Space or a
      // keystore, so there is no scope a revocation could be stored under.
      revocation: 'no-revocation-scope'
    })
    return blogUrl
  }

  app.get<{ Querystring: Record<string, string | string[] | undefined> }>(
    BLOG_DIRECTORY_PATH,
    async (request, reply) => {
      const { limit, cursor } = parsePageParams({ query: request.query })
      const pageSize = resolvePageSize(limit)
      const items: BlogDirectoryEntry[] = Object.entries(await readEntries())
        .map(([blogUrl, { addedAt }]) => ({ blogUrl, addedAt }))
        .sort((left, right) => compareCodeUnits(left.blogUrl, right.blogUrl))
      const { page, hasMore } = seekPage({
        items,
        cursor,
        pageSize,
        keyOf: item => item.blogUrl
      })
      return reply.send({
        items: page,
        ...(hasMore && {
          next: nextPageUrl({
            path: BLOG_DIRECTORY_PATH,
            ...(limit !== undefined && { limit: pageSize }),
            after: page[page.length - 1]!.blogUrl
          })
        })
      })
    }
  )

  app.post(BLOG_DIRECTORY_PATH, async (request: FastifyRequest, reply) => {
    const blogUrl = await authorizeWrite(request)
    const addedAt = new Date().toISOString()
    await updateEntries(entries => {
      if (entries[blogUrl]) {
        return false
      }
      entries[blogUrl] = { addedAt }
      return true
    })
    return reply.header('cache-control', 'no-store').code(204).send()
  })

  app.delete(BLOG_DIRECTORY_PATH, async (request: FastifyRequest, reply) => {
    const blogUrl = await authorizeWrite(request)
    await updateEntries(entries => {
      if (!entries[blogUrl]) {
        return false
      }
      delete entries[blogUrl]
      return true
    })
    return reply.code(204).send()
  })
}
