# LoopKanban 需求规划

> 一个看板：任务可以被**本机已安装的** Claude Code / Codex / opencode CLI 「认领」并自动完成，人类只做定义和验收。
> `npx loopkanban` 启动本地 server + 浏览器 Web UI。**自主实现，借鉴 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的架构思想，不依赖其代码。**

---

## 0. 已确认的决策

| 决策 | 选择 |
|---|---|
| 运行形态 | `npx loopkanban` 启动本地 server + 浏览器 Web UI |
| Agent 隔离 | git worktree，每任务一分支 |
| 自动认领调度器 | 核心卖点，优先做 |
| Agent 执行方式 | 起本机已装的 `claude` / `codex` / `opencode` CLI 子进程 |
| CLI 版本 | **不绑定**。启动探测本机有哪些、支持哪些能力，有哪个用哪个 |
| API Key | **全程零 API Key**。所有模型访问都在 CLI 子进程内部，用本机登录态 |
| **框架** | **自己实现，借鉴 dsh 架构，不依赖 dsh** |
| 实现语言 | **TypeScript / Node ≥22**（理由见 §2.1） |
| 存储 | SQLite（`node:sqlite` 内置） |

---

## 1. 从 dsh 借什么、不借什么

### 1.1 借（六个具体模式，不是框架）

| # | 借的东西 | 用在哪 |
|---|---|---|
| 1 | **Capability seam**：一个能力拆成「服务定义 / 提供方 / 消费方」三个角色，提供方可换 | `AgentProvider`（claude-cli / codex-cli / opencode-cli / 将来别的）、`Subprocess`、`Storage` 三条缝。这是「有哪个用哪个」能干净落地的根本原因 |
| 2 | **提供方能力描述符 + 派发前检查** | CLI 探测出的能力矩阵在派发前校验；不支持就明确拒绝 |
| 3 | **Fail loud, no silent degradation**：需要某能力而提供方没有 → 直接报错，绝不「接受了但静默忽略」 | 不支持的权限档位在 UI 上就是灰的，不能等运行时才失败 |
| 4 | **Append-only 事件日志 + 投影**：日志是唯一真相，UI 从投影渲染，重启靠回放恢复 | `run_event` 表；SSE 用 `seq` 做 `Last-Event-ID` 续传；崩溃后 UI 能完整重建 |
| 5 | **单调 `revision` 做 compare-and-set**（来自 `agentTeams` 的 task board） | 看板任务的每次变更；租约的原子取得与释放 |
| 6 | **结构化安全失败诊断**：阶段名（`spawn`/`run`/`teardown`）+ 退出码 + 信号，长度有界，原始错误只留内部 | 卡片进 Review 后显示人能看懂的失败原因，而不是一坨 stack trace |

另外**技术手法**上照抄一处：**进程树持有 + 分级终止升级**（见 §3.4）—— 这是 dsh 写得最扎实、也最容易自己写错的地方。

### 1.2 不借（对我们是过度设计）

- Cordis 完整插件树、profile / bundle 分层、patch 文件叠加
- 类型级 slot 插槽注册表与 props 四路合成
- 客户端 module graph、懒加载 CJS 模块表
- i18n 管线、文档生成闸门、60+ 个 verify 脚本

我们是**单一用途的应用**，不是通用 agent 框架。上面这些是「让任何人替换任何部件」的成本，我们不需要。

### 1.3 这个决定消掉的三个风险

上一版方案里最大的三个不确定性，直接没了：

- ~~dsh 是 developer preview，README 明确警告破坏性变更~~
- ~~能否 patch 掉 `ui-layout` 接管 `root` 插槽（看板没地方放）~~
- ~~不配 DeepSeek key 能否启动~~

代价：`dsh-subprocess` 的进程树管理、web 外壳、Landlock 沙箱要自己写。前者照抄手法（约 150 行），后者本来就要自己写，沙箱推迟到后期。

---

## 2. 架构

```
npx loopkanban
   └─ Node 进程
       ├─ HTTP server（127.0.0.1 + 随机端口 + token 鉴权）
       │    ├─ REST      看板 / 任务 / Run
       │    └─ SSE       /api/runs/:id/stream
       ├─ 内嵌前端静态资源
       ├─ dispatcher     常驻调度器：从 Ready 派活
       ├─ agents         AgentProvider seam：探测 + claude-cli / codex-cli / opencode-cli
       ├─ worktree       git worktree 生命周期
       ├─ subprocess     进程组 spawn + 分级终止
       └─ storage        SQLite
   └─ 自动打开浏览器 http://127.0.0.1:<port>/?token=<token>
```

```
packages/
├── core/      纯领域逻辑，无 IO：状态机、CAS、租约、调度决策 —— 可单测
├── host/      Node 侧：server / storage / subprocess / agents / worktree / dispatcher
└── web/       React + Vite + dnd-kit + Tailwind，构建产物内嵌进 host
```

### 2.1 为什么是 TypeScript / Node

上一版我推荐过 Rust + axum，理由是进程树 kill 的可靠性。现在改推 TS，因为约束变了：

- 我们现在**连整个 Web UI 也要自己写**，单人项目用一门语言的收益压过了 Rust 在进程管理上的边际优势
- 进程树终止可以收进一个约 150 行、有针对性测试的模块（§3.4），不值得让它决定整个技术栈
- `npx` 分发原生，无需 npm 预编译二进制那套
- 目标 CLI 本身就是 Node 生态

Rust 仍然可行，只是对这个项目不再是更优解。

### 2.2 三条 seam

```ts
// 1. Agent 执行器
interface AgentProvider {
  readonly id: string
  readonly command: string                        // 可执行文件名
  readonly extraDirs?: readonly string[]          // PATH 之外这家惯用的安装位置
  readonly catalogSource?: string                 // 自己列不出模型时，它在 models.dev 上叫什么
  probe(): Promise<AgentCaps | null>              // null = 本机没装
  buildStart(run: RunContext, caps: AgentCaps): SpawnSpec
  buildResume(run: RunContext, caps: AgentCaps, sessionId: string): SpawnSpec | null
  parseLine(line: string, caps: AgentCaps): readonly AgentEvent[]   // 一行可以是好几件事
}
```

接一个新 CLI = 写一个实现 + 在注册表里加一行，**别处不动**。宿主一律按
provider 声明的事实行事，不按 id 分支；真需要分支时，说明这个接口少了一个
字段，该补字段。这条约束由 `tests/agents.spec.ts` 看着。

```ts
// 2. 子进程（将来可换远程 / 容器执行）
interface Subprocess {
  spawn(spec: SpawnSpec): Promise<ProcessHandle>  // 进程组隔离
}

// 3. 存储
interface Storage { /* 域 KV + 事件日志追加 */ }
```

### 2.3 数据模型

