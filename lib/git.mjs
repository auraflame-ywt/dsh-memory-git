/**
 * Git 同步引擎 —— 纯 Node，不依赖 DSH 运行时，可独立单测。
 *
 * 所有调用都用 `execFile('git', argv)`（绝不拼 shell 字符串），并强制：
 * - 关闭终端凭证提示（GIT_TERMINAL_PROMPT=0），网络失败要报错而不是挂住
 * - 单次调用有超时与输出上限
 * - 提交作者显式传入，避免依赖全局 git 配置
 *
 * @module @liuxinye/dsh-memory-git/git
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { join, relative as relativePath, sep } from 'node:path'

const execFileAsync = promisify(execFile)

/** 带稳定错误码的 git 失败。 */
export class GitError extends Error {
  /**
   * @param {string} code - 稳定错误码。
   * @param {string} message - 人类可读诊断。
   */
  constructor(code, message) {
    super(message)
    this.name = 'GitError'
    this.code = code
  }
}

/** 单次 git 调用的默认边界。 */
export const LIMITS = Object.freeze({ timeoutMs: 30000, maxBytes: 8 * 1024 * 1024 })

const GIT_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_ASKPASS: 'true',
  PAGER: 'cat',
  LC_ALL: 'C',
})

/**
 * 执行一条 git 命令。非零退出默认不抛错，由调用方判断。
 *
 * @param {string} root - 工作目录。
 * @param {readonly string[]} args - 参数。
 * @param {{ timeoutMs?: number, maxBytes?: number, allowFailure?: boolean, env?: Record<string, string> }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string, timedOut: boolean }>}
 */
export async function git(root, args, options = {}) {
  const timeout = options.timeoutMs ?? LIMITS.timeoutMs
  const maxBuffer = options.maxBytes ?? LIMITS.maxBytes
  try {
    const result = await execFileAsync('git', ['-C', root, ...args], {
      env: { ...process.env, ...GIT_ENV, ...(options.env ?? {}) },
      timeout,
      maxBuffer,
      windowsHide: true,
    })
    return { code: 0, stdout: result.stdout, stderr: result.stderr, timedOut: false }
  } catch (error) {
    const code = typeof error.code === 'number' ? error.code : -1
    const timedOut = error.killed === true || error.signal === 'SIGTERM'
    const stdout = typeof error.stdout === 'string' ? error.stdout : ''
    const stderr = typeof error.stderr === 'string' ? error.stderr : String(error.message ?? '')
    const result = { code, stdout, stderr, timedOut }
    if (options.allowFailure === true) return result
    throw new GitError(
      timedOut ? 'GIT_TIMEOUT' : 'GIT_FAILED',
      `git ${args.join(' ')} 失败（code=${code}）: ${stderr.trim().split('\n').slice(-3).join(' | ')}`,
    )
  }
}

/**
 * 目录是否为空（用于决定能否直接 clone 进去）。
 *
 * @param {string} dir - 目录。
 * @returns {Promise<boolean>}
 */
async function isEmptyDir(dir) {
  try {
    const entries = await readdir(dir)
    return entries.filter((name) => name !== '.DS_Store').length === 0
  } catch {
    return false
  }
}

/**
 * 目录是否是 git 仓库。
 *
 * @param {string} dir - 目录。
 * @returns {Promise<boolean>}
 */
export async function isRepo(dir) {
  const result = await git(dir, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true })
  return result.code === 0 && result.stdout.trim() === 'true'
}

/**
 * 准备存储仓库：有 `repo` 就 clone（另建目录），否则本地 init。
 *
 * @param {{ dir: string, repo?: string, branch?: string }} options
 * @returns {Promise<{ mode: 'existing' | 'cloned' | 'initialized', branch: string }>}
 */
export async function ensureRepo(options) {
  const dir = options.dir
  await mkdir(dir, { recursive: true })
  const empty = await isEmptyDir(dir)
  if (await isRepo(dir)) {
    return { mode: 'existing', branch: await currentBranch(dir) }
  }
  if (typeof options.repo === 'string' && options.repo.trim() !== '') {
    if (!empty) throw new GitError('DIR_NOT_EMPTY', `目录非空且不是 git 仓库，拒绝 clone: ${dir}`)
    const args = ['clone']
    if (typeof options.branch === 'string' && options.branch.trim() !== '') args.push('--branch', options.branch)
    args.push('--', options.repo, dir)
    const result = await git(join(dir, '..'), args, { timeoutMs: 120000 })
    if (result.code !== 0) throw new GitError('CLONE_FAILED', `clone 失败: ${result.stderr.trim()}`)
    return { mode: 'cloned', branch: await currentBranch(dir) }
  }
  const init = await git(dir, ['init', '--initial-branch', 'main'], { allowFailure: true })
  if (init.code !== 0) await git(dir, ['init'])
  if (typeof options.branch === 'string' && options.branch.trim() !== '' && options.branch !== 'main') {
    await git(dir, ['checkout', '-b', options.branch], { allowFailure: true })
  }
  return { mode: 'initialized', branch: await currentBranch(dir) }
}

