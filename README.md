# OpenKanban

一个看板：任务可以被**本机安装的** Claude Code / Codex CLI 认领并自动完成，
人类只做定义和验收。

```bash
npx openkanban
```

启动后自动打开浏览器。规划文档见 [docs/PRD.md](docs/PRD.md)。

需要 Node ≥ 22.5（用到内置的 `node:sqlite`），以及本机已装 `claude` 或 `codex`
其中之一。发布包 148 KB、**零运行时依赖**。

想让它一直活着（自动认领的意义就在于你不用盯着）：

```bash
openkanban service print     # 先看它要写什么，不做任何改动
openkanban service install   # 确认无误再装
```

## 它是什么

往看板扔卡片 → Agent 在**独立的 git worktree 分支**上干活 → 你看 diff 决定
通过、打回还是废弃。打回会带着你的评审意见接续上一次会话继续改。

- **零 API Key**。所有模型访问都发生在 `claude` / `codex` 子进程内部，用你
  自己的登录态。OpenKanban 不接受、不存储、不传递任何 key，起子进程前还会
  清洗掉环境里的凭证形变量。
- **不绑定 CLI 版本**。启动时解析 `--help` 得出能力矩阵，装的是什么版本就用
  什么版本；不支持的能力在界面上直接灰掉，不会等到运行时才失败。
- **worktree 隔离**。Agent 不碰你的主工作区，跑飞了删掉分支即可。
- **只监听 `127.0.0.1`**。远程访问走 SSH 端口转发。

## 结构

```
packages/core   纯领域逻辑，无 IO，时间由参数传入 —— 状态机、CAS、租约、调度决策
packages/host   Node 侧：CLI 探测与执行、worktree、SQLite、HTTP + SSE、验收
packages/web    React + Vite + shadcn/ui，产物由 host 托管
```

## 开发

```bash
pnpm install
pnpm test            # 211 个测试
pnpm run typecheck
pnpm run build       # 打出 dist/openkanban.js 与 dist/web/

# 从源码直接跑，不必构建
node --experimental-strip-types packages/host/src/bin/openkanban.ts
```

### 两条容易踩的约束

**开发时 `core` 与 `host` 直接跑在 `node --experimental-strip-types` 上，
没有构建步骤**（发布版另行用 esbuild 打成单文件 —— shebang 里塞不进这个 flag）。
strip-only 模式不支持参数属性（`constructor(private x)`）、`enum`、`namespace`
和装饰器 —— vitest 用 esbuild 能编过，但真正运行时会报
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。`web` 走 Vite，不受此限制。

**探测能力，不要假设。** 参数面要按**每条命令**分别探测：实测
`codex exec resume` 就没有 `--cd` / `--sandbox` / `--approve-for-me`，
照搬主命令的参数会被直接拒绝。