```ts
interface Project {
  id: ProjectId
  name: string                     // 用户认得出的名字
  repoPath: string                 // 本机上的 git 仓库目录
  baseBranch: string               // 建项目时选定，默认 main / master；可后改，只影响新卡
}

interface Task {
  id: TaskId
  revision: number                 // CAS，每次变更 +1
  projectId: ProjectId
  column: 'backlog' | 'ready' | 'running' | 'review' | 'done'
  position: number
  description: string              // Markdown。卡片的全部内容，没有独立标题
  acceptance: string[]             // 验收标准 checklist，可选
  repoPath: string                 // 跟着项目走，建卡时定下，之后不由人改
  baseBranch: string
  preferredProvider?: string       // 只能选已探测到的
  model?: string                   // 指定模型；留空用该 CLI 自己的默认
  blockedBy: TaskId[]
  relatedTo: TaskId[]              // 关联的同项目卡片：引用，不是依赖
  lease?: { runId: RunId; provider: string; acquiredAt: string; expiresAt: string }
  archivedAt?: string              // 归档标记，正交于 column
}

// 卡片带着的材料：截图、PDF、Word。元数据进库，字节落在数据目录里；
// 派活时拷进 worktree 的 .loopkanban/attachments/，并在 TASK.md 里点名。
interface Attachment {
  id: string
  taskId: TaskId
  filename: string                 // 用户原来的文件名，界面与 TASK.md 里显示的都是它
  mime: string                     // 按扩展名定，客户端报什么不算数
  size: number
  path: string                     // 字节在磁盘上的绝对路径，不对前端暴露
  at: number
}

interface Run {
  id: RunId
  taskId: TaskId
  provider: string
  cliVersion: string               // 记录当次实际用的 CLI 版本
  agentSessionId?: string          // CLI 侧会话 id，用于续跑
  worktreePath: string
  branch: string
  status: 'running' | 'completed' | 'failed' | 'aborted'
  diagnostic?: FailureDiagnostic   // 结构化，见 §1.1 第 6 条
  startedAt: string
  endedAt?: string
}

// append-only，UI 从它投影，SSE 从它续传
interface RunEvent { runId: RunId; seq: number; kind: string; payload: unknown; at: string }
```

### 并发上限按执行器算，不是全局

三个 CLI 各有各的额度与速率限制，claude 排满了不该顺带把 codex 也堵住 ——
所以 `limit` 是**每个执行器**的位子数，界面上也这么写（`limit / agent`），
本机 Agent 那一栏跟着显示「占用 / 总数」。

由此带出一条调度规则：没指定执行器的卡，挑**当前跑得最少的那个**，而不是
永远取第一个。上限按执行器算之后，总取第一个会让没指定的卡全堆在 claude 上
排队，而 codex 闲着。打平时按探测顺序，结果仍然是确定的。

### 讨论取代打回

评审意见原本是任务上的一个字段：打回时写一句，下一次执行读走，然后清空。
问题在于它**只剩最后一句** —— 人第三轮说的话，Agent 看不到前两轮已经确认过
什么，于是反复推翻自己。

现在人和 Agent 的每一轮往来都记在 `task_comments` 里：Agent 跑完把「我做了
什么」写进讨论（**失败的那一轮也写**，它卡在哪儿正是最该被讨论的），人在下面
回一条。**在 Review 里留言就是「再改一版」**：卡自动回 Ready，下一次执行把整条
线程写进 TASK.md 的「讨论」一节交给 Agent。反馈因此是累积的。

所以「打回」这个动作没有了 —— 它和「留言」是同一件事，留两个入口只会让人
犹豫该点哪个。Review 里剩下的是通过、通过并合并、废弃。

界面上 Agent 的回复按 Markdown 渲染，用的是一个**不引依赖、直接产出 React
元素**的小渲染器：Agent 的输出里就算带着 `<script>` 也只是一段文本，没有注入面；
换成 `marked` + `dangerouslySetInnerHTML` 就得再配一个消毒器，那是两个依赖加
一处必须记得做对的地方。

### 附件走文件，不走 prompt

很多需求光靠打字说不清楚：一张设计稿、一份报错截图、一份要照着做的 PDF 或
Word。所以卡片可以挂附件，派活时它们跟着一起交给 CLI。

三个决定：

**拷进 worktree，不塞进 prompt。** 把图片编码进命令行既受长度限制，又要为
每家 CLI 各写一套多模态入参 —— 而三个 CLI 都会读文件。文件落在 worktree 的
`.loopkanban/attachments/` 下，TASK.md 里列出相对路径、类型和大小，prompt 再
点一次名（它是 CLI 唯一保证会读的东西）。**不点名等于没给** —— 光把文件放进
目录，Agent 多半连看都不会看一眼。

**放 `.loopkanban/` 下面是为了不进 diff。** 那条 `/.loopkanban/` 的排除规则
本来就写在仓库的 `.git/info/exclude` 里，在每个 worktree 的根上同样生效。附件
是输入不是产出，混进 patch 只会让人在一堆二进制噪音里找真正的改动，验收通过
时还会被一并提交进仓库。

**每次派活前先清空再拷。** worktree 属于任务而不是某次执行；撤回的附件若留在
那儿，Agent 下一轮还会照着一个人已经不认的文件干活。

元数据进库、字节进磁盘：几十 MB 的 PDF 塞进 SQLite 会让每一次读卡都拖着它走，
而 Agent 要的本来就是一个能打开的路径。

上传是**裸的请求体 + `x-filename` 头**，一次一个文件。手写 multipart 解析器是
这个项目最不值得的那种代码，而"零运行时依赖"这条线又不允许引一个库进来。

取回时类型按**扩展名**定（客户端报什么不算数），只有图片和 PDF 内联，其余一律
`Content-Disposition: attachment` + `nosniff`。附件与看板同源，一个能在页面里
跑起来的 HTML 附件就能拿着 cookie 调本机的执行接口。

附件跟着「正在执行的卡不能改需求」一起冻结 —— 它就是需求的一部分。

### 讨论里也能带附件

材料十有八九是在往来当中才出现的：跑完一轮才看见界面哪儿不对，这时最想做的
是贴一张截图问「这儿为什么长这样」。逼人回规格表单去传，等于让那份材料和说它
的那句话失去关系。

所以留言也能带文件，与规格附件同一张表 —— 它们本来就是同一种东西，差别只在
挂在哪儿（`comment_id`：`NULL` 是规格附件，`''` 是还没发出去的草稿，其余是那条
留言带的）。**空串这个中间态是上传先于留言逼出来的**：文件选完就传（传上去了
却因为没点发送而丢掉是最恼火的那种意外），而留言的 id 要等它真发出去才存在。

两条规矩与规格附件**刻意不同**：

