import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  GitError,
  classifyFailure,
  commitAll,
  currentBranch,
  ensureRepo,
  git,
  hasChanges,
  isRebaseInProgress,
  isRepo,
  lastCommit,
  pullRebase,
  push,
  repoRelativePath,
  statusSummary,
} from '../lib/git.mjs'

/** @type {string} */
let root

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-git-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('ensureRepo', () => {
  it('无 repo 时本地 init 到指定分支', async () => {
    const dir = join(root, 'store')
    const result = await ensureRepo({ dir, branch: 'main' })
    assert.equal(result.mode, 'initialized')
    assert.equal(result.branch, 'main')
    assert.equal(await isRepo(dir), true)
  })

  it('重复调用识别为已有仓库', async () => {
    const dir = join(root, 'store')
    await ensureRepo({ dir })
    const again = await ensureRepo({ dir })
    assert.equal(again.mode, 'existing')
  })

  it('给了 repo 就 clone 进来', async () => {
    const origin = join(root, 'origin')
    await ensureRepo({ dir: origin })
    await writeFile(join(origin, 'index.md'), '# 索引\n')
    await commitAll(origin, 'init')

    const dir = join(root, 'clone')
    const result = await ensureRepo({ dir, repo: origin, branch: 'main' })
    assert.equal(result.mode, 'cloned')
    assert.equal(await isRepo(dir), true)
  })

  it('目录非空且不是仓库时拒绝 clone', async () => {
    const dir = join(root, 'dirty')
    await ensureRepo({ dir: join(root, 'tmp') }) // 保证 tmp 目录存在
    await writeFile(join(root, 'dirty-file'), 'x')
    await assert.rejects(
      (async () => {
        const { mkdir } = await import('node:fs/promises')
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'junk.txt'), 'x')
        return ensureRepo({ dir, repo: 'https://example.invalid/x.git' })
      })(),
      (error) => error instanceof GitError && error.code === 'DIR_NOT_EMPTY',
    )
  })
})

describe('commitAll', () => {
  it('有变更时提交并返回 sha，没变更时返回 false', async () => {
    const dir = join(root, 'repo')
    await ensureRepo({ dir })
    await writeFile(join(dir, 'a.md'), '# a\n')

    const first = await commitAll(dir, 'memory: first')
    assert.equal(first.committed, true)
    assert.match(first.sha ?? '', /^[0-9a-f]{7,40}$/)

    const second = await commitAll(dir, 'memory: noop')
    assert.equal(second.committed, false)
  })

  it('提交作者按参数写入，不依赖全局 git 配置', async () => {
    const dir = join(root, 'repo')
    await ensureRepo({ dir })
    await writeFile(join(dir, 'b.md'), '# b\n')
    await commitAll(dir, 'memory: author', { authorName: 'DSH Memory', authorEmail: 'dsh-memory@localhost' })
    const log = await git(dir, ['log', '-1', '--format=%an <%ae>'])
    assert.equal(log.stdout.trim(), 'DSH Memory <dsh-memory@localhost>')
  })
})

describe('path-scoped commit', () => {
  it('给定 paths 时不动仓库里的其他改动', async () => {
    const dir = join(root, 'repo')
    await ensureRepo({ dir })
    await writeFile(join(dir, 'unrelated.md'), '# 别人的改动\n')

    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'memory', 'notes'), { recursive: true })
    await writeFile(join(dir, 'memory', 'notes', 'a.md'), '# 记忆\n')

    const result = await commitAll(dir, 'memory: scoped', { paths: ['memory'] })
    assert.equal(result.committed, true)

    const committed = await git(dir, ['show', '--name-only', '--format=', 'HEAD'])
    assert.match(committed.stdout, /memory\/notes\/a\.md/)
    assert.doesNotMatch(committed.stdout, /unrelated\.md/)
    // 无关改动仍是未跟踪状态
    const status = await git(dir, ['status', '--porcelain'])
    assert.match(status.stdout, /\?\? unrelated\.md/)
  })

  it('repoRelativePath 把存储目录换成 pathspec', async () => {
    const dir = join(root, 'repo')
    await ensureRepo({ dir })
    assert.equal(await repoRelativePath(dir, dir), '.')
    assert.equal(await repoRelativePath(dir, join(dir, 'memory')), 'memory')
  })
})

describe('subdirectory commit', () => {
  it('在子目录里用 paths ["."] 能提交到（回归：仓库相对 pathspec 会空匹配）', async () => {
    const dir = join(root, 'repo')
    await ensureRepo({ dir })
    const sub = join(dir, '记忆')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(sub, 'notes'), { recursive: true })
    await writeFile(join(sub, 'notes', 'a.md'), '# 记忆\n')
    await writeFile(join(dir, 'outside.md'), '# 不该被提交\n')

    const result = await commitAll(sub, 'memory: subdir', { paths: ['.'] })
    assert.equal(result.committed, true)

    // core.quotepath=false：否则 git 会把中文路径转义成 \3xx\3xx
    const files = await git(dir, ['-c', 'core.quotepath=false', 'show', '--name-only', '--format=', 'HEAD'])
    assert.match(files.stdout, /记忆\/notes\/a\.md/)
    assert.doesNotMatch(files.stdout, /outside\.md/)
  })
})

