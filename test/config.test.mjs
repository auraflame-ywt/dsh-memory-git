import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  CONFIG_FILENAME,
  DEFAULTS,
  configPath,
  dshHome,
  readConfigFile,
  resolveSettings,
  sanitizeConfigPatch,
  writeConfigFile,
} from '../lib/config.mjs'

/** @type {string} */
let dir

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-memory-config-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('dshHome / configPath', () => {
  it('优先 $DSH_HOME，空白视为未设置', () => {
    assert.equal(dshHome({ DSH_HOME: '/tmp/x' }), '/tmp/x')
    assert.equal(dshHome({ DSH_HOME: '   ' }).endsWith('.dsh'), true)
  })

  it('配置文件固定在 $DSH_HOME 下', () => {
    assert.equal(configPath({ DSH_HOME: '/tmp/x' }), `/tmp/x/${CONFIG_FILENAME}`)
  })
})

describe('resolveSettings 优先级', () => {
  it('patch > file > default', () => {
    const { settings, sources } = resolveSettings(
      { branch: 'release' },
      { branch: 'from-file', autoPush: false, dir: '/tmp/mem' },
      { DSH_HOME: '/tmp/home' },
    )
    assert.equal(settings.branch, 'release')
    assert.equal(sources.branch, 'patch')
    assert.equal(settings.autoPush, false)
    assert.equal(sources.autoPush, 'file')
    assert.equal(settings.dir, '/tmp/mem')
    assert.equal(settings.maxNoteBytes, DEFAULTS.maxNoteBytes)
    assert.equal(sources.maxNoteBytes, 'default')
  })

  it('dir 缺省时落在 $DSH_HOME/memory', () => {
    const { settings, sources } = resolveSettings({}, {}, { DSH_HOME: '/tmp/home' })
    assert.equal(settings.dir, '/tmp/home/memory')
    assert.equal(sources.dir, 'default')
  })

  it('非法候选值被忽略而不是写进配置', () => {
    const { settings, sources } = resolveSettings(
      { commitIntervalMs: -5 },
      { commitIntervalMs: 'abc', autoPush: 'yes' },
      { DSH_HOME: '/tmp/home' },
    )
    assert.equal(settings.commitIntervalMs, DEFAULTS.commitIntervalMs)
    assert.equal(sources.commitIntervalMs, 'default')
    assert.equal(settings.autoPush, DEFAULTS.autoPush)
  })
})

describe('readConfigFile / writeConfigFile', () => {
  it('文件不存在时返回空对象', () => {
    assert.deepEqual(readConfigFile(join(dir, 'nope.json')), { data: {} })
  })

  it('合并写入而不是覆盖', () => {
    const path = join(dir, CONFIG_FILENAME)
    writeConfigFile(path, { repo: 'git@example.com:me/mem.git' })
    const merged = writeConfigFile(path, { autoPush: false })
    assert.equal(merged.repo, 'git@example.com:me/mem.git')
    assert.equal(merged.autoPush, false)
    assert.deepEqual(readConfigFile(path).data, merged)
  })

  it('损坏的 JSON 不抛错，回退为空配置并给出 error', () => {
    const path = join(dir, CONFIG_FILENAME)
    return writeFile(path, '{ not json').then(() => {
      const result = readConfigFile(path)
      assert.deepEqual(result.data, {})
      assert.match(result.error ?? '', /解析失败/)
    })
  })

  it('顶层数组等非对象视为损坏', async () => {
    const path = join(dir, CONFIG_FILENAME)
    await writeFile(path, '[1,2,3]')
    const result = readConfigFile(path)
    assert.deepEqual(result.data, {})
    assert.match(result.error ?? '', /不是 JSON 对象/)
  })

  it('落盘为可读 JSON 且带换行', async () => {
    const path = join(dir, CONFIG_FILENAME)
    writeConfigFile(path, { dir: '/tmp/mem' })
    const text = await readFile(path, 'utf8')
    assert.ok(text.endsWith('\n'))
    assert.match(text, /"dir": "\/tmp\/mem"/)
  })
})

describe('sanitizeConfigPatch', () => {
  it('保留合法字段并裁掉空白', () => {
    const { patch, rejected } = sanitizeConfigPatch({ repo: '  git@x:y.git  ', autoPush: true })
    assert.equal(patch.repo, 'git@x:y.git')
    assert.equal(patch.autoPush, true)
    assert.deepEqual(rejected, [])
  })

  it('拒绝未知字段与非法值', () => {
    const { patch, rejected } = sanitizeConfigPatch({ nope: 1, dir: '', commitIntervalMs: 0, branch: 'bad branch!' })
    assert.deepEqual(patch, {})
    assert.deepEqual(rejected.sort(), ['branch', 'commitIntervalMs', 'dir', 'nope'])
  })

  it('忽略空输入', () => {
    assert.deepEqual(sanitizeConfigPatch(undefined), { patch: {}, rejected: [] })
  })
})