**冻结管不着它。** 规格附件跟着需求一起冻，讨论里的不冻 —— 因为留言本来就不
冻：跑着的时候看见哪儿不对顺手贴张图，和顺手留一句话是同一个动作，它们一起
等下一轮被带走。

**发出去就撤不回。** 讨论是一份记录：话说出去改不了，话里带的那张图自然也不
该消失 —— 底下若还接着 Agent 的回复，抽掉它就等于让那段对话失去依据。草稿则
随时能撤。

TASK.md 里它们也不进「附件」一节，而是摆在自己那条留言底下：一张截图脱离了
说它的那句话就只是一张来历不明的图，摆进需求清单反而会被当成一条新要求。最新
那条反馈带的文件在 prompt 里再单独点一次名 —— 它多半就是这一轮要看的东西。
### 关联是引用，不是依赖

一张卡常常要参考另一张：接口是上一张定的、命名沿用那次改造、这次只是把同一件事
再做一遍。`blockedBy` 表达不了这个 —— 它是「没做完就不许开工」，而参考的对象
往往是一张**永远不会做完**的卡（一份长期的规格、一个平行推进的改造）。写下
"参考它"就等于把自己锁死，于是人只好不写，Agent 也就永远不知道那张卡的存在。

所以 `relatedTo` 与 `blockedBy` 是两个字段：前者不拦调度、不影响流转，只在派活时
把那几张卡**连正文一起**展开进 TASK.md 的「关联任务」一节，并在 prompt 里再点一次名。

三条边界：

- **只能同项目**。任务在这个项目派生的 worktree 里干活，指向另一个仓库里的卡，
  Agent 既读不到也用不上 —— 而它照样会被写进规格，变成一段没法照做的需求。
  这条约束要看别的卡，领域层看不见，所以由 server / MCP 在存下来之前把关。
- **写进规格的是此刻的库，不是建卡时的快照**。参考的那张卡改过需求、跑完进了
  Done，这次执行看到的就该是新的样子。
- **删卡时两种引用一起摘**（`dropReferences`）。悬空的依赖会让下游永远停在
  "依赖未完成"；悬空的关联更糟 —— 它是一段指向不存在之物的需求，Agent 只能去猜。

规格里还要**明写它们的身份**：只给一串 id 等于没给（Agent 查不到那张卡长什么样），
而不声明"这是参考、不是这次的活"，它会顺手把参考资料里的验收标准也一并做掉。

### 卡片没有标题

一句话的活写一句话，复杂的活写一段 —— 逼人先起个标题只是多一道手续，而
多数标题最后就是描述第一行的复读。要显示"叫什么"的地方（列表、分支名、
提交信息、桌面通知）一律取描述的第一行，截断到 60 字；一个字都没写就退回
任务 id，空白的分支名比丑的更糟。列表里超过两行用省略号收住。

**验收标准是可选的**。有判据当然更好（Agent 照着做，人照着验），但强制它
等于给每张卡都加一道门槛，而很多活的判据就是"跑起来对不对"。原先卡在
「进 Ready」和「打回」两处的守卫因此一并撤掉。

### 指定执行器之后还能指定模型

模型名是各家 CLI 自己的说法，不通用，所以这一栏只在选定执行器后出现，
且**先探测再展示**：`--model` / `-m` 在那个版本的 help 里存在才给填，
否则界面上直接说"这个版本没有这个参数"，而不是让人填完再被运行时拒绝。

模型清单也是**探测**来的，不是写死的，各 CLI 能给多少就用多少：

- `opencode models` 是真正的枚举命令，本机实测 122 条，探测时跑一次（~0.7s）。
- claude 没有这种命令，但它把可用别名写在 `--model` 的帮助文本里
  （「e.g. 'opus', 'sonnet'」），从那段原文里捞 —— 措辞变了最多是捞不到，
  退回自由输入，不会给出过期的错答案。为此 help 解析器开始留存参数块原文。
- codex 两样都没有 —— 它的清单来自 models.dev。

claude 与 codex 另外从 **models.dev** 补一份完整型号（那是一份公开的模型目录，
opencode 自己也用它）：输出不含文本的（嵌入、画图）和不支持工具调用的一概不列 ——
Agent 没有工具寸步难行；按发布日期倒序，新的排前面。CLI 自己报的排在最前，
它才是那个版本当下认的写法。

这是 LoopKanban **唯一**的对外请求，别处只连 127.0.0.1，所以给了它三条底线：
一天最多取一次、结果落在数据目录里、`--no-models` 可以彻底关掉。取不到不是
错误 —— 离线、超时、对方改了格式，一律退回已有缓存（过期的也比空的强，模型名
不会一夜之间全变）或空清单。

界面上只能**选**、不能填：能选的都是探测出来的，手打一个 CLI 不认的名字只会
在派活那一刻才炸。不选就是「默认模型」，那时我们一个 `--model` 都不传，
由 CLI 自己做主。卡上原有的模型即使不在当前清单里也留在下拉里 —— 清单会随
CLI 升级、随 models.dev 变，不该因为它变了就把一张老卡的选择悄悄抹掉。

### 项目与 worktree 的归属

**项目就是一个 git 仓库目录**，任务挂在它下面；界面上只有「概览」（所有项目
的卡）与逐个项目两种视角，没有"多个看板"这个中间概念 —— 它不对应任何真实
的东西，只是多一层要维护的名字。

**worktree 属于任务，不属于某次执行、更不属于某个 Agent**：位置固定在
`<项目目录>/.loopkanban/worktrees/<taskId>`，取用是幂等的 —— 目录在就直接用，
分支在就挂回去。打回重做、换个 CLI 接着干、跨进程重启，看到的都是同一个工作区
里上一次的成果，而不是在空目录里对着评审意见发懵。

放进项目目录（而不是数据目录）是为了让 Agent 的工作区和它要改的代码待在一起，
代价是主仓库会多出一坨未跟踪文件 —— 而"主工作区是否干净"正是合并前的硬前置
条件。所以建第一个 worktree 时会把 `/.loopkanban/` 写进 `.git/info/exclude`：
那是仓库的本地排除表，不是用户的 `.gitignore`，我们不该动用户的文件。

写入范围（`writeScopes`，建议性的路径前缀预警）随之退场：每个任务本来就在
自己的 worktree 里，冲突推迟到合并时由 git 判定，比前缀猜测准确得多。

### 2.4 看板流转

```
Backlog ──▶ Ready ──▶ Running ──▶ Review ──▶ Done
   ▲        (可认领)   (CLI执行中)  (人工验收)  (通过)
   │                                 │  │
   │            打回 · 带评审意见 ◀────┘  │
   └──────────────── 废弃 · 删分支 ◀─────┘

   归档 ⇄ 取出：任意列（running 除外）上的开关，不改变所在列
```

