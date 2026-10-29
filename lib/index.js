/**
 * Git 记忆插件 —— Host 半部。
 *
 * 把「用户自己的 git 仓库」当作 AI 长期记忆存储：首次调用时 clone 或 init，
 * 写入时落 Markdown 文件并重建索引，按 debounce 自动提交，`memory_sync` 时 pull --rebase + push。
 *
 * 纯逻辑在 ./memory.mjs（存储/检索/索引）与 ./git.mjs（git 调用），二者可独立单测；
 * 本文件只负责 DSH 接线：配置解析、懒初始化、工具注册、提交节流。
 *
 * 刻意**不 import 任何 @deepseek-ai 包**：工具定义用 JSON Schema 裸对象交给
 * `ctx.tools.register`，因此本包零运行时依赖，可以被 `link:` 或 npm 安装到任意 profile。
 *
 * @module @liuxinye/dsh-memory-git
 */

import { access, mkdir } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryError,
  listNotes,
  rebuildIndex,
  readNote,
  searchNotes,
  writeNote,
} from './memory.mjs'
import {
  configPath,
  readConfigFile,
  resolveSettings,
  sanitizeConfigPatch,
  writeConfigFile,
} from './config.mjs'
import { GitError, commitAll, ensureRepo, lastCommit, pullRebase, push, statusSummary } from './git.mjs'
import { localStamp } from './time.mjs'

/** 插件行名，Loader 与错误信息里显示。 */
export const name = 'tool-memory-git'

/** 依赖的 DSH 服务：工具注册表与系统提示。 */
export const inject = ['tools', 'systemPrompt']

/** 模型看到的固定引导，每次请求常驻。 */
const PROMPT_TEXT =
  'When the user asks you to remember something, or a stable preference / project fact changes, call memory_write (one fact per file). ' +
  'Before answering questions about the user past work or preferences, call memory_search over long-term memory. ' +
  'Call memory_sync after a batch of writes when the user wants the memory pushed to their git remote.'

/** 工具输出：纯字符串，UI 直接渲染。 */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

/**
 * 把一次工具失败渲染成模型可读的一行，而不是抛异常中断回合。
 *
 * @param {unknown} error - 捕获到的错误。
 * @returns {string} 一行诊断。
 */
function failure(error) {
  if (error instanceof MemoryError || error instanceof GitError) {
    return `✗ ${error.code}: ${error.message}`
  }
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  const path = typeof error === 'object' && error !== null && 'path' in error ? String(error.path) : ''
  if (code === 'EPERM' || code === 'EACCES') {
    return `✗ PERMISSION_DENIED: 路径不可写${path !== '' ? `（${path}）` : ''}；换一个可写目录，或检查权限`
  }
  if (code === 'ENOSPC') return '✗ NO_SPACE: 磁盘空间不足'
  if (code === 'ENOENT') return `✗ NOT_FOUND: 路径不存在${path !== '' ? `（${path}）` : ''}`
  const message = error instanceof Error ? error.message : String(error)
  return `✗ 未预期错误: ${message}`
}

/**
 * 必填字符串校验（裸 schema 注册时 registry 不做参数校验）。
 *
 * @param {unknown} value - 模型给的参数。
 * @param {string} field - 字段名。
 * @returns {string} 原值。
 */