/**
 * 当前分支名（detached 时返回 HEAD）。
 *
 * @param {string} dir - 仓库目录。
 * @returns {Promise<string>}
 */
export async function currentBranch(dir) {
  // 全新仓库还没有提交时 `rev-parse --abbrev-ref HEAD` 会失败，
  // 先问 symbolic-ref（它只看 HEAD 指向，不需要提交存在）。
  const symbolic = await git(dir, ['symbolic-ref', '--short', 'HEAD'], { allowFailure: true })
  if (symbolic.code === 0 && symbolic.stdout.trim() !== '') return symbolic.stdout.trim()
  const result = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true })
  return result.code === 0 ? result.stdout.trim() : 'HEAD'
}

/**
 * 工作区是否有未提交变更（可限定 pathspec）。
 *
 * @param {string} dir - 仓库目录。
 * @param {readonly string[]} [paths] - 只看这些路径；省略表示整个工作区。
 * @returns {Promise<boolean>}
 */
export async function hasChanges(dir, paths) {
  const args = ['status', '--porcelain']
  if (Array.isArray(paths) && paths.length > 0) args.push('--', ...paths)
  const result = await git(dir, args, { allowFailure: true })
  return result.code === 0 && result.stdout.trim() !== ''
}

/**
 * 提交变更。给了 `paths` 时**只提交这些路径**（pathspec 形式等价 --only），
 * 不会把仓库里其他无关改动一起提交 —— 记忆目录嵌在用户既有仓库里时这是安全边界。
 *
 * @param {string} dir - 仓库目录。
 * @param {string} message - 提交信息。
 * @param {{ authorName?: string, authorEmail?: string, paths?: readonly string[] }} [options]
 * @returns {Promise<{ committed: boolean, sha?: string }>}
 */
export async function commitAll(dir, message, options = {}) {
  const paths = Array.isArray(options.paths) && options.paths.length > 0 ? options.paths : undefined
  if (!(await hasChanges(dir, paths))) return { committed: false }
  if (paths === undefined) {
    await git(dir, ['add', '--all'])
  } else {
    await git(dir, ['add', '--', ...paths])
  }
  const authorName = options.authorName ?? 'DSH Memory'
  const authorEmail = options.authorEmail ?? 'dsh-memory@localhost'
  const commitArgs = [
    '-c', `user.name=${authorName}`,
    '-c', `user.email=${authorEmail}`,
    'commit', '--no-verify', '-m', message,
  ]
  if (paths !== undefined) commitArgs.push('--', ...paths)
  await git(dir, commitArgs, { allowFailure: false })
  const sha = await git(dir, ['rev-parse', 'HEAD'], { allowFailure: true })
  return { committed: true, sha: sha.code === 0 ? sha.stdout.trim() : undefined }
}

/**
 * 把 git 失败归类成稳定原因码，供上层翻译成人话。
 *
 * @param {string} stderr - git 的 stderr。
 * @param {boolean} [timedOut] - 是否因超时被杀。
 * @returns {'conflict' | 'network' | 'auth' | 'rejected' | 'timeout' | 'unknown'} 原因码。
 */
export function classifyFailure(stderr, timedOut = false) {
  if (timedOut) return 'timeout'
  const text = String(stderr ?? '')
  if (/CONFLICT|could not apply|Automatic merge failed|Resolve all conflicts/i.test(text)) return 'conflict'
  if (/Could not resolve host|Connection timed out|Operation timed out|Network is unreachable|early EOF|RPC failed/i.test(text)) return 'network'
  if (/Permission denied|Authentication failed|publickey|access denied|fatal: could not read Username/i.test(text)) return 'auth'
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(text)) return 'rejected'
  return 'unknown'
}

/**
 * rebase 是否停在中间状态（冲突未解决）。
 *
 * @param {string} dir - 仓库目录。
 * @returns {Promise<boolean>}
 */
export async function isRebaseInProgress(dir) {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const path = await git(dir, ['rev-parse', '--git-path', name], { allowFailure: true })
    if (path.code !== 0) continue
    const absolute = path.stdout.trim()
    if (absolute === '') continue
    try {
      await stat(absolute.startsWith('/') ? absolute : join(dir, absolute))
      return true
    } catch {
      /* 目录不存在，继续看下一个 */
    }
  }
  return false
}

/**
 * 拉取远端并 rebase（无远端时静默跳过）。
 *
 * 遇到 rebase 冲突会**自动 abort** 并返回 `reason: 'conflict'`：
 * 记忆同步是后台动作，把仓库留在半冲突状态会拖累用户下一次普通操作。
 *
 * @param {string} dir - 仓库目录。
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ pulled: boolean, reason?: string, detail?: string, aborted?: boolean }>}
 */