- **Ready** 是队列，进入要求验收标准非空
- **Ready → Running** 必须 CAS 取得租约（`runId` + `expiresAt`），防重复认领；崩溃后租约超时自动回退
- **归档是标记，不是列**。`archivedAt` 与 `column` 正交：归档不改变卡在哪一列，取出就回到原位。做成第六列的话，它既要能从每一列进来、又要能回到原来那一列，状态机会被这一个动作撑破；而且列是可见的，归档的意义恰恰是不可见。归档的卡**冻结**：移不动、改不了、不会被自动认领（否则用户看不见的地方有 Agent 在改仓库）；正在执行的卡不能归档，要搁置先终止。归档一张已完成的卡不影响它作为依赖的效力
- **删除只开在 Backlog 与 Ready**。想法池里写废的点子、队列里重排进去的活，攒着只会让看板越来越难扫，而归档不解决这个问题 —— 归档是给"以后可能还要"准备的。再往后每一列都意味着 Agent 已经动过仓库（running 有活着的进程，review 有等着判读的 diff，done 是审计记录），删掉它们等于让"发生过什么"无从追溯；要删一张跑过的卡，先废弃回想法池。删除连同 `Run` 与 `RunEvent` 一并抹掉（`run_events` 只插不改不删的唯一例外：整张卡都没了，留着指向空 `taskId` 的事件只是垃圾），并删掉它留下的分支与 worktree；下游 `blockedBy` 里对它的引用在同一个事务里摘掉 —— 留着一个查无此卡的 id，那些卡会永远停在"依赖未完成"且无从解开。归档的卡可以直接删，不必先取出来
- **Done 按完成时间从新到旧排，其余列按 `position`**。`position` 是给调度用的：它决定自动驾驶下一个派谁，所以那几列由人拖着排。Done 里没有"下一个"，卡进去时带着的 `position` 只是它当初在 Review 里排队的残值，拿它当完成清单的顺序毫无意义 —— 刚做完的那张才是最该看见的。排序键是 `doneAt`（跨进 Done 的那一次写入，之后不再变），不是 `updatedAt`：Done 是终点但卡片仍会被动，归档一下就能把一张半年前的卡顶到队首。也因此 Done 的卡不可拖动 —— 那一列本来就没有出口，顺序也不再由人定
- **没有 Failed 列**。`Running` 的唯一出口是 `Review` —— 成功和失败都过人眼。失败的那次执行同样有分支、日志和结构化诊断要判读，判读完的动作（打回重跑 / 废弃回想法池）和验收完全一样；单开一列只会攒下一堆没人再看的死卡。失败仍然记在 `Run.status` 上，成功率统计照旧

---

## 3. CLI Provider（核心）

### 3.1 不绑定版本：探测 + 能力降级

**原则：有哪个用哪个，有什么能力用什么能力。** 不钉死版本，也因此不能硬假设参数存在。

#### 发现可执行文件

按序尝试，第一个命中即用：

1. 设置页填的显式绝对路径
2. `PATH` 上的 `claude` / `codex` / `opencode`
3. 常见安装位置兜底：`~/.local/bin`、`~/.claude/local`、Homebrew 前缀、`~/.codex/bin`、`~/.opencode/bin`

> 兜底不是多余：本机的 `claude` 就在 `~/.local/bin/claude`，而 macOS 上从桌面启动器（非终端）拉起的进程往往拿不到这个 `PATH`。

#### 探测能力矩阵

对命中的可执行文件跑 `--version` 和 `--help`，解析出能力，**不做版本号判断**。`--help` 是可解析的：`claude` 打印 `--permission-mode ... (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")`，`codex` 打印 `-s, --sandbox ... [possible values: read-only, workspace-write, danger-full-access]`，`opencode` 打印 `--format ... [choices: "default", "json"]`（yargs 又是第三种写法，三种都要认）。

| 能力 | 探测方式 | 有 | 无 → 降级 |
|---|---|---|---|
| 流式日志 | `--output-format` 是否列出 `stream-json` | 逐事件推 SSE，实时看 Agent 干活 | 退 `--output-format json`（结束时一条）；再退纯 `text` |
| 会话身份 | 是否有 `--session-id` | 预生成 UUID，身份由我们掌握 | 从输出里捞 `session_id`；捞不到则本 Run 标记「不可续跑」 |
| 续跑 | `--resume` / `codex exec resume` | 打回重做走真续跑 | 打回时把上轮 diff + 意见拼成新任务，UI 明确标注「非续跑」 |
| 结构化完成 | codex `-o` / `--output-schema` | 读文件判定完成 | 退回「退出码 + 最后一条 assistant 消息」 |
| 权限档位 | 解析候选值列表 | 精确映射到 §4 三档 | **只暴露该版本真支持的档位，UI 上灰掉其余** |

**探测结果决定 UI 里能选什么。** 不支持的能力界面上就是灰的，绝不运行时才失败（借鉴 §1.1 第 3 条）。设置页展示每个 CLI 的路径 / 版本 / 能力清单 + 「重新探测」按钮；探测结果带可执行文件的 mtime + size 指纹，变了自动重探。

一个 CLI 没装 → 不注册该 provider，任务选不到它。两个都没装 → 启动时明确报错并指引安装，而不是让任务卡在 Running。

### 3.2 参数基线

> 已在本机实测核实（`claude 2.1.241` / `codex-cli 0.149.1`）。实际 argv 由能力矩阵拼装，不写死。

`claude-cli` 首次执行：

```
claude -p
  --output-format stream-json
  --verbose                              # -p + stream-json 时必需
  --session-id <我们生成的 UUID>
  --permission-mode <见 §4>
  [--model <可选>] [--include-partial-messages]
  <prompt>
```

续跑：`claude -p --output-format stream-json --verbose --resume <id> [--fork-session] "<评审意见>"`

`codex-cli` 首次执行：

```
codex exec
  --json                                 # 事件以 JSONL 打到 stdout
  -C <worktree>
  -s <read-only|workspace-write|danger-full-access>
  [--approve-for-me]
  -o <run目录>/last-message.txt          # 最终回答落文件，完成判定不用猜
  [--output-schema <schema.json>]
  <prompt>
```

续跑：`codex exec resume <session-id> --json -C <worktree> "<评审意见>"`（另有 `codex exec fork <id>`）

`opencode-cli` 首次执行：

```
opencode run
  --format json                          # 事件以 JSONL 打到 stdout
  --auto                                 # 硬性前提：不给它，写文件的权限询问会把整个 Run 挂死
  --dir <worktree>
  [-m <provider/model>]
  -- <prompt>                            # 位置参数，必须用 -- 隔开
```

续跑：`opencode run --format json --auto --dir <worktree> -s <session-id> -- "<评审意见>"` —— 和首次执行是**同一条命令**，只多一个 `-s`，所以不像 codex 那样要单独探测续跑的参数面。