function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MemoryError('INVALID_ARGS', `${field} 必须是非空字符串`)
  }
  return value
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const configFile = configPath()
  const fileState = readConfigFile(configFile)
  const resolved = resolveSettings(config, fileState.data)
  /** 可变配置：`memory_configure` 会在运行时就地更新。 */
  const settings = { ...resolved.settings }
  /** 每个字段的来源：patch（profile YAML）> file（配置文件）> default。 */
  const sources = { ...resolved.sources }

  /** 配置文件损坏时给出提示；正常返回空串。 */
  const configErrorNotes = () => (fileState.error === undefined ? '' : `⚠ 配置文件损坏: ${fileState.error}（已回退到默认值）`)

  /** 配置来源的紧凑摘要，例如 `dir=patch, repo=file, 其余=default`。 */
  const sourceSummary = () => {
    const bySource = { patch: [], file: [], default: [] }
    for (const [key, source] of Object.entries(sources)) bySource[source].push(key)
    const parts = []
    if (bySource.patch.length > 0) parts.push(`patch → ${bySource.patch.join(', ')}`)
    if (bySource.file.length > 0) parts.push(`配置文件 → ${bySource.file.join(', ')}`)
    if (bySource.default.length > 0) parts.push(`默认 → ${bySource.default.join(', ')}`)
    return parts.join(' · ')
  }

  /** 生效配置的逐行展示。 */
  const describeConfig = () => [
    `  存储目录: ${settings.dir}（${sources.dir}）`,
    `  仓库地址: ${settings.repo !== '' ? settings.repo : '未配置'}（${sources.repo}）`,
    `  分支: ${settings.branch}（${sources.branch}）`,
    `  自动推送: ${settings.autoPush ? '开' : '关'}（${sources.autoPush}）`,
    `  合并间隔: ${settings.commitIntervalMs}ms（${sources.commitIntervalMs}）`,
  ].join('\n')

  /**
   * 写配置前预检目录：能建且能写。避免一个打错的路径把配置写坏、之后每次调用都失败。
   *
   * @param {string} target - 目标目录（绝对路径）。
   * @returns {Promise<void>}
   */
  const preflightDir = async (target) => {
    await mkdir(target, { recursive: true })
    await access(target, fsConstants.W_OK)
  }

  /**
   * 把 `~` 或相对路径规范化成绝对路径；`~` 之外的非绝对路径直接拒绝。
   *
   * @param {string} value - 模型给的目录。
   * @returns {string} 绝对路径。
   */
  const normalizeDir = (value) => {
    const trimmed = value.trim()
    if (trimmed === '~') return homedir()
    if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2))
    if (!trimmed.startsWith('/')) {
      throw new MemoryError('INVALID_ARGS', `dir 必须是绝对路径或以 ~ 开头: ${value}`)
    }
    return trimmed
  }

  /** 懒初始化：首次工具调用时才 clone/init，失败后允许重试。 */
  let readyPromise = null
  /** 配置变更后调用：下次工具调用重新 clone/init。 */
  const resetRuntime = () => {
    readyPromise = null
  }
  const ready = () => {
    if (readyPromise === null) {
      readyPromise = ensureRepo({ dir: settings.dir, repo: settings.repo, branch: settings.branch })
        .catch((error) => {
          readyPromise = null
          throw error
        })
    }
    return readyPromise
  }

  /**
   * 提交用的 pathspec 固定为 `.`。
   *
   * 所有 git 调用都以 `-C <存储目录>` 执行，pathspec 因此相对**存储目录**解析：
   * 传仓库相对的 `记忆` 会被解析成 `记忆/记忆`，空匹配 → 永远"无变更"。
   * `.` 只覆盖存储目录子树，既不会误提交同仓库里的其他文件，也不会漏提交。
   */
  const PATHS = ['.']

  /** 合并提交的定时器；写入后重排，避免每条记忆一次 commit。 */
  let timer = null
  const cancelTimer = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  /**
   * 立即提交（并在允许时推送）。
   *
   * @param {string} [reason] - 提交信息后缀。
   * @param {{ forcePush?: boolean }} [options]
   * @returns {Promise<{ committed: boolean, pushed: boolean, detail: string }>}
   */
  const flush = async (reason, options = {}) => {
    cancelTimer()
    await ready()
    const stamp = localStamp()
    const commit = await commitAll(settings.dir, `memory: ${reason ?? 'auto'} @ ${stamp}`, {
      authorName: settings.authorName,
      authorEmail: settings.authorEmail,
      paths: PATHS,
    })
    if (!commit.committed) return { committed: false, pushed: false, detail: '无变更' }
    let pushed = false
    let detail = '未推送（autoPush 关闭）'
    if (options.forcePush === true || settings.autoPush) {
      const result = await push(settings.dir)
      pushed = result.pushed
      detail = describePush(result)
    }
    return { committed: true, pushed, detail }
  }

  /** 写入后安排一次合并提交。 */
  const scheduleFlush = () => {
    cancelTimer()
    timer = setTimeout(() => {
      timer = null
      flush('auto').catch(() => {
        /* 自动同步失败不打扰对话，memory_sync 会重试 */
      })
    }, Math.max(1000, settings.commitIntervalMs))
    if (typeof timer.unref === 'function') timer.unref()
  }

  if (typeof ctx.effect === 'function') ctx.effect(() => () => cancelTimer())

  ctx.systemPrompt.section({
    name: 'tool:memory-git',
    order: 2350,
    text: PROMPT_TEXT,
  })

  ctx.tools.register({
    name: 'memory_write',
    description:
      'Write one durable fact into the user long-term memory repository (Markdown, one fact per file). ' +
      'Use it when the user says to remember something, or when a stable preference, project state or decision changes. ' +
      'Do not use it for one-off tasks. Pass `path` to update an existing memory instead of creating a new file.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short human-readable title; used as the file name.' },
        content: { type: 'string', description: 'Markdown body of the memory. Keep it to a few lines.' },
        type: { type: 'string', description: 'Memory kind, e.g. preference | project | decision | fact | person.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
        path: { type: 'string', description: 'Existing memory path (e.g. notes/foo.md) to update in place.' },
      },
      required: ['title', 'content'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      try {
        const title = requiredString(args?.title, 'title')
        const content = requiredString(args?.content, 'content')
        await ready()
        const result = await writeNote(settings.dir, {
          title,
          content,
          type: typeof args?.type === 'string' && args.type !== '' ? args.type : 'fact',
          tags: Array.isArray(args?.tags) ? args.tags.filter((tag) => typeof tag === 'string') : [],
          path: typeof args?.path === 'string' && args.path !== '' ? args.path : undefined,
          source: 'dsh-memory-git',
        }, { maxNoteBytes: settings.maxNoteBytes })
        const index = await rebuildIndex(settings.dir)
        scheduleFlush()
        const verb = result.created ? '已创建' : '已更新'
        return `${verb} ${result.path}（索引共 ${index.count} 条）\n自动提交将在 ${Math.round(settings.commitIntervalMs / 1000)} 秒内合并；需要立刻同步远端请调用 memory_sync。`
      } catch (error) {
        return failure(error)
      }
    },
  })

  ctx.tools.register({
    name: 'memory_search',
    description:
      'Search long-term memory for durable facts about the user, their projects, decisions and preferences. ' +
      'Returns path, title, tags and a snippet; follow up with memory_read for full content.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive text to look for.' },
        limit: { type: 'integer', description: 'Max hits to return (default from config).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      try {
        const query = requiredString(args?.query, 'query')
        await ready()
        const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 100) : settings.searchLimit
        const hits = await searchNotes(settings.dir, query, { limit })
        if (hits.length === 0) return `没有命中「${query}」。存储目录: ${settings.dir}`
        const lines = [`命中 ${hits.length} 条记忆：`, '']
        for (const hit of hits) {
          const tags = hit.tags.length > 0 ? ` #${hit.tags.join(' #')}` : ''
          lines.push(`- ${hit.title} — \`${hit.path}\`（${hit.type}${tags}）`)
          if (hit.snippet !== '') lines.push(`  ${hit.snippet}`)
        }
        return lines.join('\n')
      } catch (error) {
        return failure(error)
      }
    },
  })

  ctx.tools.register({
    name: 'memory_read',
    description: 'Read one long-term memory file in full by its path (from memory_search results).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Memory path such as notes/preferred-editor.md.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      try {
        const path = requiredString(args?.path, 'path')
        await ready()
        const note = await readNote(settings.dir, path)
        const meta = Object.entries(note.meta)
          .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
          .join('\n')
        return `${note.path}\n---\n${meta}\n---\n\n${note.body}`
      } catch (error) {
        return failure(error)
      }
    },
  })

  ctx.tools.register({
    name: 'memory_sync',
    description:
      'Flush pending memory writes, pull with rebase, and push to the configured git remote. ' +
      'Use after a batch of memory writes, or when the user asks whether memory is backed up.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Optional commit message suffix.' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      try {
        await ready()
        const pull = await pullRebase(settings.dir)
        const reason = typeof args?.message === 'string' && args.message !== '' ? args.message : 'sync'
        const flushed = await flush(reason, { forcePush: true })
        const status = await statusSummary(settings.dir, { paths: ['.'] })
        return [
          `存储目录: ${settings.dir}`,
          `仓库: ${status.repo ? '已就绪' : '未初始化'} · 分支 ${status.branch}${status.remote !== '' ? ` · 远端 ${status.remote}` : ' · 无远端'}`,
          `拉取: ${describePull(pull)}`,
          `提交: ${flushed.committed ? '已提交' : '无变更'} · ${flushed.detail}`,
          status.dirty ? '注意: 记忆区仍有未提交变更' : '记忆区干净',
        ].join('\n')
      } catch (error) {
        return failure(error)
      }
    },
  })

  ctx.tools.register({
    name: 'memory_configure',
    description:
      'Configure the long-term memory repository at runtime: set repo (git URL), dir (local storage path), branch, autoPush. ' +
      'Writes $DSH_HOME/memory.config.json and takes effect on the next tool call — no restart needed. ' +
      'Fields already set by the profile cordis.patch.yml take precedence and cannot be overridden here. ' +
      'Call it with no arguments to print the current configuration.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Git repository URL to clone memory from and push to.' },
        dir: { type: 'string', description: 'Absolute local storage directory; a leading ~ is expanded.' },
        branch: { type: 'string', description: 'Branch name, e.g. main.' },
        autoPush: { type: 'boolean', description: 'Push after each automatic commit.' },
        commitIntervalMs: { type: 'integer', description: 'Debounce (ms) before merging writes into one commit.' },
        authorName: { type: 'string', description: 'Commit author name.' },
        authorEmail: { type: 'string', description: 'Commit author email.' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      try {
        const input = { ...(args ?? {}) }
        if (typeof input.dir === 'string' && input.dir.trim() !== '') input.dir = normalizeDir(input.dir)
        const { patch, rejected } = sanitizeConfigPatch(input)
        if (typeof patch.dir === 'string') {
          try {
            await preflightDir(patch.dir)
          } catch (error) {
            return `${failure(error)}\n目录未写入配置，当前配置保持不变。`
          }
        }
        const header = `配置文件: ${configFile}`
        if (Object.keys(patch).length === 0) {
          const notes = []
          if (rejected.length > 0) notes.push(`没有可用字段（被忽略: ${rejected.join(', ')}）`)
          return [header, configErrorNotes(), '当前生效配置：', describeConfig(), ...notes].join('\n')
        }
        const merged = writeConfigFile(configFile, patch)
        const next = resolveSettings(config, merged)
        Object.assign(settings, next.settings)
        Object.assign(sources, next.sources)
        resetRuntime()
        const lines = [header, `已写入: ${Object.keys(patch).join(', ')}`, '当前生效配置：', describeConfig()]
        const shadowed = Object.keys(patch).filter((key) => sources[key] === 'patch')
        if (shadowed.length > 0) {
          lines.push('', `注意: ${shadowed.join(', ')} 被 profile 的 cordis.patch.yml 覆盖，配置文件里改了不生效。`)
        }
        if (rejected.length > 0) lines.push('', `忽略的字段: ${rejected.join(', ')}`)
        lines.push('', '配置已即时生效（无需重启）。下一步：memory_status 确认状态，或直接写一条记忆。')
        return lines.join('\n')
      } catch (error) {
        return failure(error)
      }
    },
  })

  ctx.tools.register({
    name: 'memory_status',
    description:
      'Report the long-term memory setup: storage directory, repository/branch/remote, memory count, ' +
      'last commit, pending changes and sync state. Use it when the user asks where memory lives, ' +
      'whether it is backed up, or how to configure a git remote.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async () => {
      try {
        await ready()
        const notes = await listNotes(settings.dir)
        const status = await statusSummary(settings.dir, { paths: ['.'] })
        const last = await lastCommit(settings.dir, { paths: ['.'] })
        const lines = [
          `存储目录: ${settings.dir}`,
          `记忆条数: ${notes.length}`,
          `仓库: ${status.repo ? '已就绪' : '未初始化'} · 分支 ${status.branch}`,
          `远端: ${status.remote !== '' ? status.remote : '未配置（记忆只在本机，没有异地备份）'}`,
          `配置文件: ${configFile}`,
          `配置来源: ${sourceSummary()}`,
          `未提交变更: ${status.dirty ? '有' : '无'}${status.ahead !== '' && status.ahead !== '0' ? ` · 领先上游 ${status.ahead} 个提交` : ''}`,
          `最近提交: ${last !== null ? `${last.sha} ${last.subject}（${last.date}）` : '无'}`,
        ]
        if (status.remote === '') {
          lines.push(
            '',
            '要配远端/换存储目录，按侵入性从低到高：',
            '1. 对 AI 说「把记忆仓库设成 <地址>」→ 调 `memory_configure`，即时生效，不用重启',
            '2. 固化到 profile 的 cordis.patch.yml（优先级最高，需重启）',
            `3. 或手动 \`git -C ${settings.dir} remote add origin <地址>\`，然后 memory_sync`,
          )
        }
        if (notes.length === 0) {
          lines.push('', '还没有记忆：让 AI「记一下 XX」即可写入第一条。')
        }
        return lines.join('\n')
      } catch (error) {
        return failure(error)
      }
    },
  })
}

