import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { apply } from '../lib/index.js'

/** 最小 DSH context：只提供插件用到的两个服务。 */
function mockContext() {
  const tools = []
  const sections = []
  return {
    tools,
    sections,
    ctx: {
      tools: { register: (tool) => tools.push(tool) },
      systemPrompt: { section: (section) => sections.push(section) },
      effect: (factory) => {
        const dispose = factory()
        return () => dispose?.()
      },
    },
  }
}

/** @type {string} */
let dir
/** @type {string | undefined} */
let originalHome

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-memory-plugin-'))
  // 配置文件落在 $DSH_HOME 下，测试必须隔离，否则会改到真实用户配置
  originalHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
})

afterEach(async () => {
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  await rm(dir, { recursive: true, force: true })
})

/** @param {{ dir: string }} config */
function boot(config) {
  const harness = mockContext()
  apply(harness.ctx, { dir: config.dir, autoPush: false, commitIntervalMs: 1000 })
  const byName = Object.fromEntries(harness.tools.map((tool) => [tool.name, tool]))
  return { ...harness, byName }
}

describe('工具注册', () => {
  it('注册 6 个工具并注入提示段', () => {
    const { tools, sections } = boot({ dir })
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['memory_configure', 'memory_read', 'memory_search', 'memory_status', 'memory_sync', 'memory_write'],
    )
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, 'tool:memory-git')
    assert.equal(sections[0].order, 2350)
  })

  it('每个工具都声明 output.render', () => {
    const { tools } = boot({ dir })
    for (const tool of tools) {
      assert.equal(typeof tool.output.render, 'function', tool.name)
      assert.equal(tool.output.schema.type, 'string', tool.name)
    }
  })
})

describe('memory_write → search → read', () => {
  it('写入后能检索并读回全文', async () => {
    const { byName } = boot({ dir })
    const write = await byName.memory_write.execute({
      title: '偏好语言',
      content: '用户偏好中文回答。',
      type: 'preference',
      tags: ['沟通'],
    })
    assert.match(write, /已创建 notes\/偏好语言\.md/)
    assert.match(write, /索引共 1 条/)

    const search = await byName.memory_search.execute({ query: '中文' })
    assert.match(search, /命中 1 条记忆/)
    assert.match(search, /偏好语言/)

    const read = await byName.memory_read.execute({ path: 'notes/偏好语言.md' })
    assert.match(read, /type: preference/)
    assert.match(read, /用户偏好中文回答/)
  })

  it('缺必填参数返回可读错误而不是抛异常', async () => {
    const { byName } = boot({ dir })
    assert.match(await byName.memory_write.execute({ title: '只有标题' }), /✗ INVALID_ARGS/)
    assert.match(await byName.memory_search.execute({}), /✗ INVALID_ARGS/)
  })

  it('路径穿越被拦下并返回错误码', async () => {
    const { byName } = boot({ dir })
    assert.match(await byName.memory_read.execute({ path: '../../etc/passwd' }), /✗ INVALID_PATH/)
  })

  it('检索无命中时给存储目录提示', async () => {
    const { byName } = boot({ dir })
    const result = await byName.memory_search.execute({ query: '不存在' })
    assert.match(result, /没有命中/)
    assert.match(result, /存储目录:/)
  })
})

describe('memory_status', () => {
  it('报告存储位置、条数与远端缺失时的配置指引', async () => {
    const { byName } = boot({ dir })
    await byName.memory_write.execute({ title: '一条记忆', content: '内容' })
    const status = await byName.memory_status.execute({})
    assert.match(status, /记忆条数: 1/)
    assert.match(status, /分支 main|分支 master/)
    assert.match(status, /远端: 未配置/)
    assert.match(status, /remote add origin/)
  })

  it('空存储时提示如何写入第一条', async () => {
    const { byName } = boot({ dir })
    const status = await byName.memory_status.execute({})
    assert.match(status, /还没有记忆/)
  })
})

describe('memory_sync', () => {
  it('提交本地变更并报告无远端', async () => {
    const { byName } = boot({ dir })
    await byName.memory_write.execute({ title: '待同步', content: '内容' })
    const result = await byName.memory_sync.execute({ message: 'test' })
    assert.match(result, /提交: 已提交/)
    assert.match(result, /无远端/)
  })

  it('生成索引文件 memory-index.md', async () => {
    const { byName } = boot({ dir })
    await byName.memory_write.execute({ title: '索引检查', content: '内容' })
    const index = await readFile(join(dir, 'memory-index.md'), 'utf8')
    assert.match(index, /# 记忆索引/)
    assert.match(index, /\[\[notes\/索引检查\|索引检查\]\]/)
    assert.match(index, /生成于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  })
})

describe('memory_configure', () => {
  it('写入配置文件并即时生效（写记忆落到新目录）', async () => {
    // 不传 patch 配置，让配置文件拥有优先级（否则 dir 会被 patch 盖住）
    const harness = mockContext()
    apply(harness.ctx, {})
    const byName = Object.fromEntries(harness.tools.map((tool) => [tool.name, tool]))
    const target = join(dir, 'configured-store')
    const result = await byName.memory_configure.execute({ dir: target, autoPush: false })
    assert.match(result, /已写入: dir, autoPush/)
    assert.match(result, /配置文件:/)

    await byName.memory_write.execute({ title: '配置后写入', content: '内容' })
    const status = await byName.memory_status.execute({})
    assert.match(status, new RegExp(`存储目录: ${target}`))
    assert.match(status, /配置来源: 配置文件 → dir, autoPush/)
  })

  it('无参数时只打印当前配置', async () => {
    const { byName } = boot({ dir })
    const result = await byName.memory_configure.execute({})
    assert.match(result, /当前生效配置/)
    assert.match(result, /存储目录:/)
  })

  it('profile patch 覆盖的字段会给出警告', async () => {
    const harness = mockContext()
    const patchDir = join(dir, 'patch-dir')
    apply(harness.ctx, { dir: patchDir, autoPush: false })
    const byName = Object.fromEntries(harness.tools.map((tool) => [tool.name, tool]))
    const result = await byName.memory_configure.execute({ dir: join(dir, 'other-dir') })
    assert.match(result, /被 profile 的 cordis.patch.yml 覆盖/)
    const status = await byName.memory_status.execute({})
    assert.match(status, new RegExp(`存储目录: ${patchDir}`))
  })

  it('不可写目录在写配置前被拦下，原配置保持不变', async () => {
    const { byName } = boot({})
    // 用一个普通文件当父目录，mkdir 必然失败
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'x')
    const result = await byName.memory_configure.execute({ dir: join(blocker, 'child') })
    assert.match(result, /✗/)
    assert.match(result, /目录未写入配置/)
    const status = await byName.memory_status.execute({})
    assert.doesNotMatch(status, /blocker/)
  })

  it('相对路径被拒绝，不写坏配置', async () => {
    const { byName } = boot({ dir })
    const result = await byName.memory_configure.execute({ dir: 'relative/path' })
    assert.match(result, /INVALID_ARGS/)
  })
})