**三个都不要加 `--no-session-persistence` / `--ephemeral`** —— 会话必须落盘才能续跑。

### 3.3 续跑是个真收益

`claude --session-id` 让我们**预先掌握会话 UUID**，不用解析输出去捞；`codex exec resume/fork` 直接按 id 续；`opencode run -s <id>` 同理，会话 id 从事件里捞（它的 `sessionID` 每条事件都带）。Review 里的「打回重做」是真正的会话延续，不是重新拼 prompt。

### 3.4 进程树持有与分级终止（照抄 dsh 手法）

自己写最容易错的地方，规格写死：

- **Unix**：`spawn(..., { detached: true })` 让子进程自成进程组；终止时 `process.kill(-pid, 'SIGTERM')` 打整组 → 等 grace（默认 3s）→ `SIGKILL` → **等待整棵树退出后才宣告终止完成**
- **Windows**：Job Object，或退而用 `taskkill /pid <pid> /T /F`
- `dispose()` 必须幂等
- 取消信号在「进程已起但 Run 未发布」这个窗口内到达时，先清理再拒绝 —— 这个竞态是 bug 高发区
- 应用启动时对账：扫描记录的 pid，清理上次崩溃留下的孤儿进程与 worktree

### 3.5 事件解析

stdout 逐行解析成统一的 `AgentEvent`（`Text` / `ToolUse` / `Usage` / `Finished`）。**解析失败降级为纯文本日志，绝不影响执行** —— CLI 输出格式会变，解析器不能是单点故障。原始输出同时落盘 `runs/<run_id>.log`。

---

## 4. 安全

### 权限档位映射

| LoopKanban 档位 | `claude` | `codex` | `opencode` |
|---|---|---|---|
| `strict` | `--permission-mode dontAsk` | `-s read-only` | **不支持**：不上报该档，真被要求时**拒绝执行** |
| `standard`（默认） | `--permission-mode auto` | `--approve-for-me`（隐含 workspace-write，**不可同时传 `-s`**） | `--auto` |
| `yolo`（二次确认 + 常驻警告横幅） | `--permission-mode bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` | `--auto`（它只有这一个开关） |

> **已实测定稿**：`standard` 必须用 `auto` 而不是 `acceptEdits` —— 后者只放行文件编辑，Bash 一律 `permission_denied`，Agent 写完代码跑不了测试也跑不了构建，等于交出一份没验证过的活。`auto` 走 CLI 原生分类器，语义上才对得上 codex 的 `--approve-for-me`。`manual` 会挂起等人，不适合无人值守。
> 每档按偏好列表取该版本支持的第一个（`standard` = `auto` → `acceptEdits`），**只显示探测到确实支持的档位**。

> **档位不支持时怎么办，opencode 逼出了一条新规矩。** 另外两家的降级方式是「探测不到就不传这个参数，交给 CLI 自己的默认值」——
> 对它们成立，因为默认值只会更严。opencode 不行：少了 `--auto` 不是变严格，而是**永远挂住**。于是只剩两条路，要么按
> `--auto` 跑（`strict` 就成了它的反面，而且没人知道），要么明确失败。**悄悄升权比一次看得见的失败糟糕得多**，所以
> `buildStart` / `buildResume` 在档位不受支持时直接抛错：卡片回到 Review 等人判读，诊断里写清楚为什么、该改派给谁。
>
> **「支持某档」和「这档到底关不关得住」是两件事。** 同样是 `standard`，codex 被关进 workspace-write 沙箱、claude 走权限
> 分类器，而 opencode 两者都没有 —— 只报档位名字，用户就会按别家的经验去理解它。为此 `AgentCaps` 多了一个
> `permissionCaveat`（短标签 + 展开说明），由 provider 声明、经 `/api/agents` 原样传到界面：启动横幅、顶部 CLI 条、
> 派活按钮、「指定执行器」选择器四处都会显示「无沙箱」并在悬停时给出完整事实。藏在文档里的警告等于没有警告。

### 其他

1. **worktree 隔离**，Agent 不在主工作区跑，跑飞了删分支即可
2. **零 API Key**：LoopKanban 不接受、不存储、不传递任何 key；认证全靠 CLI 自身登录态。`claude` 默认加载 user/project/local 设置，所以你的 `CLAUDE.md`、MCP server、权限配置都生效
3. **禁止自动 push / 开 PR**（v1）
4. **本地 server 加固（P0）**：只 bind `127.0.0.1`，**绝不 `0.0.0.0`**（远程走 SSH 端口转发）；启动生成一次性随机 token，URL 携带后转 httpOnly cookie，REST 与 SSE 都校验；**校验 `Origin`/`Host` 防 DNS rebinding**（否则任意网页都能打你的 localhost 去起 Agent）；随机端口。这是相对桌面应用多出来的攻击面 —— **一个能执行任意代码的 HTTP 接口**，M1 就要做对
5. **注入防护**：任务描述、附件、Agent 输出都是数据不是指令

---

## 5. 里程碑

| 阶段 | 内容 | 产出判据 |
|---|---|---|
| **M0 编排穿刺**（纯脚本，无 UI）✅ **已完成** | `subprocess` 进程组模块 + 终止测试；`claude-cli` 探测与启动；解析 stream-json；worktree 创建；跑通一个任务 | **命令行能让本机 `claude` 在独立分支上做完一张卡，并能随时 kill 干净**。项目最大技术风险在此关掉 |
| **M1 单任务闭环** ✅ **已完成** | SQLite + 事件日志；board CAS；HTTP server + token 鉴权 + Origin 校验；SSE 日志流；最简看板视图；`codex-cli` provider | 浏览器里点一下，实时看着 Agent 干完 |
| **M2 验收闭环** ✅ **已完成** | Diff 查看、合并 / 打回 / 废弃；**打回走真续跑**；权限档位定稿 | 完整走完 Ready→Done，打回能接着上次改 |
| **M3 自动驾驶**（核心卖点）✅ **已完成** | 调度器、租约与超时回收、并发上限、依赖阻塞、孤儿进程与 worktree 对账、崩溃恢复、浏览器通知 | 扔 5 张卡进 Ready，关掉浏览器去睡觉，回来全在 Review |
| **M4 体验** ✅ **已完成** | 拖拽排序、任务模板、`writeScopes` 冲突预警、Runs 统计与成本 | 日常可用 |
| **M5 分发** ✅ **已完成** | `npx loopkanban` 一行启动；`service install` 装 launchd/systemd 常驻；文档 | 别人能装上用 |

---

## 5.1 M0 实测结论（已完成）

穿刺脚本 `packages/host/src/bin/m0.ts`，40 个测试全绿。判据全部通过：探测 CLI → 建 worktree → 起子进程 → 解析事件流 → 进程树静默 → Agent 真的改了文件。

### 本机探测结果

