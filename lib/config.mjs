/**
 * 配置解析 —— 纯函数 + 同步读写，不依赖 DSH 运行时。
 *
 * 优先级：**profile patch > 配置文件 > 默认值**。
 *
 * 为什么要配置文件：DSH 官方插件的配置页需要各自的客户端伴生包（`dsh-client-ui-*`），
 * 而对「装完就想用」的用户，改 `cordis.patch.yml` + 重启体验太重。配置文件让
 * `memory_configure` 工具能在运行时改配置，下一次调用立即生效。
 *
 * 配置文件路径固定为 `$DSH_HOME/memory.config.json`（不放在 `dir` 里，避免
 * 「配置决定 dir、dir 又决定配置」的鸡生蛋问题）。
 *
 * @module @liuxinye/dsh-memory-git/config
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 配置文件名。 */
export const CONFIG_FILENAME = 'memory.config.json'

/** 所有配置项的默认值。 */
export const DEFAULTS = Object.freeze({
  repo: '',
  dir: '',
  branch: 'main',
  autoPush: true,
  commitIntervalMs: 30000,
  maxNoteBytes: 262144,
  searchLimit: 20,
  authorName: 'DSH Memory',
  authorEmail: 'dsh-memory@localhost',
})

/**
 * DSH 主目录。
 *
 * @param {Record<string, string | undefined>} [env] - 环境变量，默认 process.env。
 * @returns {string} 绝对路径。
 */
export function dshHome(env = process.env) {
  const configured = env.DSH_HOME
  return configured !== undefined && configured.trim() !== '' ? configured.trim() : join(homedir(), '.dsh')
}

/**
 * 配置文件绝对路径。
 *
 * @param {Record<string, string | undefined>} [env] - 环境变量。
 * @returns {string} 绝对路径。
 */
export function configPath(env = process.env) {
  return join(dshHome(env), CONFIG_FILENAME)
}

/**
 * 读配置文件；不存在或损坏时返回空对象（不抛错，插件必须能起来）。
 *
 * @param {string} path - 配置文件路径。
 * @returns {{ data: Record<string, unknown>, error?: string }}
 */
export function readConfigFile(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { data: {} }
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { data: {}, error: '配置文件不是 JSON 对象' }
    }
    return { data: parsed }
  } catch (error) {
    return { data: {}, error: `配置文件解析失败: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 写配置文件（合并写入，权限 0600）。
 *
 * @param {string} path - 配置文件路径。
 * @param {Record<string, unknown>} patch - 要合并进去的字段。
 * @returns {Record<string, unknown>} 合并后的完整配置。
 */
export function writeConfigFile(path, patch) {
  const { data } = readConfigFile(path)
  const next = { ...data, ...patch }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  try {
    chmodSync(path, 0o600)
  } catch {
    /* 某些文件系统不支持 chmod，忽略 */
  }
  return next
}

/**
 * 逐字段做类型校验。
 *
 * @param {string} key - 字段名。
 * @param {unknown} value - 候选值。
 * @returns {boolean} 是否可用。
 */
function valid(key, value) {
  switch (key) {
    case 'repo':
    case 'dir':
    case 'authorName':
    case 'authorEmail':
      return typeof value === 'string' && value.trim() !== ''
    case 'branch':
      return typeof value === 'string' && /^[\w./-]+$/.test(value)
    case 'autoPush':
      return typeof value === 'boolean'
    case 'commitIntervalMs':
    case 'maxNoteBytes':
    case 'searchLimit':
      return Number.isInteger(value) && value > 0
    default:
      return false
  }
}

/**
 * 合并三个来源，得到最终配置与每项来源。
 *
 * @param {Record<string, unknown>} [patch] - profile patch 传入的配置。
 * @param {Record<string, unknown>} [file] - 配置文件内容。
 * @param {Record<string, string | undefined>} [env] - 环境变量。
 * @returns {{ settings: Record<string, unknown>, sources: Record<string, 'patch' | 'file' | 'default'> }}
 */
export function resolveSettings(patch = {}, file = {}, env = process.env) {
  const settings = {}
  const sources = {}
  for (const key of Object.keys(DEFAULTS)) {
    if (patch[key] !== undefined && valid(key, patch[key])) {
      settings[key] = patch[key]
      sources[key] = 'patch'
    } else if (file[key] !== undefined && valid(key, file[key])) {
      settings[key] = file[key]
      sources[key] = 'file'
    } else {
      settings[key] = DEFAULTS[key]
      sources[key] = 'default'
    }
  }
  if (settings.dir === '') settings.dir = join(dshHome(env), 'memory')
  return { settings, sources }
}

/**
 * 只保留可写字段并做校验，供 `memory_configure` 使用。
 *
 * @param {Record<string, unknown>} input - 模型给的参数。
 * @returns {{ patch: Record<string, unknown>, rejected: string[] }} 可写字段与被拒绝的字段。
 */
export function sanitizeConfigPatch(input) {
  const patch = {}
  const rejected = []
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!(key in DEFAULTS)) {
      rejected.push(key)
      continue
    }
    if (!valid(key, value)) {
      rejected.push(key)
      continue
    }
    patch[key] = typeof value === 'string' ? value.trim() : value
  }
  return { patch, rejected }
}
