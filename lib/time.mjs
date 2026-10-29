/**
 * 时间格式化 —— 纯函数，可独立单测。
 *
 * 为什么不直接用 `toISOString()`：它返回 UTC。在中国时区下，commit message
 * 会显示成 8 小时前的时刻（13:43 实际是本地 21:43），跨时区用户更容易误读。
 * 记忆的 `created` / `updated` 日期也必须用**本地日历日**，否则 23:00 之后写入
 * 的记忆会被标成"明天"或"昨天"的 UTC 日期。
 *
 * @module @liuxinye/dsh-memory-git/time
 */

/**
 * 把日期格式化为本地时区的 `YYYY-MM-DD HH:mm`。
 *
 * @param {Date} [date] - 目标时刻，默认当前。
 * @returns {string} 本地时间串。
 */
export function localStamp(date = new Date()) {
  return `${localDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 把日期格式化为本地时区的 `YYYY-MM-DD`。
 *
 * @param {Date} [date] - 目标时刻，默认当前。
 * @returns {string} 本地日期串。
 */
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 两位补零。
 *
 * @param {number} value - 数字。
 * @returns {string} 补零后的字符串。
 */
function pad(value) {
  return String(value).padStart(2, '0')
}