| | claude | codex |
|---|---|---|
| 路径 | `~/.local/bin/claude` | `~/.local/bin/codex` |
| 版本 | 2.1.241 | 0.149.1 |
| 流式输出 | ✅ `stream-json` | ✅ `--json` JSONL |
| 指定会话 id | ✅ `--session-id` | ❌ 只能从 `thread.started` 捞 |
| 续跑 | ✅ `--resume` | ✅ `exec resume` 子命令 |
| 权限档位 | strict/standard/yolo | strict/standard/yolo |

两个 CLI 都装在 `~/.local/bin` —— **验证了兜底查找路径的必要性**，只靠桌面启动器的 `PATH` 会找不到。

穿刺期间两个 CLI 都被升级过（claude 2.1.241→2.1.247，codex 0.149.1→0.150.1），**不绑版本 + 探测能力**的设计原地照常工作，没有任何改动 —— 这条设计决策当场得到了验证。

### 零 API Key 得到硬证据

claude 在 `init` 事件里自报 **`apiKeySource: "none"`**，全靠 OAuth 登录态。已做成 `session` 事件字段，不是 `none` 就告警。

### 实测踩出来的坑（文档里都没有）

1. **进程树终止只等组长是不够的**。组长可能秒退却留下孙进程（Agent 跑完但 dev server 还在）。算法改为 SIGTERM → 等**整棵树**(grace) → SIGKILL → 再等树。
2. **claude 的 `subtype: "success"` 可以伴随 `is_error: true`**（鉴权失败时实测到）。完成判定只能看 `is_error`，信 subtype 会把失败误判成成功。
3. **claude 的 `type: system` 有多种 subtype**（`init` / `api_retry` / `hook_started` / `hook_response`），只有 `init` 是会话建立。按 `session_id` 存在与否判断会把同一会话重复上报四次。
4. **codex 的 `--sandbox` 与 `--approve-for-me` 互斥** —— 后者自己就隐含 workspace-write，同时传会被 clap 直接拒绝（exit 2）。

第 4 条还暴露出一个工程教训：**stderr 必须有人读**。当时 stderr 设了 `pipe` 却没人消费，一个 exit=2 的硬失败在界面上完全看不见，只看到"10ms 就结束了"。

5. **`claude auth status` 的 `loggedIn: true` 不代表凭证还新鲜**。它只说明磁盘上存在凭证。用桌面版 Claude Code 的用户，宿主在内存里持有并刷新 token，而 CLI 独立跑时用的磁盘凭证可能早已过期且自己刷新不了 —— 表现为 401 `OAuth access token has expired`。**LoopKanban 必须在探测阶段做一次真实的轻量调用来验活，不能只信 `auth status`**，否则用户会看着"已登录"却每张卡都失败。

6. **opencode 不给 `--auto` 会永远挂住**。`opencode run` 在非交互模式下遇到写文件仍然发出权限询问，没人回答就一直等 —— 实测跑满 7 分钟，stdout 一个字节都没有（同一条命令换成只读提示词则 10 秒内正常收尾，证明不是模型慢）。无人值守场景下这是最坏的结局：卡片停在 Running 直到 30 分钟超时。所以 `--auto` 被当成**探测期的硬性前提**，`opencode run --help` 里没有它就当这个 CLI 没装，让它在探测期失败而不是运行期挂死。这也是「不支持的能力当场灰掉」这条原则第一次救了一个**会挂住**而不只是会报错的场景。

7. **opencode 的 `sessionID` 挂在每一条事件上**，没有 codex `thread.started` 那种"会话已建立"的独立事件。照直上报会把面板刷满同一个 id（实测一次三步的任务就重复三次）。去重放在 Runner 而不是 provider 里 —— provider 是跨 Run 共享的单例，存不了状态；而且按**整条负载**比对而不是只比 id，免得把 claude 那条额外带 `apiKeySource` 的 `init` 事件误当重复吞掉。

8. **opencode 成功那条路径上没有终态事件**。最后只有 `step_finish`，完成与否只能靠退出码（失败则有独立的 `error` 事件可给结构化诊断）。Runner 本来就是 `finished ?? exit === 0`，正好接得住 —— 这条 seam 当初留对了。

9. **提示词必须用 `--` 隔开**。opencode 的提示词是 yargs 的位置参数，以 `-` 开头的一行（评审意见里很常见）会被当成参数解析掉。

10. **opencode 没有"工具进行中"事件**。实测 1.18.23 只在 `completed` 时报一次 `tool_use`，跑 12 秒的 `bash` 也一样 —— 不像 codex 有 `item.started`。所以长命令期间事件流是静的，界面上会有一段看着像卡死的空窗。provider 里留了处理进行中状态的分支，但那是前向兼容，今天不会触发。

### 环境清洗（`agents/env.ts`，P0）

排查上一条时发现宿主环境里带着 20 个父会话变量（`CLAUDE_CODE_SESSION_ID`、`CLAUDE_CODE_MESSAGING_TOKEN`、`CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH` …）和 `ANTHROPIC_BASE_URL`。两个后果：

- **凭证泄漏破坏「零 API Key」**：环境里若有 `ANTHROPIC_API_KEY`，子 CLI 会直接拿去用，绕过用户自己的登录态。
- **父会话身份污染**：LoopKanban 很可能本身就跑在某个 Agent 会话里（开发时就是），子 CLI 会误以为自己是那个会话的子代、鉴权由宿主代管。

因此起子进程前一律清洗：凭证形变量（`API_KEY`/`AUTH_TOKEN`/`SECRET`/`PASSWORD`/`CREDENTIAL`）与父会话前缀（`CLAUDE_CODE_`/`CLAUDE_AGENT_`/`CLAUDECODE`…）全部剔除；端点类变量（`BASE_URL`/`PROXY`）保留但如实上报变量名。**确实要传给子进程的东西只能走显式配置这一条通道。** 上报只报名字，绝不报值。

### 权限档位实测：两个 CLI 的「standard」曾经不对等

第一次跑 claude 用 `acceptEdits`，Agent 写完 `greet.js` 后想跑 `node --test` 验证，被 `permission_denied` 拒了，最后自己说「测试尚未实际执行过」。同样的任务 codex 用 `--approve-for-me` 则真的跑了测试并确认通过。

改成 `auto` 后 claude 也能跑测试了，两边行为对齐。**教训：权限档位的语义必须实测，不能照字面映射** —— 一个不能执行命令的编码 Agent 交出的是没验证过的代码。

顺带补上了两个原先当噪音丢掉的事件：

- `system/permission_denied` → `notice(warn)`。这是解释「Agent 为什么没干完」的**唯一线索**，丢了就只能看着一份半成品发懵。
- `rate_limit_event` → `notice`。带 `rateLimitType`（如 `five_hour`）和 `resetsAt`，对自动驾驶下的额度预算很有用。

