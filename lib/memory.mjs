/**
 * 记忆存储核心 —— 纯 Node，不依赖 DSH 运行时，可独立单测。
 *
 * 设计取舍：
 * - 一篇一事实的独立 Markdown 文件 → git 冲突退化成「不同文件」，几乎不冲突；
 *   同时人可读、可被 Obsidian 直接打开。
 * - 检索用「索引文件 + 子串扫描」，不引入 embedding：零依赖、零 API、离线可用。
 * - 所有路径都过 `safeJoin`，拒绝 `..` 与绝对路径，防止模型写出存储目录。
 *
 * @module @liuxinye/dsh-memory-git/memory
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { localDate, localStamp } from './time.mjs'

/** 记忆文件的子目录（与索引分开，避免误扫）。 */
export const NOTES_DIR = 'notes'
/**
 * 自动生成的索引文件名。
 * 用 `memory-index.md` 而不是 `index.md`，避免与宿主知识库里同名的
 * 手写索引（如 Obsidian vault 的 `索引.md` / `index.md`）混淆。
 */
export const INDEX_FILE = 'memory-index.md'
/** 单篇正文上限（字节），超出报错而不是静默截断。 */
export const DEFAULT_MAX_NOTE_BYTES = 256 * 1024
/** 搜索返回条数上限。 */
export const DEFAULT_SEARCH_LIMIT = 20

/** 带稳定错误码的记忆层错误。 */
export class MemoryError extends Error {
  /**
   * @param {string} code - 稳定错误码，工具层直接回给模型。
   * @param {string} message - 人类可读诊断。
   */
  constructor(code, message) {
    super(message)
    this.name = 'MemoryError'
    this.code = code
  }
}

/**
 * 把标题转成安全文件名（保留中日韩字符，去掉路径分隔符与保留字符）。
 *
 * @param {string} title - 记忆标题。
 * @returns {string} 不含扩展名的 slug。
 */
export function slugify(title) {
  const base = String(title ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  const safe = base.slice(0, 80)
  return safe.length > 0 ? safe : `note-${Date.now()}`
}

/**
 * 把相对路径解析到根目录内；越界即抛错。
 *
 * @param {string} root - 存储根目录（绝对路径）。
 * @param {string} relative - 模型给出的相对路径。
 * @returns {string} 绝对路径。
 */
export function safeJoin(root, relative) {
  if (typeof relative !== 'string' || relative.trim() === '') {
    throw new MemoryError('INVALID_PATH', 'path 不能为空')
  }
  if (relative.includes('\u0000')) throw new MemoryError('INVALID_PATH', 'path 含非法字符')
  const abs = resolve(root, relative)
  const prefix = root.endsWith(sep) ? root : root + sep
  if (abs !== root && !abs.startsWith(prefix)) {
    throw new MemoryError('INVALID_PATH', `path 越出存储目录: ${relative}`)
  }
  return abs
}

/**
 * 渲染 frontmatter。只支持扁平字符串/字符串数组，够用且好解析。
 *
 * @param {Record<string, unknown>} meta - 元数据。
 * @returns {string} 含首尾 `---` 的块。
 */
export function renderFrontmatter(meta) {
  const lines = ['---']
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      lines.push(`${key}: [${value.map((item) => String(item)).join(', ')}]`)
    } else {
      lines.push(`${key}: ${String(value)}`)
    }
  }
  lines.push('---', '')
  return lines.join('\n')
}

/**
 * 解析 frontmatter，返回元数据与正文。
 *
 * @param {string} text - 文件全文。
 * @returns {{ meta: Record<string, string | string[]>, body: string }}
 */
export function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return { meta: {}, body: text }
  const end = text.indexOf('\n---', 4)
  if (end === -1) return { meta: {}, body: text }
  const meta = {}
  for (const line of text.slice(4, end).split('\n')) {
    const match = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!match) continue
    const raw = match[2].trim()
    meta[match[1]] = raw.startsWith('[')
      ? raw.replace(/^\[|\]$/g, '').split(',').map((item) => item.trim()).filter(Boolean)
      : raw
  }
  return { meta, body: text.slice(end + 4).replace(/^\n/, '') }
}