export async function pullRebase(dir, options = {}) {
  const remote = await git(dir, ['remote'], { allowFailure: true })
  if (remote.code !== 0 || remote.stdout.trim() === '') return { pulled: false, reason: 'no-remote' }
  const result = await git(dir, ['pull', '--rebase', '--autostash'], {
    allowFailure: true,
    timeoutMs: options.timeoutMs ?? 120000,
  })
  if (result.code === 0) return { pulled: true }

  if (await isRebaseInProgress(dir)) {
    const abort = await git(dir, ['rebase', '--abort'], { allowFailure: true })
    return {
      pulled: false,
      reason: 'conflict',
      detail: result.stderr.trim().split('\n').slice(-3).join(' | '),
      aborted: abort.code === 0,
    }
  }
  return {
    pulled: false,
    reason: classifyFailure(result.stderr, result.timedOut),
    detail: result.stderr.trim().split('\n').slice(-3).join(' | '),
  }
}

/**
 * 推送当前分支（无远端时静默跳过）。
 *
 * @param {string} dir - 仓库目录。
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ pushed: boolean, reason?: string }>}
 */
export async function push(dir, options = {}) {
  const remote = await git(dir, ['remote'], { allowFailure: true })
  if (remote.code !== 0 || remote.stdout.trim() === '') return { pushed: false, reason: 'no-remote' }
  const upstream = await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFailure: true })
  const args = upstream.code === 0 ? ['push'] : ['push', '--set-upstream', 'origin', 'HEAD']
  const result = await git(dir, args, { allowFailure: true, timeoutMs: options.timeoutMs ?? 120000 })
  if (result.code === 0) return { pushed: true }
  return {
    pushed: false,
    reason: classifyFailure(result.stderr, result.timedOut),
    detail: result.stderr.trim().split('\n').slice(-3).join(' | '),
  }
}

/**
 * 仓库状态快照，用于 memory_sync 的回报。
 *
 * @param {string} dir - 仓库目录。
 * @param {{ paths?: readonly string[] }} [options] - 脏状态只看这些路径（存储目录嵌在大仓库里时用 `.`）。
 * @returns {Promise<{ repo: boolean, branch: string, dirty: boolean, remote: string, ahead: string }>}
 */
export async function statusSummary(dir, options = {}) {
  if (!(await isRepo(dir))) return { repo: false, branch: '-', dirty: false, remote: '', ahead: '' }
  const paths = Array.isArray(options.paths) && options.paths.length > 0 ? options.paths : undefined
  const remote = await git(dir, ['remote', 'get-url', 'origin'], { allowFailure: true })
  const ahead = await git(dir, ['rev-list', '--count', '@{u}..HEAD'], { allowFailure: true })
  return {
    repo: true,
    branch: await currentBranch(dir),
    dirty: await hasChanges(dir, paths),
    remote: remote.code === 0 ? remote.stdout.trim() : '',
    ahead: ahead.code === 0 ? ahead.stdout.trim() : '',
  }
}

/**
 * 最近一次提交的摘要，用于 memory_status。
 *
 * @param {string} dir - 仓库目录。
 * @param {{ paths?: readonly string[] }} [options] - 只看这些路径的提交。
 * @returns {Promise<{ sha: string, subject: string, date: string } | null>} 无提交时返回 null。
 */
export async function lastCommit(dir, options = {}) {
  const paths = Array.isArray(options.paths) && options.paths.length > 0 ? options.paths : undefined
  const args = ['log', '-1', '--format=%h%x00%s%x00%ci']
  if (paths !== undefined) args.push('--', ...paths)
  const result = await git(dir, args, { allowFailure: true })
  if (result.code !== 0 || result.stdout.trim() === '') return null
  const [sha, subject, date] = result.stdout.trim().split('\u0000')
  if (sha === undefined || subject === undefined) return null
  return { sha, subject, date: date ?? '' }
}

/**
 * 目录内 `.git` 是否存在（不调用 git，快速判断）。
 *
 * @param {string} dir - 目录。
 * @returns {Promise<boolean>}
 */
export async function hasGitDir(dir) {
  try {
    const info = await stat(join(dir, '.git'))
    return info.isDirectory() || info.isFile()
  } catch {
    return false
  }
}

/**
 * 把存储目录换算成相对仓库根的 pathspec；存储目录就是仓库根时返回 `.`。
 *
 * @param {string} dir - 仓库内任意目录（或仓库根）。
 * @param {string} storeDir - 存储目录（绝对路径）。
 * @returns {Promise<string>} 相对仓库根的路径。
 */
export async function repoRelativePath(dir, storeDir) {
  const top = await git(dir, ['rev-parse', '--show-toplevel'], { allowFailure: true })
  if (top.code !== 0) return '.'
  // git 给的是真实路径（macOS 上 /var → /private/var），存储目录也要 realpath 后才能比。
  let realStore = storeDir
  try {
    realStore = await realpath(storeDir)
  } catch {
    // 目录尚不存在：拿仓库目录的 realpath 拼出等价路径（macOS 上 /var 是符号链接）。
    try {
      realStore = join(await realpath(dir), relativePath(dir, storeDir))
    } catch {
      /* 连仓库目录都解析不了时按原样比较 */
    }
  }
  const rel = relativePath(top.stdout.trim(), realStore).split(sep).join('/')
  if (rel === '' || rel.startsWith('..')) return '.'
  return rel
}
