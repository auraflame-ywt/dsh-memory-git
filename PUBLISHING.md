# 发布清单（维护者用）

当前包：`@liuxinye/dsh-memory-git`，npm 公开包，对应 GitHub 仓库
`auraflame-ywt/dsh-memory-git`。

## 1. 元数据（已完成）

- `name`：`@liuxinye/dsh-memory-git`（统一 scope，避免重名）
- `private` 已移除
- `repository` / `homepage` / `bugs` 指向 GitHub
- `publishConfig.access: "public"`（scope 包必须显式公开）
- `files` 白名单：`lib/`、`cordis.patch.yml`、`icon.svg`、`README.md`、`LICENSE`

## 2. 兼容性声明

DSH 用 `engines.dsh` 做版本准入（优先于 `peerDependencies`）：

```json
"engines": { "node": ">=20", "dsh": ">=0.2.1-rc.3 <1.0.0" }
```

不匹配时插件页/CLI 会报 `Plugin xxx@0.2.0 is incompatible with dsh x.y.z`，并给出
`dsh plugin allow-version` 的豁免路径。

## 3. 发布前检查

```bash
node --test                 # 用例必须全绿
npm pack --dry-run          # 确认 tarball 只含白名单文件
npm view @liuxinye/dsh-memory-git versions   # 确认版本号没被占用
```

## 4. 发布到 npm

```bash
npm login
npm publish --access public
```

机器全局 registry 是 `npmmirror`（只读镜像，不能发），发布时显式指定官方源：

```bash
npm publish --registry=https://registry.npmjs.org
```

## 5. 用户怎么装

**图形界面（推荐）**：设置 → 插件 → 安装，填 `@liuxinye/dsh-memory-git` → 安装后默认启用，重启生效。

**命令行**：

```bash
dsh plugin --profile <name> add @liuxinye/dsh-memory-git
# 然后在 设置 → 插件 页启用该组合包（或往 dsh.profile.bundles 追加）
```

**本地开发**：`dsh plugin --profile <name> add "link:/绝对路径/dsh-memory-git"`。

装完不用改 YAML：直接对 AI 说「把记忆仓库设成 <地址>」，它会调 `memory_configure`
写入 `$DSH_HOME/memory.config.json`，即时生效。

## 6. 首次运行向导（当前形态）

没有独立 UI，用它自己的两个工具代替：

- `memory_configure` —— 运行时写配置文件，零 YAML、零重启
- `memory_status` —— 自检：存储位置、条数、远端、最近提交、配置来源；空库/无远端时给下一步指引

DSH 官方插件的配置页需要各自的客户端伴生包（`dsh-client-ui-*`）。当前包刻意零客户端代码：
先用工具把闭环跑通，等有真实用户抱怨再补 UI。

## 7. 版本策略

- `0.x`：工具契约可能变（参数名、返回文本结构）
- 记忆文件格式（frontmatter 字段）从 `0.2.0` 起视为稳定，破坏性变更需要迁移脚本