### 真实事件 schema（已存为测试固件）

```
claude stream-json          codex --json
─────────────────────       ─────────────────────
system/init    → session    thread.started  → session（thread_id）
system/api_retry → notice   turn.started
assistant      → text/tool  item.completed/agent_message → text
result         → finished   item.completed/file_change   → tool
                            item.completed/command_execution → tool
                            turn.completed  → usage
```

## 5.2 M1 / M2 实测结论

### 又一批文档里没有的坑

6. **`codex exec resume` 的参数面和 `codex exec` 不一样** —— 它没有 `--cd`、
   `--sandbox`、`--approve-for-me`、`--add-dir`。照搬主命令的参数会被 clap
   直接拒绝（exit 2）。**能力探测必须按每条命令分别做**，这是「探测而不是假设」
   原则在更细粒度上的同一条道理。
7. **`node --experimental-strip-types` 不支持参数属性 / enum / namespace /
   装饰器**。vitest 用 esbuild 能编过，运行时才炸 —— 类型检查和单测都拦不住。
   这是「不要构建步骤」的代价，得全项目遵守。

### 用起来才发现的三个设计错误

- **评审意见在交给 Agent 的瞬间就被清掉**。那一轮如果失败，人写的意见凭空
  消失，重新派活时 Agent 又从头做一遍同样的活。改成**跑出可验收结果之后才清**。
- **每次重启换新 token**，用户开着的标签页立刻失效、书签永远过期，而开发时
  会频繁重启。token 持久化到数据目录（0600），`--new-token` 主动轮换。
- **拉 Run 列表的 effect 只依赖 `task.id`**。派活后 id 不变，effect 不重跑，
  刚创建的 Run 永远拉不到，事件流一直空着。改成依赖 `revision`。

### 验收的核心决策：默认绝不动主工作区

「通过」只做三件事：把改动提交到任务分支、移除 worktree、**保留分支**。
用户拿到分支名自己决定合并还是开 PR。

自动 merge 进一个可能是脏的、可能停在别的分支上的主工作区，是这个工具最容易
造成破坏性意外的地方。`merge: true` 是显式选项，且前置条件（工作区干净 +
停在基线分支）不满足就**明确拒绝而不是勉强执行** —— 改动已经提交在分支上不会丢，
但必须如实告诉用户没合上，否则他会以为已经进主干了。

### 流转规则的收紧边界

收紧的目标只有两个：**不许跳过认领**（否则「租约属于谁」无法推理）、
**不许跳过验收**（否则等于让 Agent 自己给自己盖章）。除此之外的移动都是
无租约状态之间的整理动作，一律放行 —— `review → backlog`（废弃成果、重新想
需求）就是被测试问出来后放开的。

`running → ready` 是唯一的例外：它是系统回收租约的专属通道
（`reclaimIfExpired`），人不能走。Runner 里我一度错用了通用的 `moveTask`，
被测试当场抓住。

---

## 5.3 M3 实测结论

扔 3 张卡进 Ready、打开开关、什么都不做 —— 并发 2 卡住第三张，前两张一完成它
自己接上，最后三张全在 Review。产出 28 个测试全过，主工作区一动没动。

### 默认值的一次惊吓

首次跑自动驾驶时它立刻派出了**种子示例卡**。那些卡的需求跟用户的仓库毫无关系，
Agent 只会对着陌生代码做一堆牛头不对马嘴的活。原因是示例卡被放在了 Ready 列。

已改成全部落 Backlog。**默认值不该有这种惊吓** —— 尤其是一个会自动改代码的
工具，它的默认状态必须是"什么都不做"。同理，`autopilot` 默认关闭：让 Agent
无人值守动代码，得由人明确点头。

### 调度器的两条硬要求

- **不做静默截断**。每一轮的跳过原因都留给界面读，直接写在卡片上。用户问
  "我的卡为什么不动"，界面上就写着"全局并发已满 (2)"。
- **关着也照样回收**。崩溃留下的卡片必须回 Ready，这跟用不用自动驾驶无关；
  所以回收在开关判断**之前**执行。

另外并发上限被夹到至少 1：设成 0 会让调度器静悄悄地什么都不做，那比报错更难查。

---

## 5.4 M4 实测结论

### 一个一直没被发现的硬缺口

做到 M4 才意识到：**界面上根本没法建卡和改卡** —— M0 到 M3 我一路都在用 curl。
种子卡上写着「把这张卡补上验收标准」，可界面上补不了。功能一直在往前推，
而"能不能真的用起来"这条线被漏掉了。

补上了任务编辑器（标题 / 描述 / 验收标准清单 / 指定执行器 / 写入范围）与
Backlog 列头的新建入口。两条领域层守卫：

- **正在执行的卡片不能改需求**。Agent 已经拿着 TASK.md 在干活，此刻改需求
  只会让人和机器对着两份不同的规格，产出无从验收。要改先终止。
- **队列中的卡不能清空验收标准**，那会让它变成一张无法验收的活卡；要清就先
  移回 Backlog。

### 列内排序不只是美观

`position` 决定自动驾驶的派发顺序，所以列内拖动**就是在调优先级**。
position 是浮点数，插入两卡之间取中点，一次拖动只写一条记录，不必重排整列，
CAS 冲突面也最小。

### 统计里的一处诚实

成本标的是「**已知成本**」而不是「成本」：claude 会在 `result` 事件里报
`total_cost_usd`，codex 不报。标成「成本」会让人以为那是全部开销。
同理，中位耗时用中位数而非平均值 —— 一次超时会把平均值拉得没法看；
没有已结束的 Run 时返回 `null` 而不是 0，「没数据」和「耗时为 0」不是一回事。

---

## 5.5 M5 实测结论

`npm pack` → 装进干净目录 → 跑通完整任务链路：**148 KB、8 个文件、零运行时依赖**。

### 发布版必须编译，开发版不必

`bin` 的 shebang 里没法可靠地塞进 `--experimental-strip-types`，要求每个用户
自己带这个 flag 也不现实。所以发布版用 esbuild 打成单文件 JS（102 KB，
`node:*` 内置模块外置，其余全部内联），而开发时仍然直接跑 TS、没有构建步骤。

由此前端产物目录要认两种布局：开发时在 `packages/web/dist`，发布后在
`dist/web`。找不到时**明说"本次只提供 API"**，而不是装作正常然后甩给用户
一个 404 白页。

### 改用户机器上的常驻配置，不该在他看不见的地方发生

`loopkanban service install` 会写 launchd plist（macOS）或 systemd user unit
（Linux）——都是**用户级**，不碰系统目录，不需要 sudo。

装和卸都会先把单元文件内容与将要执行的命令原样打印出来，另有
`service print` 只预览不改动。

---

## 5.6 一次完整代码评审的产出

对整条分支（14,530 行 / 81 文件）做了一次通读评审，10 条发现全部修复并各自补了回归测试。

