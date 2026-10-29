import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  MemoryError,
  NOTES_DIR,
  INDEX_FILE,
  listNotes,
  parseFrontmatter,
  readNote,
  rebuildIndex,
  renderFrontmatter,
  safeJoin,
  searchNotes,
  slugify,
  summarize,
  writeNote,
} from '../lib/memory.mjs'

/** @type {string} */
let dir

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('slugify', () => {
  it('保留中日韩字符，压缩空白为连字符', () => {
    assert.equal(slugify('  我的 技术栈  '), '我的-技术栈')
  })

  it('剥掉路径分隔符与保留字符', () => {
    assert.equal(slugify('a/b:c*d?e"f<g>h|i'), 'abcdefghi')
  })

  it('去掉首尾的点与连字符', () => {
    assert.equal(slugify('--.hello.--'), 'hello')
  })

  it('空标题回退到带时间戳的名字', () => {
    assert.match(slugify('   '), /^note-\d+$/)
  })

  it('超长标题截断到 80 字符', () => {
    assert.equal(slugify('x'.repeat(200)).length, 80)
  })
})

describe('frontmatter', () => {
  it('往返渲染与解析', () => {
    const text = renderFrontmatter({ title: '标题', type: 'fact', tags: ['a', 'b'] }) + '正文\n'
    const { meta, body } = parseFrontmatter(text)
    assert.equal(meta.title, '标题')
    assert.equal(meta.type, 'fact')
    assert.deepEqual(meta.tags, ['a', 'b'])
    assert.equal(body, '正文\n')
  })

  it('没有 frontmatter 时整篇当正文', () => {
    const { meta, body } = parseFrontmatter('# 标题\n内容')
    assert.deepEqual(meta, {})
    assert.equal(body, '# 标题\n内容')
  })
})

describe('summarize', () => {
  it('跳过标题与代码块，剥掉 markdown 标记', () => {
    const body = '# 标题\n\n```js\ncode\n```\n\n这是 [[链接|链接]] 与 **加粗** 正文。'
    assert.equal(summarize(body), '这是 链接 与 加粗 正文。')
  })

  it('超长时截断并加省略号', () => {
    assert.ok(summarize('x'.repeat(200), 10).endsWith('…'))
  })
})

describe('safeJoin', () => {
  it('拒绝目录穿越', () => {
    assert.throws(() => safeJoin(dir, '../escape.md'), (error) => error instanceof MemoryError && error.code === 'INVALID_PATH')
  })

  it('拒绝绝对路径', () => {
    assert.throws(() => safeJoin(dir, '/etc/passwd'), (error) => error.code === 'INVALID_PATH')
  })

  it('空路径报错', () => {
    assert.throws(() => safeJoin(dir, '  '), (error) => error.code === 'INVALID_PATH')
  })

  it('正常相对路径落在根目录内', () => {
    assert.equal(safeJoin(dir, 'notes/a.md'), join(dir, 'notes/a.md'))
  })
})