/**
 * 记忆条目的摘要：正文第一段，去掉 markdown 标记。
 *
 * @param {string} body - 正文。
 * @param {number} [max] - 最大字符数。
 * @returns {string} 单行摘要。
 */
export function summarize(body, max = 100) {
  let inFence = false
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence || line === '' || line.startsWith('#')) continue
    const plain = line
      .replace(/\[\[([^\]|]+)\|?[^\]]*\]\]/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*`_>]/g, '')
    return plain.length > max ? `${plain.slice(0, max)}…` : plain
  }
  return ''
}

/**
 * 确保存储目录存在；正文目录与索引目录分开。
 *
 * @param {string} dir - 存储根目录。
 */
export async function ensureStoreDirs(dir) {
  await mkdir(join(dir, NOTES_DIR), { recursive: true })
}

/**
 * 列出现有笔记（相对路径 + 元数据）。
 *
 * @param {string} dir - 存储根目录。
 * @returns {Promise<Array<{ path: string, title: string, type: string, tags: string[], updated: string, summary: string, body: string }>>}
 */
export async function listNotes(dir) {
  let names
  try {
    names = await readdir(join(dir, NOTES_DIR))
  } catch {
    return []
  }
  const notes = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const relative = `${NOTES_DIR}/${name}`
    const text = await readFile(join(dir, relative), 'utf8')
    const { meta, body } = parseFrontmatter(text)
    notes.push({
      path: relative,
      title: typeof meta.title === 'string' && meta.title !== '' ? meta.title : name.replace(/\.md$/, ''),
      type: typeof meta.type === 'string' ? meta.type : 'note',
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      updated: typeof meta.updated === 'string' ? meta.updated : '',
      summary: summarize(body),
      body,
    })
  }
  return notes
}

/**
 * 写入一条记忆。同 slug 已存在时加 `-2`/`-3` 后缀，除非显式给了 path。
 *
 * @param {string} dir - 存储根目录。
 * @param {{ title: string, content: string, type?: string, tags?: string[], path?: string, source?: string }} input
 * @param {{ maxNoteBytes?: number, now?: () => Date }} [options]
 * @returns {Promise<{ path: string, created: boolean }>}
 */
export async function writeNote(dir, input, options = {}) {
  const maxBytes = options.maxNoteBytes ?? DEFAULT_MAX_NOTE_BYTES
  const now = options.now ?? (() => new Date())
  const content = String(input.content ?? '')
  if (content.trim() === '') throw new MemoryError('EMPTY_CONTENT', 'content 不能为空')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > maxBytes) throw new MemoryError('CONTENT_TOO_LARGE', `content ${bytes} 字节超过上限 ${maxBytes}`)

  await ensureStoreDirs(dir)
  const stamp = localDate(now())
  let relative = typeof input.path === 'string' && input.path !== '' ? input.path : null
  let created = true
  let previous = {}

  if (relative !== null) {
    const abs = safeJoin(dir, relative)
    relative = abs.slice(dir.length + 1)
    try {
      const old = parseFrontmatter(await readFile(abs, 'utf8'))
      previous = old.meta
      created = false
    } catch {
      created = true
    }
  } else {
    const slug = slugify(input.title)
    for (let index = 1; index < 1000; index += 1) {
      const candidate = `${NOTES_DIR}/${index === 1 ? slug : `${slug}-${index}`}.md`
      try {
        await stat(join(dir, candidate))
      } catch {
        relative = candidate
        break
      }
    }
    if (relative === null) throw new MemoryError('TOO_MANY_COLLISIONS', '同名记忆过多，请换标题')
  }

  const abs = safeJoin(dir, relative)
  ensureInsideNotes(dir, abs)
  const meta = {
    title: input.title,
    type: input.type ?? 'note',
    created: typeof previous.created === 'string' ? previous.created : stamp,
    updated: stamp,
    tags: input.tags ?? (Array.isArray(previous.tags) ? previous.tags : []),
    source: input.source ?? '',
  }
  const text = renderFrontmatter(meta) + content.replace(/\s+$/, '') + '\n'
  await writeFile(abs, text, 'utf8')
  return { path: relative, created }
}

/**
 * 笔记必须落在 NOTES_DIR 内（索引文件不放进去）。
 *
 * @param {string} dir - 存储根目录。
 * @param {string} abs - 目标绝对路径。
 */
function ensureInsideNotes(dir, abs) {
  const notesRoot = join(dir, NOTES_DIR) + sep
  if (!abs.startsWith(notesRoot)) throw new MemoryError('INVALID_PATH', 'path 必须在 notes/ 目录内')
}

/**
 * 读取一条记忆。
 *
 * @param {string} dir - 存储根目录。
 * @param {string} relative - 相对路径。
 * @returns {Promise<{ path: string, meta: Record<string, unknown>, body: string }>}
 */
export async function readNote(dir, relative) {
  const abs = safeJoin(dir, relative)
  let text
  try {
    text = await readFile(abs, 'utf8')
  } catch {
    throw new MemoryError('NOT_FOUND', `找不到记忆: ${relative}`)
  }
  const { meta, body } = parseFrontmatter(text)
  return { path: relative, meta, body }
}

/**
 * 子串检索：标题命中权重最高，其次标签，最后正文。
 *
 * @param {string} dir - 存储根目录。
 * @param {string} query - 检索词（大小写不敏感）。
 * @param {{ limit?: number }} [options]
 * @returns {Promise<Array<{ path: string, title: string, type: string, tags: string[], score: number, snippet: string }>>}
 */
export async function searchNotes(dir, query, options = {}) {
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle === '') throw new MemoryError('EMPTY_QUERY', 'query 不能为空')
  const notes = await listNotes(dir)
  const hits = []
  for (const note of notes) {
    let score = 0
    if (note.title.toLowerCase().includes(needle)) score += 100
    if (note.tags.some((tag) => tag.toLowerCase().includes(needle))) score += 40
    const bodyHit = note.body.toLowerCase().indexOf(needle)
    if (bodyHit !== -1) score += 10
    if (score === 0) continue
    const snippet = bodyHit === -1
      ? note.summary
      : note.body.slice(Math.max(0, bodyHit - 40), bodyHit + 120).replace(/\s+/g, ' ').trim()
    hits.push({ path: note.path, title: note.title, type: note.type, tags: note.tags, score, snippet })
  }
  hits.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title, 'zh'))
  return hits.slice(0, limit)
}

/**
 * 生成索引页面（人可读 + 模型可一次性扫）。
 *
 * @param {string} dir - 存储根目录。
 * @returns {Promise<{ path: string, count: number }>}
 */
export async function rebuildIndex(dir) {
  const notes = await listNotes(dir)
  const groups = new Map()
  for (const note of notes) {
    const key = note.type
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(note)
  }
  const lines = [
    '# 记忆索引',
    '',
    `> 自动生成，勿手改。由 memory_write / memory_sync 重建。`,
    `> 共 ${notes.length} 条 · 生成于 ${localStamp()}`,
    '',
  ]
  for (const [type, list] of [...groups.entries()].sort((left, right) => right[1].length - left[1].length)) {
    lines.push(`## ${type}（${list.length}）`, '')
    list.sort((left, right) => right.updated.localeCompare(left.updated))
    for (const note of list) {
      const tags = note.tags.length > 0 ? ` · #${note.tags.join(' #')}` : ''
      lines.push(`- [[${note.path.replace(/\.md$/, '')}|${note.title}]]（${note.updated}${tags}）${note.summary !== '' ? ` — ${note.summary}` : ''}`)
    }
    lines.push('')
  }
  const path = join(dir, INDEX_FILE)
  await writeFile(path, lines.join('\n'), 'utf8')
  return { path: INDEX_FILE, count: notes.length }
}

/**
 * 稳定指纹，用于判断索引是否需要重建。
 *
 * @param {string} dir - 存储根目录。
 * @returns {Promise<string>} sha1。
 */
export async function storeFingerprint(dir) {
  const notes = await listNotes(dir)
  const hash = createHash('sha1')
  for (const note of notes.sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(note.path).update('\u0000').update(note.updated).update('\u0000').update(String(note.body.length)).update('\n')
  }
  return hash.digest('hex')
}