### 三条会真出事的

1. **`consume()` 无 try/finally** —— stdout 出错或落库失败时跳过 `clearActive`，
   而 `reclaimExpired` 恰好会跳过 `active` 里的任务：**卡片永久停在 Running，
   子进程也从未终止**。
2. **静态资源越界检查硬编码 `/`** —— Windows 上路径是反斜杠，每个资源都被
   判为越界并回落到 index.html，**前端完全打不开**。改用 `path.relative`。
3. **拖到自己身上会跳到列首** —— `findIndex` 返回 -1 落入 `index <= 0` 分支。
   position 决定自动认领的派发顺序，一次微小误拖就静默改了优先级。

### 修 bug 时暴露出的设计错误

修第 1 条时，我在异常处理里调用了 `emit`，而 `emit` 正是当时坏掉的东西 ——
测试立刻抓到未处理拒绝。这逼出一个更根本的判断：**一条事件写不进去就杀掉整次
执行，比丢一条日志糟得多**。`emit` 因此改成尽力而为、绝不抛出，异常处理路径
才不会引发二次故障。

### 顺序问题：不可逆操作必须排在 CAS 之后

`accept`/`discard` 原本先删 worktree 再做 CAS。冲突时 worktree 已经没了、卡还在
Review，用户按提示重试会在不存在的目录上跑 git 直接 500 —— **这张卡再也走不出
Review**。改成 CAS 先落定，删除只是收拾场地，失败也不影响验收结果。

### 其余

- 凭证清洗漏掉裸的 `*_TOKEN`（`GITHUB_TOKEN`/`NPM_TOKEN`…）。改成按下划线
  **分段**匹配，既覆盖它们又不误伤 `TOKENIZERS_PARALLELISM`。
- `launch` 在 `createRun` 之后失败会留下永远 running 的 Run 记录。
- 主动取消被记成 `failed`，而 `aborted` 这个值一直闲置着 —— 用户自己按的停止
  不该拉低成功率。
- 非法 JSON 返回 500 而非 400；兜底分支还把内部异常原文（可能含文件路径）
  回给了调用方。
- stderr 缓冲按块数而非字节数设限，实际上限约 128MB。
- 调度器重入保护让 PATCH 拿到上一轮的陈旧报告 —— 恰恰是用户最想立刻看到反馈的
  时刻。改成轮次串行，节拍侧仍然"忙就跳过"。

---

---

## 6. MCP：把看板交给 Agent

`loopkanban mcp` 起一个 stdio 上的 MCP server，接到 Claude Code / Codex 之类的
客户端上：

```bash
claude mcp add loopkanban -- loopkanban mcp
```

它**不直接开数据库，而是连正在跑的那个看板**（HTTP + token）。直连 SQLite 看着
更省事，但派活要 Runner —— worktree、子进程、租约续期都在它手上，而 Runner 只活
在看板那个进程里。两个进程各写一份状态的话，CAS 还在、事件总线却不在，界面上会
看到一张自己动起来的卡。

端口默认是随机的，而 MCP server 是被客户端悄悄拉起来的另一个进程，没人给它传参。
所以看板启动时把地址写进 `<dataDir>/endpoint.json`，关站时删掉；**token 不写进去**
—— 它已经在同一个目录的 `token` 文件里（0600），同一份秘密存两处只是多一个会对不上
的地方。

工具的取舍只有一条线：**Agent 能推动卡片，但不能给自己盖章。**

| 给 | 不给 |
|---|---|
| `list_projects` / `list_agents` / `list_tasks` / `get_task` | `accept`（验收通过） |
| `create_task` / `update_task` / `comment_task` | `discard`（废弃成果） |
| `move_task`（只在 backlog ⇄ ready 之间） | `move_task → done` |
| `claim_task` / `run_status` / `cancel_run` | `move_task → running`（那要租约，走 claim_task） |

领域层专门堵死了 `running → done`，就是不让干活的人自己判定活干完了；把 accept
接到 MCP 上等于给这道门配一把从里面开的钥匙。`move_task` 同理要挡住 `running`：
领域层其实允许 `ready → running`（那是给认领留的入口），但从 MCP 搬过去会造出一张
**没有租约的"运行中"卡** —— 看着在跑，实际没有任何进程，直到回收器把它拽回队列。

两条实现上的取舍：

- **协议自己写，不引 SDK**。stdio 传输就是一行一条 JSON-RPC，加上握手、列工具、
  调工具三件事；"零运行时依赖"是这个项目的分发前提，为三件事引一棵依赖树不划算。
- **工具失败不是协议失败**。看板拒绝一次调用（卡在跑、revision 冲突、关联跨了项目）
  要作为 `isError` 的**内容**回过去，把原因原样带上。回 JSON-RPC error 的话，多数
  客户端只显示一句 "tool failed"，Agent 连原因都看不到，只会原样重试。

轮询用的 `GET /api/runs/:id/log` 与 SSE 同源同数据，游标也是同一个（`after` 对应
`Last-Event-ID`）：浏览器开着面板适合推，而一次问一句的 Agent 不该抱着一条永远不
结束的响应。

---

## 7. 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| **不绑定版本 → 参数在某版本上不存在** | 起不来或行为不对 | §3.1 探测 + 能力降级；不支持的档位 UI 灰掉，绝不运行时才失败 |
| **CLI 输出格式变化**（codex 的 `--json` 仍是 experimental 别名） | 解析失败 | 解析失败降级纯文本，不影响执行；完成判定优先用 `-o` 文件和退出码这类稳定信号 |
| **进程树 kill 写错** | 孤儿进程、烧钱、资源泄漏 | §3.4 规格写死；针对性测试（起会 fork 子进程的任务再 kill）；启动时对账清理 |
| **本地 HTTP 接口能执行任意代码** | 安全事故 | §4 第 4 条，M1 就做对 |
| 并行 Agent 冲突 | 合并地狱 | worktree 隔离 + 同仓库并发上限 + `blockedBy`，冲突推迟到合并时交给 git |
| Agent 跑飞 / 死循环 | 烧钱、占资源 | 超时终止、可随时 kill |
| 自己实现 = 工作量比借 dsh 大 | 周期变长 | 只借六个模式不借框架，砍掉 Cordis / slot / i18n 那套；沙箱推迟 |

---

## 8. 后续方向

- MCP 侧的 `ask_human`：Agent 中途卡住时主动问一句，而不是猜着做完再被打回
- 沙箱加固（Linux Landlock 限制 Agent 只能写自己的 worktree）
- GitHub Issues 双向同步
- **多 Agent 竞赛**：同一任务同时派给 `claude` 和 `codex`，人类挑更好的实现 —— seam 设计让这个几乎免费
- 更多 CLI provider（gemini-cli 等），加一个描述符即可
