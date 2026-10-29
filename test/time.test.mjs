import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { localDate, localStamp } from '../lib/time.mjs'

describe('localDate', () => {
  it('用本地日历日而不是 UTC 日', () => {
    // 本地 2026-01-01 00:30 在东八区是 UTC 前一天 16:30；
    // 用 toISOString().slice(0,10) 会得到 2025-12-31。
    const date = new Date(2026, 0, 1, 0, 30)
    assert.equal(localDate(date), '2026-01-01')
  })

  it('月份与日期补零', () => {
    assert.equal(localDate(new Date(2026, 8, 5, 12, 0)), '2026-09-05')
  })
})

describe('localStamp', () => {
  it('格式为 YYYY-MM-DD HH:mm', () => {
    assert.equal(localStamp(new Date(2026, 9, 28, 9, 7)), '2026-10-28 09:07')
  })

  it('不出现 UTC 偏移', () => {
    const date = new Date(2026, 9, 28, 21, 43)
    assert.equal(localStamp(date), '2026-10-28 21:43')
  })
})