/** 拉取结果原因码 → 人话。 */
const PULL_ADVICE = Object.freeze({
  'no-remote': '未配置远端（记忆只在本机）',
  'no-upstream': '当前分支没有上游分支',
  conflict: '远端有冲突，已自动执行 `git rebase --abort` 回滚；请先手动 `git pull` 解决冲突',
  network: '网络不可达，检查网络或代理后重试',
  auth: '认证失败：检查 SSH key 或仓库权限',
  rejected: '远端有别人的新提交，先拉取再推送',
  timeout: '操作超时，稍后重试',
})

/** 推送结果原因码 → 人话。 */
const PUSH_ADVICE = Object.freeze({
  'no-remote': '未配置远端',
  network: '网络不可达，检查网络或代理',
  auth: '认证失败：检查 SSH key 或仓库权限',
  rejected: '远端有别人的新提交，先拉取再推送',
  timeout: '推送超时',
})

/**
 * 拉取结果的一行描述。
 *
 * @param {{ pulled: boolean, reason?: string, aborted?: boolean, detail?: string }} pull - pullRebase 结果。
 * @returns {string} 人类可读标签。
 */
function describePull(pull) {
  if (pull.pulled) return '已 rebase'
  const advice = PULL_ADVICE[pull.reason ?? ''] ?? `失败（${pull.reason ?? 'unknown'}${pull.detail !== undefined ? `: ${pull.detail}` : ''}）`
  return `跳过（${advice}${pull.aborted === true ? '，已回滚 rebase' : ''}）`
}

/**
 * 推送结果的一行描述。
 *
 * @param {{ pushed: boolean, reason?: string, detail?: string }} result - push 结果。
 * @returns {string} 人类可读标签。
 */
function describePush(result) {
  if (result.pushed) return '已推送'
  const advice = PUSH_ADVICE[result.reason ?? ''] ?? `未推送（${result.reason ?? 'unknown'}${result.detail !== undefined ? `: ${result.detail}` : ''}）`
  return advice
}