describe('writeNote / readNote', () => {
  it('创建带 frontmatter 的笔记并可按路径读回', async () => {
    const result = await writeNote(dir, { title: '偏好编辑器', content: '用户偏好 Neovim。', type: 'preference', tags: ['工具'] })
    assert.equal(result.created, true)
    assert.equal(result.path, `${NOTES_DIR}/偏好编辑器.md`)

    const raw = await readFile(join(dir, result.path), 'utf8')
    assert.ok(raw.startsWith('---\n'))

    const note = await readNote(dir, result.path)
    assert.equal(note.meta.title, '偏好编辑器')
    assert.equal(note.meta.type, 'preference')
    assert.deepEqual(note.meta.tags, ['工具'])
    assert.match(note.body, /Neovim/)
  })

  it('同名标题追加序号而不是覆盖', async () => {
    await writeNote(dir, { title: '重复', content: '第一条' })
    const second = await writeNote(dir, { title: '重复', content: '第二条' })
    assert.equal(second.path, `${NOTES_DIR}/重复-2.md`)
  })

  it('给 path 时原地更新并保留 created', async () => {
    const first = await writeNote(dir, { title: '状态', content: 'v1' })
    const created = (await readNote(dir, first.path)).meta.created
    const again = await writeNote(dir, { title: '状态', content: 'v2', path: first.path })
    assert.equal(again.created, false)
    const note = await readNote(dir, first.path)
    assert.equal(note.meta.created, created)
    assert.match(note.body, /v2/)
  })

  it('空正文与超限正文都报错', async () => {
    await assert.rejects(writeNote(dir, { title: '空', content: '   ' }), (error) => error.code === 'EMPTY_CONTENT')
    await assert.rejects(
      writeNote(dir, { title: '大', content: 'x'.repeat(2048) }, { maxNoteBytes: 1024 }),
      (error) => error.code === 'CONTENT_TOO_LARGE',
    )
  })

  it('读不存在的路径报 NOT_FOUND', async () => {
    await assert.rejects(readNote(dir, `${NOTES_DIR}/nope.md`), (error) => error.code === 'NOT_FOUND')
  })
})

describe('searchNotes', () => {
  it('标题命中排在正文命中之前，并返回片段', async () => {
    await writeNote(dir, { title: 'Vue 响应式', content: '依赖收集与派发更新。', type: 'fact' })
    await writeNote(dir, { title: '杂项', content: '这里顺带提到 vue 一次。', type: 'fact' })
    const hits = await searchNotes(dir, 'vue')
    assert.equal(hits.length, 2)
    assert.equal(hits[0].title, 'Vue 响应式')
    assert.ok(hits[0].score > hits[1].score)
    assert.ok(hits[0].snippet.length > 0)
  })

  it('标签命中给中间权重', async () => {
    await writeNote(dir, { title: '部署', content: '无关正文', tags: ['kubernetes'] })
    const hits = await searchNotes(dir, 'kubernetes')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].score, 40)
  })

  it('limit 生效，空 query 报错', async () => {
    for (let index = 0; index < 5; index += 1) {
      await writeNote(dir, { title: `笔记 ${index}`, content: '共同关键词 alpha' })
    }
    assert.equal((await searchNotes(dir, 'alpha', { limit: 2 })).length, 2)
    await assert.rejects(searchNotes(dir, '  '), (error) => error.code === 'EMPTY_QUERY')
  })

  it('无命中返回空数组而不是报错', async () => {
    await writeNote(dir, { title: 'a', content: 'b' })
    assert.deepEqual(await searchNotes(dir, '不存在的词'), [])
  })
})

describe('rebuildIndex', () => {
  it('按 type 分组生成索引，并统计条数', async () => {
    await writeNote(dir, { title: '偏好一', content: '甲', type: 'preference' })
    await writeNote(dir, { title: '决策一', content: '乙', type: 'decision' })
    const result = await rebuildIndex(dir)
    assert.equal(result.count, 2)
    assert.equal(result.path, INDEX_FILE)
    const text = await readFile(join(dir, INDEX_FILE), 'utf8')
    assert.match(text, /## preference（1）/)
    assert.match(text, /## decision（1）/)
    assert.match(text, /\[\[notes\/偏好一\|偏好一\]\]/)
  })

  it('空存储也能生成索引', async () => {
    const result = await rebuildIndex(dir)
    assert.equal(result.count, 0)
    assert.match(await readFile(join(dir, INDEX_FILE), 'utf8'), /共 0 条/)
  })
})

describe('listNotes', () => {
  it('目录不存在时返回空数组', async () => {
    assert.deepEqual(await listNotes(join(dir, 'missing')), [])
  })

  it('忽略非 markdown 文件', async () => {
    await writeNote(dir, { title: '真笔记', content: 'x' })
    await writeFile(join(dir, NOTES_DIR, 'ignored.txt'), 'nope')
    assert.equal((await listNotes(dir)).length, 1)
  })
})
