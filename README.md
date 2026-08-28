# LoopKanban

一个看板：任务可以被**本机安装的** Claude Code / Codex / opencode CLI 认领并
自动完成，人类只做定义和验收。

```bash
npx loopkanban
```

启动后自动打开浏览器。规划文档见 [docs/PRD.md](docs/PRD.md)。

需要 Node ≥ 22.5（用到内置的 `node:sqlite`），以及本机已装 `claude`、`codex`、
`opencode` 其中之一。发布包 148 KB、**零运行时依赖**。

想让它一直活着（自动认领的意义就在于你不用盯着）：

```bash
loopkanban service print     # 先看它要写什么，不做任何改动
loopkanban service install   # 确认无误再装
```

## 它是什么

往看板扔卡片 → Agent 在**独立的 git worktree 分支**上干活 → 你看 diff 决定
通过、打回还是废弃。打回会带着你的评审意见接续上一次会话继续改。

- **零 API Key**。所有模型访问都发生在 `claude` / `codex` / `opencode` 子进程内部，用你
  自己的登录态。LoopKanban 不接受、不存储、不传递任何 key，起子进程前还会
  清洗掉环境里的凭证形变量。
- **不绑定 CLI 版本**。启动时解析 `--help` 得出能力矩阵，装的是什么版本就用
  什么版本；不支持的能力在界面上直接灰掉，不会等到运行时才失败。
- **worktree 隔离**。Agent 不碰你的主工作区，跑飞了删掉分支即可。
- **卡片可以带附件**。截图、PDF、Word 拖进卡里，派活时它们会被拷进工作区并在
  TASK.md 里点名交给 CLI —— 说不清楚的需求，给它看。
- **验收走 PR**。仓库有 GitHub 远端、本机装了 `gh`（用你自己的登录态，同样零
  API Key）时，「通过并合并」会提交改动、把基线合进任务分支、推上去并开一条 PR。
  **合不合始终是你在 GitHub 上的决定** —— 我们只在它真的合上之后把卡收进 Done，
  卡上列着它合过的每一条 PR（一张卡可以有好几条）。合基线时撞上冲突，冲突就留在
  这张卡自己的工作区里，卡自动回队列并派一轮去解 —— 那是 Agent 干的活，不是你的。
  没有远端或没装 `gh` 时这颗按钮退回本地合并，并把原因写在按钮下面。
- **做完了还能接着改**。Review 与 Done 的卡都能在讨论里再说一句，说完就回队列跑
  下一轮 —— 合完才发现还差一条，本来就是同一张卡的事，不必另开一张把讨论、工作区
  和已经合过的 PR 全丢掉。
- **只监听 `127.0.0.1`**。远程访问走 SSH 端口转发。
- **文件浏览与命令行**。顶栏可以从看板切到「文件浏览」：逛项目仓库、切到某张卡
  的 worktree 看 Agent 到底改了什么，底下还挂着一个命令行，命令就跑在你正看着的
  那个目录里。路径带围栏 —— 只能落在已登记项目的仓库里面，且判定画在 `realpath`
  上，一条指向外面的符号链接爬不出去。命令用的是你自己的 shell 与环境（**不清洗
  凭证**，否则 `git push` 会神秘地失败），每条一个新进程，超时按进程组整棵收掉。

## 结构

```
packages/core   纯领域逻辑，无 IO，时间由参数传入 —— 状态机、CAS、租约、调度决策
packages/host   Node 侧：CLI 探测与执行、worktree、SQLite、HTTP + SSE、验收与 PR
packages/web    React + Vite + shadcn/ui，产物由 host 托管
```

## 开发

```bash
pnpm install
pnpm test            # 554 个测试
pnpm run typecheck
pnpm run build       # 打出 dist/loopkanban.js 与 dist/web/

# 从源码直接跑，不必构建
node --experimental-strip-types packages/host/src/bin/loopkanban.ts
```

### 两条容易踩的约束

**开发时 `core` 与 `host` 直接跑在 `node --experimental-strip-types` 上，
没有构建步骤**（发布版另行用 esbuild 打成单文件 —— shebang 里塞不进这个 flag）。
strip-only 模式不支持参数属性（`constructor(private x)`）、`enum`、`namespace`
和装饰器 —— vitest 用 esbuild 能编过，但真正运行时会报
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。`web` 走 Vite，不受此限制。

**探测能力，不要假设。** 参数面要按**每条命令**分别探测：实测
`codex exec resume` 就没有 `--cd` / `--sandbox` / `--approve-for-me`，
照搬主命令的参数会被直接拒绝。同理，`opencode` 的 `--format` 只在
`opencode run --help` 里，主命令的 help 里没有。

探测不到的能力宁可当它没装：`opencode` 少了 `--auto` 就会在第一次写文件时
坐等一个没人给的答复（实测挂满 7 分钟零输出），卡片会一直停在 Running 直到
超时 —— 所以它是探测期的硬性前提，而不是运行期的一个惊喜。

同理，**不支持的档位要拒绝，不能降级**。别家「不传参数就交给 CLI 默认值」的
降级对 opencode 不成立：少了 `--auto` 它会挂住，所以「照跑」就等于把最严的
`strict` 跑成最松的。这种情况直接抛错，卡片回到 Review 等人判读，诊断里写清楚该改派给谁。

还有一条：**档位名字一样，关得住的东西未必一样**。同为 `standard`，codex 在
workspace-write 沙箱里、claude 走权限分类器，opencode 两者都没有。所以
`AgentCaps.permissionCaveat` 会把「无沙箱」这类警示一路带到界面上 ——
藏在文档里的警告等于没有警告。
