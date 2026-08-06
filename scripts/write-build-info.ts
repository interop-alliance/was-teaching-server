/**
 * Stamps `dist/build-info.json` with the provenance of the build that produced
 * dist/: the package.json version, the git commit (suffixed `-dirty` when the
 * working tree has uncommitted changes), and the build time. Runs as the last
 * step of `pnpm build`; the stamp is what the startup stale-build check
 * (`assertFreshBuild`) and the `/health` probe report from.
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const rootDir = path.join(import.meta.dirname, '..')

/**
 * Returns the current git commit hash (with a `-dirty` suffix when the
 * working tree has uncommitted changes), or null when the build does not run
 * from a git checkout (e.g. an npm tarball).
 * @returns {string | null}
 */
function gitCommit(): string | null {
  try {
    const commit = execSync('git rev-parse HEAD', { cwd: rootDir })
      .toString()
      .trim()
    const dirty =
      execSync('git status --porcelain', { cwd: rootDir }).toString().trim() !==
      ''
    return dirty ? `${commit}-dirty` : commit
  } catch {
    return null
  }
}

const { version } = JSON.parse(
  fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')
) as { version: string }

const buildInfo = {
  version,
  commit: gitCommit(),
  builtAt: new Date().toISOString()
}
fs.writeFileSync(
  path.join(rootDir, 'dist', 'build-info.json'),
  JSON.stringify(buildInfo, null, 2) + '\n'
)