describe('classifyFailure', () => {
  it('识别冲突、网络、鉴权、超时、被拒', () => {
    assert.equal(classifyFailure('CONFLICT (content): Merge conflict in notes/a.md'), 'conflict')
    assert.equal(classifyFailure('error: could not apply 1a2b3c4'), 'conflict')
    assert.equal(classifyFailure('ssh: Could not resolve hostname gitee.com'), 'network')
    assert.equal(classifyFailure('fatal: Connection timed out'), 'network')
    assert.equal(classifyFailure('Permission denied (publickey)'), 'auth')
    assert.equal(classifyFailure('! [rejected] master -> master (non-fast-forward)'), 'rejected')
    assert.equal(classifyFailure('anything', true), 'timeout')
    assert.equal(classifyFailure('something odd'), 'unknown')
  })
})

describe('lastCommit', () => {
  it('返回 sha、标题与本地时间', async () => {
    const dir = join(root, 'repo')
    await ensureRepo({ dir })
    await writeFile(join(dir, 'a.md'), '# a\n')
    await commitAll(dir, 'memory: first')
    const last = await lastCommit(dir)
    assert.ok(last !== null)
    assert.match(last.sha, /^[0-9a-f]{7,40}$/)
    assert.equal(last.subject, 'memory: first')
    assert.match(last.date, /^\d{4}-\d{2}-\d{2} /)
  })

  it('空仓库返回 null', async () => {
    const dir = join(root, 'empty')
    await ensureRepo({ dir })
    assert.equal(await lastCommit(dir), null)
  })
})

describe('scoped status', () => {
  it('paths ["."] 只统计子目录脏状态，忽略仓库其他改动', async () => {
    const dir = join(root, 'repo')
    await ensureRepo({ dir })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, '记忆'), { recursive: true })
    await writeFile(join(dir, '记忆', 'a.md'), '# a\n')
    await commitAll(dir, 'memory: a', { paths: ['.'] })

    // 仓库别处有改动，但记忆目录干净
    await writeFile(join(dir, 'outside.md'), '# dirty\n')
    const scoped = await statusSummary(join(dir, '记忆'), { paths: ['.'] })
    assert.equal(scoped.dirty, false)
    const whole = await statusSummary(dir)
    assert.equal(whole.dirty, true)
  })

  it('lastCommit 只看子目录的提交', async () => {
    const dir = join(root, 'repo')
    await ensureRepo({ dir })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, '记忆'), { recursive: true })
    await writeFile(join(dir, '记忆', 'a.md'), '# a\n')
    await commitAll(dir, 'memory: first', { paths: ['.'] })

    await writeFile(join(dir, 'outside.md'), '# x\n')
    await commitAll(dir, 'unrelated: second')

    const scoped = await lastCommit(join(dir, '记忆'), { paths: ['.'] })
    assert.equal(scoped.subject, 'memory: first')
    const whole = await lastCommit(dir)
    assert.equal(whole.subject, 'unrelated: second')
  })
})

describe('pull rebase conflict', () => {
  it('冲突时自动 abort，返回 conflict 且仓库不停在 rebase 中间态', async () => {
    // 建一个"远端"仓库并 clone 两份
    const origin = join(root, 'origin')
    await ensureRepo({ dir: origin })
    await writeFile(join(origin, 'notes.md'), 'base\n')
    await commitAll(origin, 'base')
    // 允许向这个非裸仓库的当前分支 push（默认会被 refuse）
    await git(origin, ['config', 'receive.denyCurrentBranch', 'ignore'])

    const cloneA = join(root, 'clone-a')
    const cloneB = join(root, 'clone-b')
    await git(root, ['clone', origin, cloneA])
    await git(root, ['clone', origin, cloneB])

    // A 先改并推回
    await writeFile(join(cloneA, 'notes.md'), 'from A\n')
    await commitAll(cloneA, 'A change')
    const pushed = await git(cloneA, ['push', 'origin', 'main'], { allowFailure: true })
    assert.equal(pushed.code, 0, pushed.stderr)

    // B 改同一行，再 pull → 必然冲突
    await writeFile(join(cloneB, 'notes.md'), 'from B\n')
    await commitAll(cloneB, 'B change')

    const result = await pullRebase(cloneB)
    assert.equal(result.pulled, false)
    assert.equal(result.reason, 'conflict')
    assert.equal(result.aborted, true)
    assert.equal(await isRebaseInProgress(cloneB), false)
  })
})

describe('no-remote behaviour', () => {
  it('无远端时 pull/push 静默跳过而不是报错', async () => {
    const dir = join(root, 'repo')
    await ensureRepo({ dir })
    await writeFile(join(dir, 'c.md'), '# c\n')
    await commitAll(dir, 'memory: c')
    assert.deepEqual(await pullRebase(dir), { pulled: false, reason: 'no-remote' })
    assert.deepEqual(await push(dir), { pushed: false, reason: 'no-remote' })
  })
})

describe('statusSummary', () => {
  it('报告仓库、分支、脏状态与远端', async () => {
    const dir = join(root, 'repo')
    await ensureRepo({ dir })
    let status = await statusSummary(dir)
    assert.equal(status.repo, true)
    assert.equal(status.branch, 'main')
    assert.equal(status.dirty, false)
    assert.equal(status.remote, '')

    await writeFile(join(dir, 'd.md'), '# d\n')
    status = await statusSummary(dir)
    assert.equal(status.dirty, true)
    assert.equal(await hasChanges(dir), true)
  })

  it('非仓库目录报告 repo=false', async () => {
    const status = await statusSummary(join(root, 'plain'))
    assert.equal(status.repo, false)
  })
})

describe('isRepo / currentBranch', () => {
  it('普通目录不是仓库', async () => {
    assert.equal(await isRepo(root), false)
  })

  it('init 后分支名为 main', async () => {
    const dir = join(root, 'repo')
    await ensureRepo({ dir })
    assert.equal(await currentBranch(dir), 'main')
  })
})
