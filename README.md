# dsh-memory-git

把**用户自己的 git 仓库**当作 DeepSeek Harness 的长期记忆：配一个仓库地址，agent 就获得
`memory_write` / `memory_search` / `memory_read` / `memory_sync` 四个工具，记忆以
「一篇一事实」的 Markdown 文件落盘，自动 commit、按需 push。

```
用户配置 repo ──► 首次调用时 clone ──► notes/*.md + memory-index.md
                                        │
                         memory_write ──┴─► debounce 30s ──► git commit ──► push
```

## 为什么是 Markdown + git

- **人可读、可迁移**：Obsidian / VSCode / 任意编辑器都能直接打开，不锁定格式
- **冲突天然小**：一篇一个文件，两个人改不同记忆就是不同文件，git 不会打架
- **免费的多端同步与历史**：用户已经有 git 就够，不需要插件内建任何云服务
- **零依赖检索**：索引文件 + 子串扫描，不引入 embedding、不调模型 API

## 工具

| 工具 | 作用 |
|---|---|
| `memory_write` | 写一条记忆；给 `path` 则原地更新（保留 created） |
| `memory_search` | 子串检索，标题权重 > 标签 > 正文，返回片段 |
| `memory_read` | 按路径读全文 |
| `memory_sync` | 合并提交 → pull --rebase → push，失败原因翻译成人话 |
| `memory_status` | 报告存储位置、条数、仓库/远端、最近提交、待同步；未配远端时给配置指引 |

## 同步失败怎么读

`memory_sync` / `memory_status` 把 git 失败归类成稳定原因码，而不是甩 stderr：

| 原因码 | 含义 | 建议 |
|---|---|---|
| `no-remote` | 没配远端 | 记忆只在本机；`git remote add origin <url>` 后重试 |
| `conflict` | 远端与本地改到同一处 | 自动执行 `git rebase --abort` 回滚，手动 `git pull` 解决后再 sync |
| `network` | 域名解析/连接超时 | 检查网络或代理 |
| `auth` | SSH key / 权限问题 | 检查 key 与仓库访问权限 |
| `rejected` | 远端有别人的新提交 | 先拉取再推送 |
| `timeout` | 单次操作超时 | 稍后重试 |

冲突**不会**把仓库留在半 rebase 状态——同步是后台动作，卡住会拖累用户下一次普通操作。

## 存储布局

```
<dir>/
├── memory-index.md   # 自动生成的索引（勿手改）
├── notes/
│   ├── 偏好编辑器.md
│   └── Tarot-推广渠道.md
└── .git/
```

每条记忆：

```markdown
---
title: 偏好编辑器
type: preference
created: 2026-10-28
updated: 2026-10-28
tags: [工具]
source: dsh-memory-git
---

用户偏好 Neovim，希望保持 vim 键位。
```

## 安装

### 从 npm 安装（推荐）

在 DSH 的 **设置 → 插件 → 安装** 里填包名：

```text
@liuxinye/dsh-memory-git
```

装完默认启用，重启 DSH 生效。

命令行等价：

```bash
dsh plugin --profile desktop add @liuxinye/dsh-memory-git
```

### 从源码链接（开发调试）

```bash
# 1. 把包链接进 profile
dsh plugin --profile desktop add "link:/绝对路径/dsh-memory-git"

# 2. 在 profile 的 dsh.profile.bundles 末尾追加
#    "@liuxinye/dsh-memory-git"
#    或者直接在 设置 → 插件 页启用
```

`cordis.patch.yml` 里可以覆盖任何配置项。

## 配置（三种方式，按侵入性排序）

### 1. 零配置：装完就能用

不配任何东西时，记忆落在 `$DSH_HOME/memory`，本地 `git init`。**不会丢，但没有异地备份。**

### 2. 让 AI 配置（推荐，无需重启）

对 AI 说「把记忆仓库设成 git@github.com:me/memory.git」，它会调：

```text
memory_configure({ repo: "git@github.com:me/memory.git", autoPush: true })
```

写入 `$DSH_HOME/memory.config.json`，**下一次工具调用立即生效**，不用改 YAML、不用重启。
想换存储位置就传 `dir`（支持 `~/...`，必须是绝对路径）。不带参数调用 = 打印当前配置。

### 3. profile patch（最高优先级，需要重启）

在 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 里写：

```yaml
- id: memory-git
  name: 'dsh-memory-git'
  config:
    repo: git@github.com:me/memory.git
    dir: /Users/me/memory
```

**优先级：profile patch > 配置文件 > 默认值。** 在 patch 里写了的字段，
`memory_configure` 改不动（它会明说哪些字段被覆盖）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `repo` | `''` | 记忆仓库地址；留空 = 本地目录模式（只 init 不 push） |
| `dir` | `$DSH_HOME/memory` | 本地存储目录 |
| `branch` | `main` | 分支 |
| `autoPush` | `true` | 自动提交后是否 push；无远端自动跳过 |
| `commitIntervalMs` | `30000` | 写入后合并提交的 debounce |
| `maxNoteBytes` | `262144` | 单条正文上限，超出报错而非截断 |
| `searchLimit` | `20` | 单次检索返回上限 |
| `authorName` / `authorEmail` | `DSH Memory` | 提交作者，不依赖全局 git 配置 |

## 安全边界

- **只提交记忆目录**：`commitAll` 用 pathspec，记忆目录嵌在用户既有仓库里时不会误提交无关文件
- **路径逃逸拦截**：所有 `path` 都过 `safeJoin`，拒绝 `..`、绝对路径与 NUL
- **不拼 shell**：所有 git 调用走 `execFile('git', argv)`
- **不挂死**：`GIT_TERMINAL_PROMPT=0` + 超时 + 输出上限，网络问题报错而不是阻塞对话
- **失败不中断回合**：工具错误渲染成 `✗ CODE: message` 返回给模型

## 测试

```bash
node --test        # 60 个用例：存储/检索/索引/路径安全/git 提交与 clone/冲突回滚/插件接线
```

## 路线图

- **P0（已完成）**：4 个工具 + 本地/git 同步 + 索引，能自用
- **P1（已完成）**：`memory_status`（配置自检/向导）、冲突自动回滚与人话提示、本地时间格式、发布元数据
- **P2**：发 npm、插件市场条目、i18n、`evaluatePluginCompatibility` 兼容性声明、多设备 pull 策略

## 与 Obsidian 的关系

`dir` 可以指向 Obsidian vault 里的子目录（例如 `知识库/记忆`）。此时插件只提交该子目录，
vault 的其他笔记不受影响；记忆文件本身也能在 Obsidian 里作为普通笔记阅读。
