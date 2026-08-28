import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { Skip } from '@/types.ts'

/**
 * 界面语言。
 *
 * 只有中英两种 —— 这是一个装在自己机器上的工具，够用就好；多一种语言就多
 * 一份会过期的文案。默认跟浏览器走，手动切过之后那次选择压过浏览器。
 */
export type Lang = 'zh' | 'en'

const KEY = 'loopkanban.lang'

/**
 * 中文是母本：所有 key 都在这里定义，英文那份必须逐条对齐（类型会盯着）。
 *
 * 占位符写成 `{name}`，由 `t` 的第二个参数填。不写成模板函数是为了让英文
 * 那份能被 `Record<Key, string>` 约束住 —— 少一条就编译不过。
 */
const zh = {
  'lang.toggle': '切换到英文',
  'lang.short': 'EN',

  // ── 顶栏 ───────────────────────────────────────────────
  'header.overview': '概览',
  'header.project': '项目',
  'header.allProjects': '所有项目',
  'header.base': '基线 {branch}',
  'header.baseHint': '换基线分支 —— 只影响此后新建的卡，已有的卡各自记着自己的基线',
  'header.dismiss': '知道了',
  'header.tabTasks': '任务',
  'header.tabFiles': '文件浏览',
  'header.tabFilesBlocked': '先选一个项目 —— 文件浏览要知道逛的是哪个仓库',

  // ── 文件浏览 ───────────────────────────────────────────
  'files.workspace': '工作区',
  'files.workspaceHint': 'Agent 在各自的 worktree 里干活。切过去，就能看它到底改了什么',
  'files.repo': '主仓库',
  'files.worktree': '卡 {taskId}',
  'files.detached': '游离 HEAD',
  'files.reload': '重新读取',
  'files.reloadHint': '重新读这个目录 —— Agent 正在改的东西，界面不会自己知道',
  'files.up': '上一级',
  'files.root': '根',
  'files.rootHint': '只能逛项目仓库里面 —— 这就是能往上走到的尽头',
  'files.loading': '读取中…',
  'files.empty': '这个目录是空的',
  'files.pickFile': '点左边的文件看内容',
  'files.noProject': '还没有项目。先在左侧新增一个 —— 文件浏览要知道逛哪个仓库。',

  // ── 命令行 ─────────────────────────────────────────────
  'term.title': '命令行',
  'term.expand': '展开命令行',
  'term.collapse': '收起命令行',
  'term.placeholder': '在这个目录里跑一条命令',
  'term.run': '执行',
  'term.clear': '清空',
  'term.clearHint': '清空这块屏 —— 不影响已经跑完的命令',

  // ── 一键测试环境 ───────────────────────────────────────
  'testenv.title': '测试环境',
  'testenv.start': '启动测试环境',
  'testenv.stop': '停止',
  'testenv.edit': '改启动命令',
  'testenv.cancelEdit': '不改了',
  'testenv.save': '保存',
  'testenv.commandLabel': '启动命令',
  'testenv.commandPlaceholder': 'pnpm install && pnpm dev',
  'testenv.needCommand': '这个项目还没配启动命令。写一条能把它跑起来的命令 —— 卡片的 worktree 是一份干净的源码副本，装依赖也写在这条命令里。',
  'testenv.commandHint': '跑在这张卡自己的 worktree 里。端口由看板分配，命令里写 {{port}} 或读环境变量 PORT。',
  'testenv.status.starting': '启动中',
  'testenv.status.ready': '就绪',
  'testenv.status.running': '运行中',
  'testenv.status.exited': '已停止',
  'testenv.logsEmpty': '还没有输出',
  'testenv.autostop': '关掉这个面板一分钟后自动收掉，最多跑 30 分钟。验收、打回、废弃时也会立刻停。',
  'testenv.noPort': '这条命令没有监听端口 —— 日志就是它的全部产出。',
  'testenv.exited': '进程自己退出了（{code}）。上面的日志里有原因。',
  'testenv.stoppedBy.manual': '已停止。',
  'testenv.stoppedBy.idle': '没人看着，已经自动收掉了。再点一次启动就能回来。',
  'testenv.stoppedBy.expired': '跑满 30 分钟，自动收掉了。要接着验就再启动一次。',
  'testenv.stoppedBy.verdict': '这张卡判完了，环境跟着收掉 —— 它的工作区马上就不在了。',
  'testenv.stoppedBy.shutdown': '看板退出，环境跟着收掉了。',

  'term.empty': '还没跑过命令。',
  'term.hint': '每条命令在新的 shell 里跑，所以 `cd` 不会留到下一条 —— 换目录请在上面点。',
  'term.cwd': '工作目录 {path}',
  'term.running': '执行中…',
  'term.ok': '完成 · {ms}ms',
  'term.exit': '退出码 {code} · {ms}ms',
  'term.signal': '被 {signal} 终止 · {ms}ms',
  'term.timedOut': '超时，整棵进程树已收掉。',
  'term.truncated': '输出过长，这里只显示了前一部分。',
  'term.failed': '这条命令没能起来。',
  'term.historyHint': '↑ ↓ 翻历史',
  'term.tabHint': '⇥ 补路径',
  'term.noMatch': '这个前缀在当前目录下没有匹配的路径。',
  'term.moreMatches': '还有 {n} 个没列出来 —— 多敲几个字符再补。',

  // ── 侧边栏 ─────────────────────────────────────────────
  'sidebar.tagline': 'agent dispatch',
  'sidebar.newTask': '新建任务',
  'sidebar.newTaskBlocked': '先选一个项目 —— 任务得知道自己在哪个仓库里干活',
  'sidebar.overview': '概览',
  'sidebar.overviewHint': '所有项目的任务',
  'sidebar.projects': '项目',
  'sidebar.addProject': '新增项目',
  'sidebar.noProjects': '还没有项目',
  'sidebar.projectHint': '{path}\n基线 {branch}\n双击改名',
  'sidebar.projectRunning': '{n} 张卡正在跑',
  'sidebar.projectQueued': '{n} 张卡排着队等执行位',
  'sidebar.projectReview': '{n} 张卡等你看一眼',
  'sidebar.deleteProjectNamed': '删除项目 {name}',
  'sidebar.deleteProject': '删除项目',
  'sidebar.agents': '本机 Agent',
  'sidebar.noAgents': '未探测到 Agent CLI',
  'sidebar.slots': '占用 {running} / {limit} 个执行位',
  'sidebar.noResume': '无续跑',
  'sidebar.refreshAgents': '重新探测本机 Agent CLI',
  'sidebar.refreshAgentsHint': '重新探测本机 Agent CLI\n装了新的、升级了版本、刚登录完 —— 点这里，不必重启',
  'sidebar.agentsRefreshed': '已重新探测：{list}',
  /** 枚举分隔符。中文用顿号，英文用逗号加空格 —— 别把中文标点带进英文句子。 */
  'sidebar.agentsSeparator': '、',
  'sidebar.agentsNoneFound': '没有探测到可用的 Agent CLI',
  'sidebar.agentsRefreshFailed': '重新探测失败',
  'sidebar.archive': '归档',
  'sidebar.showArchived': '显示归档的卡',
  'sidebar.hideArchived': '隐藏归档的卡',
  'sidebar.autopilotOn': '自动驾驶开启',
  'sidebar.autopilotOff': '自动驾驶关闭',
  'sidebar.collapse': '收起侧边栏',
  'sidebar.expand': '展开侧边栏',

  // ── 自动驾驶 ───────────────────────────────────────────
  'autopilot.turnOff': '关闭后不再自动认领，已在跑的任务不受影响',
  'autopilot.turnOn': '打开后 Ready 里的卡会被自动派给 Agent',
  'autopilot.on': '已开启',
  'autopilot.off': '已关闭',
  'autopilot.limitHint': '每个执行器的并发上限',
  'autopilot.less': '减少每个执行器的并发',
  'autopilot.more': '增加每个执行器的并发',
  'autopilot.repoLimitHint': '同一个仓库同时跑几个任务。每个 Run 有自己的 worktree，调大是安全的；默认 1 是为了少几次合并冲突',
  'autopilot.repoLess': '减少每个仓库的并发',
  'autopilot.repoMore': '增加每个仓库的并发',

  // ── 列 ─────────────────────────────────────────────────
  'column.backlog.hint': '想法池 · Agent 不可领',
  'column.ready.hint': '队列 · 等待认领',
  'column.running.hint': 'Agent 执行中',
  'column.review.hint': '等待人工验收 · 成败都在这儿',
  'column.done.hint': '已合并',

  // ── 卡片 ───────────────────────────────────────────────
  'card.empty': '还没写内容',
  'card.leaseExpired': '租约已过期 · 待回收',
  'card.draftCleanupFailed': '那张没写内容的新卡没能删掉，它还留在想法池里，请手动删一下。',

  // ── 调度器为什么没派它 ─────────────────────────────────
  'skip.blocked-by-dependency': '依赖未完成: {0}',
  'skip.provider-unavailable': '本机没有探测到任何可用的 Agent CLI',
  'skip.provider-unavailable.pinned': '指定的 {0} 未探测到',
  'skip.provider-limit-reached': '{0} 并发已满 ({1})',
  'skip.repo-limit-reached': '{0} 仓库并发已满 ({1})',

  // ── 任务弹窗 ───────────────────────────────────────────
  'panel.unknownProject': '未知项目',
  'panel.baseLabel': '基线',
  'panel.archive': '归档',
  'panel.unarchive': '取出',
  'panel.archiveBlocked': '正在执行的卡片不能归档，先终止执行',
  'panel.delete': '删除',
  'panel.deleteConfirm': '确认删除',
  'panel.deleteArmed': '再点一次就删掉了，不可撤销',
  'panel.deleteHint': '删除这张卡：执行历史与它留下的分支、工作区一并抹掉',
  'panel.close': '关闭',
  'panel.closeHint': '关闭 · esc',
  'panel.archivedAt': '已归档 · {at}。',
  'panel.archivedNote': '它留在 {column} 列但不出现在看板上，也不会被自动认领。取出后回到原位。',
  'panel.dispatchTo': '派给',
  'panel.noAgents': '没有可用的 Agent CLI',
  'panel.pinnedMissing': '指定的 {provider} 本机没探测到，去规格里换一个',
  'panel.stop': '终止执行',
  'panel.runAborted': '这次执行被终止了。',
  'panel.runFailed': '这次执行失败了。',
  'panel.runFailedHint': '看完日志后去讨论里说一句让它重跑，或者废弃。',
  'panel.acceptMerge': '通过并合并',
  'panel.accept': '通过',
  'panel.discard': '废弃',
  'panel.acceptNote': '通过只把改动提交到分支 {branch}，不动你的主工作区；废弃会删掉分支并把卡退回 Backlog。要它再改一版，去讨论里说 —— 留言会把卡送回队列。',
  'panel.rounds': '第 {n} 轮',
  'panel.roundsHint': '这个会话跑过的轮次 —— 每派出去跑一次 +1，第二轮起接的是同一个 Agent 会话',
  'panel.round': '#{n}',
  'panel.tab.spec': '规格',
  'panel.tab.talk': '讨论',
  'panel.tab.diff': 'Diff',
  'panel.tab.stream': '事件流',
  'panel.tab.runs': '执行历史',
  'panel.noDiff': '还没有可看的改动',
  'panel.noRun': '这张卡还没有执行记录',
  'panel.waiting': '等待事件…',
  'panel.noRuns': '暂无执行记录',
  'panel.inProgress': '进行中',
  'panel.branchHint': 'Agent 干活的那条分支 —— 改动都在它上面，合的也是它',

  // ── Pull Request ───────────────────────────────────────
  'pr.title': 'Pull Request',
  'pr.refresh': '刷新状态',
  'pr.opened': '已开出 #{n}。',
  'pr.reused': '这条分支已经有 PR #{n}，改动推上去了。',
  'pr.willOpen': '按下就把改动提交到分支、把基线合进来、推上 {repo}，并开一条冲着 {base} 的 PR。合不合由你在 GitHub 上决定 —— 合上之后这张卡自动进 Done。',
  'pr.fallback': '开不了 PR（{detail}），所以这颗按钮走的是本地合并：把分支合回主工作区的基线。',
  'pr.pendingHint': 'PR 已经开好了，去 GitHub 上检查一遍、自己合。合上之后这张卡会自动收进 Done —— 等不及就点上面的刷新，立刻问一次。',
  'pr.conflictingHint': 'GitHub 说这条 PR 有冲突 —— 基线在这期间又往前走了。再点一次「通过并合并」，冲突会被拉回这张卡的工作区，交给它自己去解。',
  'pr.conflicting': '有冲突',
  'pr.conflict': '与基线有冲突：{files}。',
  'pr.conflictHandoff': '冲突留在工作区里，这张卡已经回到队列去解 —— 派它跑一轮，解完再点一次「通过并合并」。',
  'pr.conflictDispatched': '冲突留在工作区里，已经派了一轮去解 —— 解完再点一次「通过并合并」。',
  'pr.conflictStuck': '工作区里还有没解开的冲突，这张卡仍然停在 Review —— 去讨论里让它接着解，或者自己解完再点一次。',
  'pr.collected': 'PR 已合并，这张卡收进 Done 了。',
  'pr.stillOpen': '还没合上。',
  'pr.state.open': '开着',
  'pr.state.merged': '已合并',
  'pr.state.closed': '已关闭',

  // ── 讨论 ───────────────────────────────────────────────
  'talk.you': '你',
  'talk.placeholderRequeue': '要它再改什么？发出去这张卡就回队列',
  'talk.placeholder': '留一条话，下次执行会带上它',
  'talk.noteRequeue': '发出去这张卡回到 Ready，下一次执行会带着整条讨论走。',
  'talk.note': '下一次执行会带着整条讨论走。',
  'talk.nextRound': '下一轮交给',
  'talk.sendFailed': '发不出去，稍后再试',
  'talk.send': '发送',
  'talk.attach': '带上文件',
  'talk.attachDropActive': '松手就传上去',
  'talk.attachUploading': '正在上传 {name}',
  'talk.attachRemove': '不带这个了',
  'talk.attachFull': '一条留言最多带 {max} 个文件',
  'talk.attachFailed': '这个文件没传上去，稍后再试',
  'talk.attachRemoveFailed': '这个文件撤不掉，稍后再试',

  // ── 规格表单 ───────────────────────────────────────────
  'editor.lockedRunning': '正在执行，不能改需求 —— 否则你和 Agent 会对着两份不同的规格。要改先终止执行。',
  'editor.lockedArchived': '已归档，内容冻结。要改先从归档里取出。',
  'editor.description': '任务内容',
  'editor.descriptionHint': '第一行会被当作这张卡的名字',
  'editor.descriptionPlaceholder': '要 Agent 做什么？',
  'editor.acceptance': '验收标准',
  'editor.acceptanceHint': '可选。写了 Agent 就照着做、你就照着验；不写也能派活',
  'editor.acceptancePlaceholder': '一条可判定的标准',
  'editor.acceptanceRemove': '删除这条',
  'editor.acceptanceAdd': '新增一条',
  'editor.provider': '指定执行器',
  'editor.providerHint': '不指定就由调度器按可用性挑一个',
  'editor.providerAny': '任意',
  'editor.model': '模型',
  'editor.modelUnsupported': '这个版本的 {provider} 没有 --model 参数，只能用它自己的默认模型。',
  'editor.modelUnknown': '没能列出 {provider} 的可选模型（离线或它报不出来），这次只能用它自己的默认。',
  'editor.modelHint': '{count} 个可选；不选就用 {provider} 自己的默认',
  'editor.modelDefault': '（默认模型）',
  // ── 附件 ───────────────────────────────────────────────
  'editor.attachments': '附件',
  'editor.attachmentsHint': '图片、PDF、Word 都行。派活时会拷进工作区，并在 TASK.md 里点名交给 Agent',
  'editor.attachmentsDrop': '把文件拖到这儿，或点击选择',
  'editor.attachmentsDropActive': '松手就传上去',
  'editor.attachmentsAdd': '添加附件',
  'editor.attachmentsRemove': '删除这个附件',
  'editor.attachmentsOpen': '在新标签页里打开',
  'editor.attachmentsUploading': '正在上传 {name}',
  'editor.attachmentsFull': '一张卡最多 {max} 个附件',
  'editor.attachmentsLocked': '这张卡当前不能改附件',
  'editor.attachmentsEmpty': '还没有附件',
  'editor.project': '项目',
  'editor.projectHint': '任务在它派生出来的 worktree 里执行，做完再合回基线',
  'editor.baseline': '基线 {branch}',
  'editor.dirty': '有未保存的改动',
  'editor.saved': '已保存',
  'editor.save': '保存',

  // ── Diff ───────────────────────────────────────────────
  'diff.empty': '这次执行没有产生任何改动',
  'diff.truncated': '改动过大，这里只显示了前一部分。完整补丁在产物目录里。',

  // ── 文档预览 ───────────────────────────────────────────
  'preview.close': '关闭预览 · esc',
  'preview.loading': '读取中…',
  'preview.truncated': '文件太大，这里只显示了前一部分。完整的那份在本机磁盘上。',
  'preview.rendered': '预览',
  'preview.source': '原文',
  'preview.binary': '这个格式在这儿看不了。',
  'preview.legacyDoc': '旧版 .doc 是二进制私有格式。在 Word 里另存为 .docx 就能看了。',
  'preview.noRaw': '这份文件要浏览器自己打开，而这里拿不到它的地址。',
  'preview.emptyDoc': '这份文档是空的。',
  'preview.docTruncated': '文档太长，这里只显示了前一部分。',

  // ── 新增 / 删除项目 ───────────────────────────────────
  'newProject.pickTitle': '选择项目文件夹',
  'newProject.pickHint': '逛的是跑着 LoopKanban 的那台机器上的目录。带 git 标记的才能当项目。',
  'newProject.title': '新增项目',
  'newProject.hint': '一个项目就是本机上的一个 git 仓库。任务在它派生的 worktree 里执行，做完再合回来。',
  'newProject.name': '项目名称',
  'newProject.namePlaceholder': '给它一个你认得出的名字',
  'newProject.folder': '项目文件夹',
  'newProject.browse': '选择…',
  'newProject.pathHint': '本机上的绝对路径。',
  'newProject.base': '基线分支',
  'newProject.baseHint': '任务分支从这儿派生，验收通过也合回这儿。默认 main —— 从别的分支拉，每张卡都会带上那条分支的改动。',
  'newProject.baseWaiting': '选好文件夹后在这里挑基线分支。',
  'newProject.baseEmpty': '这个仓库还没有任何提交，暂时没有分支可选 —— 先提交一次再来。',
  'newProject.cancel': '取消',
  'newProject.submit': '新增',
  'newProject.err.not-a-repo': '这个目录不是 git 仓库。任务要在它派生出来的 worktree 上干活，不是仓库就派生不出来。',
  'newProject.err.path-not-absolute': '要绝对路径 —— 服务端不该去猜它相对于谁。',
  'newProject.err.project-exists': '这个目录已经是一个项目了。',
  'newProject.err.no-such-branch': '这个仓库里没有这条分支。刷新一下重新选一条。',

  'deleteProject.title': '删除项目「{name}」？',
  'deleteProject.irreversible': '这个动作不可撤销。',
  'deleteProject.lead': '会被删掉的是 LoopKanban 记的账：',
  'deleteProject.tasks': '· 这个项目下的 {count} 张卡，以及它们的执行历史与日志',
  'deleteProject.branches': '· 这些卡留下的任务分支与 worktree（.loopkanban/worktrees/）',
  'deleteProject.safe': '你的仓库 {path} 本身不会被动，已经合并进基线的改动也都还在。',
  'deleteProject.cancel': '取消',
  'deleteProject.submit': '删除项目',
  'deleteProject.err.project-busy': '还有卡正在执行 —— 那是个活着的进程正在改这个仓库。先终止它们再删。',
  'deleteProject.err.project-not-found': '这个项目已经不在了。',

  // ── 目录选择框 ─────────────────────────────────────────
  'picker.up': '上一级',
  'picker.home': '回到家目录',
  'picker.loading': '读取中…',
  'picker.emptyDir': '这个目录下没有子文件夹',
  'picker.isRepo': '当前目录是 git 仓库，可以直接选它。',
  'picker.notRepo': '进到某个仓库里再选它。',
  'picker.back': '返回',
  'picker.pick': '选择这个目录',

  // ── 底部统计 ───────────────────────────────────────────
  'stats.successRate': '成功率',
  'stats.failed': '失败',
  'stats.cost': '已知成本',
  'stats.costHint': '只有会上报成本的 CLI 才计入',

  // ── 明暗 ───────────────────────────────────────────────
  'theme.toLight': '切换到亮色',
  'theme.toDark': '切换到暗色',

  // ── 通知 ───────────────────────────────────────────────
  'notify.review': '待验收',

  // ── 领域错误码 → 用户能照做的说明 ─────────────────────
  'err.illegal-transition': '不允许这样跨列。流转顺序是 Backlog → Ready → Running → Review → Done。',
  'err.blocked-by-dependency': '它依赖的任务还没完成。',
  'err.lease-held': '这张卡正被某个 Agent 持有，等它跑完或超时释放。',
  'err.revision-conflict': '这张卡刚被改动过，已为你重新加载。',
  'err.provider-unavailable': '这个 Agent CLI 本机没有探测到。装好它，或者换一个。',
  'err.launch-failed': '起进程失败。多半是 worktree 建不出来 —— 检查仓库路径和基线分支。',
  'err.no-runner': '当前实例没有启用执行器，只能看板不能派活。',
  'err.dirty-worktree': '你的主工作区有未提交改动，先处理干净再合并。改动已经提交在任务分支上，不会丢。',
  'err.wrong-branch': '你的主工作区不在基线分支上。改动已经提交在任务分支上，切回去再合并即可。',
  'err.no-run': '这张卡还没有执行记录。',
  'err.gh-missing': '本机没找到 gh。开 PR 用的是你自己登录好的 GitHub CLI —— 装上它并 `gh auth login`，或者改用本地合并。',
  'err.no-remote': '这个仓库没有配置远端，推不上去，也就开不了 PR。',
  'err.not-github': '这个远端不是 GitHub，开不了 PR —— gh 只认 GitHub（含企业版）。',
  'err.gh-failed': 'gh 那边出错了。多半是没登录或没权限：在终端里跑一次 `gh auth status` 看它怎么说。',
  'err.push-failed': '推不上去。远端上那条分支可能被别人动过，或者你没有推送权限 —— 改动已经提交在任务分支上，不会丢。',
  'err.fetch-failed': '拉不到远端的基线分支。检查网络与远端配置。',
  'err.merge-failed': '把基线合进任务分支时失败了（不是冲突）。去那个工作区里跑一次 git status 看它停在哪儿。',
  'err.merge-conflict': '与基线有冲突。冲突留在这张卡的工作区里，解完再点一次「通过并合并」。',
  'err.no-worktree': '这次执行没留下工作区（多半是起进程就失败了），没有东西可验收 —— 去讨论里说一句让它重跑，或者废弃。',
  'err.task-archived': '这张卡已归档。要动它先取消归档 —— 归档的卡是冻结的，不会被自动认领。',
  'err.already-archived': '这张卡已经归档了。',
  'err.not-archived': '这张卡没有归档。',
  'err.not-deletable': '只有 Backlog 与 Ready 的卡能删 —— 再往后 Agent 已经动过仓库了。要删就先废弃回想法池。',
  'err.no-project': '还没有项目。先在左侧新增一个 —— 任务得知道自己在哪个仓库里干活。',
  'err.task-not-found': '这张卡已经不在了，可能刚被删掉。',
  'err.no-such-branch': '这个仓库里没有这条分支，可能刚被删掉。',
  'err.task-running': '这张卡正在执行，内容和附件都冻结着。要改先终止执行。',
  'err.too-many-attachments': '附件太多了。删掉几个再传 —— 一次给 Agent 塞几十份材料，它反而抓不住重点。',
  'err.attachment-sent': '这个文件已经跟着留言发出去了 —— 讨论是一份记录，撤不回来。要更正就再留一条。',
  'err.no-attachments': '当前实例没有配置附件存储，传不了文件。',
  'err.attachment-not-found': '这个附件已经不在了，可能刚被删掉。',
  'err.attachment-gone': '这个附件的文件已经不在磁盘上了 —— 重新传一份。',
  'err.path-outside-workspace': '这条路径不在这张卡够得着的地方（它的工作区与项目仓库），不给看。',
  'err.not-text': '这是个二进制文件，在这儿预览只会是一屏乱码。',
  'err.bad-document': '这份 Word 文档读不出来 —— 可能是坏了、加了密、正文大到翻不动，也可能本来就是别的东西改了扩展名。',
  'err.too-large': '这份文档太大了，读进来翻会把标签页顶住。在本机打开它。',
  'err.not-inlineable': '这个格式不能直接在浏览器里打开。',
  'err.unreadable': '这个文件读不动 —— 多半是权限不够。它确实在那儿，但当前用户打不开它。',
  /* 文档预览与文件浏览共用这一条，所以两种成因都要说到：它可能刚被删掉或
     改了名，也可能是那次执行的工作区整个清掉了。 */
  'err.no-such-file': '这个文件不在了 —— 可能刚被删掉或改了名，也可能是那次执行的工作区已经清掉。',
  'err.no-such-dir': '打不开这个目录，它可能刚被删掉或改了名。',
  'err.outside-project': '只能逛这个项目的仓库 —— 请求的路径不在里面。',
  'err.repo-missing': '这个项目的仓库目录已经不在了。它可能被移走或删掉了 —— 把它放回原处，或者删掉这个项目重建一个。',
  'err.empty-command': '得先写一条命令。',
  'err.no-testenv': '当前实例没有启用测试环境，起不了。',
  'err.no-test-command': '这个项目还没配启动命令 —— 在上面填一条，比如 `pnpm install && pnpm dev`。',
}

export type MessageKey = keyof typeof zh

const en: Record<MessageKey, string> = {
  'lang.toggle': 'Switch to Chinese',
  'lang.short': '中',

  'header.overview': 'Overview',
  'header.project': 'Project',
  'header.allProjects': 'all projects',
  'header.base': 'base {branch}',
  'header.baseHint': 'Change the base branch — affects new cards only; existing cards keep the base they were created with',
  'header.dismiss': 'dismiss',
  'header.tabTasks': 'Tasks',
  'header.tabFiles': 'Files',
  'header.tabFilesBlocked': 'Pick a project first — the file browser has to know which repo to show',

  'files.workspace': 'Workspace',
  'files.workspaceHint': 'Agents work in their own worktrees. Switch to one and you can see exactly what it changed',
  'files.repo': 'Main repo',
  'files.worktree': 'card {taskId}',
  'files.detached': 'detached HEAD',
  'files.reload': 'Reload',
  'files.reloadHint': 'Re-read this directory — an agent editing it won\u2019t tell the page on its own',
  'files.up': 'Up one level',
  'files.root': 'root',
  'files.rootHint': 'Browsing stays inside the project repo — this is as far up as it goes',
  'files.loading': 'Loading\u2026',
  'files.empty': 'This directory is empty',
  'files.pickFile': 'Pick a file on the left to read it',
  'files.noProject': 'No projects yet. Add one on the left — the file browser has to know which repo to show.',

  'term.title': 'Shell',
  'term.expand': 'Open the shell',
  'term.collapse': 'Collapse the shell',
  'term.placeholder': 'Run a command in this directory',
  'term.run': 'Run',
  'term.clear': 'Clear',
  'term.clearHint': 'Clear the screen — commands already run are unaffected',

  // ── One-click test environment ─────────────────────────
  'testenv.title': 'Test environment',
  'testenv.start': 'Start it up',
  'testenv.stop': 'Stop',
  'testenv.edit': 'Edit the start command',
  'testenv.cancelEdit': 'Never mind',
  'testenv.save': 'Save',
  'testenv.commandLabel': 'Start command',
  'testenv.commandPlaceholder': 'pnpm install && pnpm dev',
  'testenv.needCommand': 'This project has no start command yet. Write one that gets it running — the card’s worktree is a clean copy of the source, so installing dependencies belongs in this command too.',
  'testenv.commandHint': 'Runs in this card’s own worktree. The board picks the port: write {{port}} in the command, or read the PORT environment variable.',
  'testenv.status.starting': 'starting',
  'testenv.status.ready': 'ready',
  'testenv.status.running': 'running',
  'testenv.status.exited': 'stopped',
  'testenv.logsEmpty': 'No output yet',
  'testenv.autostop': 'Closes itself a minute after you close this panel, and runs 30 minutes at most. Accepting, sending back, or discarding stops it immediately.',
  'testenv.noPort': 'This command isn’t listening on a port — the log is all it produces.',
  'testenv.exited': 'The process exited on its own ({code}). The log above says why.',
  'testenv.stoppedBy.manual': 'Stopped.',
  'testenv.stoppedBy.idle': 'Nobody was watching, so it was cleaned up. Start it again to get it back.',
  'testenv.stoppedBy.expired': 'It hit the 30-minute cap and was cleaned up. Start it again to keep testing.',
  'testenv.stoppedBy.verdict': 'The card was decided, so the environment went with it — its worktree is about to be gone.',
  'testenv.stoppedBy.shutdown': 'The board shut down and took the environment with it.',

  'term.empty': 'Nothing run yet.',
  'term.hint': 'Each command runs in a fresh shell, so `cd` doesn\u2019t carry to the next one — change directory above instead.',
  'term.cwd': 'in {path}',
  'term.running': 'Running\u2026',
  'term.ok': 'done \u00b7 {ms}ms',
  'term.exit': 'exit {code} \u00b7 {ms}ms',
  'term.signal': 'killed by {signal} \u00b7 {ms}ms',
  'term.timedOut': 'Timed out; the whole process tree was collected.',
  'term.truncated': 'Output was too long; only the first part is here.',
  'term.failed': 'That command could not be started.',
  'term.historyHint': '\u2191 \u2193 for history',
  'term.tabHint': '\u21e5 to complete',
  'term.noMatch': 'No path in this directory starts with that.',
  'term.moreMatches': '{n} more not listed \u2014 type a few more characters.',

  'sidebar.tagline': 'agent dispatch',
  'sidebar.newTask': 'New task',
  'sidebar.newTaskBlocked': 'Pick a project first — a task has to know which repo it works in',
  'sidebar.overview': 'Overview',
  'sidebar.overviewHint': 'Tasks across every project',
  'sidebar.projects': 'Projects',
  'sidebar.addProject': 'Add project',
  'sidebar.noProjects': 'No projects yet',
  'sidebar.projectHint': '{path}\nbase {branch}\nDouble-click to rename',
  'sidebar.projectRunning': '{n} running',
  'sidebar.projectQueued': '{n} queued for a slot',
  'sidebar.projectReview': '{n} waiting for your review',
  'sidebar.deleteProjectNamed': 'Delete project {name}',
  'sidebar.deleteProject': 'Delete project',
  'sidebar.agents': 'Local agents',
  'sidebar.noAgents': 'No agent CLI detected',
  'sidebar.slots': 'Using {running} of {limit} slots',
  'sidebar.noResume': 'no resume',
  'sidebar.refreshAgents': 'Re-detect local Agent CLIs',
  'sidebar.refreshAgentsHint': 'Re-detect local Agent CLIs\nInstalled a new one, upgraded, just logged in — click here, no restart needed',
  'sidebar.agentsRefreshed': 'Re-detected: {list}',
  'sidebar.agentsSeparator': ', ',
  'sidebar.agentsNoneFound': 'No usable Agent CLI detected',
  'sidebar.agentsRefreshFailed': 'Re-detection failed',
  'sidebar.archive': 'Archive',
  'sidebar.showArchived': 'Show archived cards',
  'sidebar.hideArchived': 'Hide archived cards',
  'sidebar.autopilotOn': 'Autopilot on',
  'sidebar.autopilotOff': 'Autopilot off',
  'sidebar.collapse': 'Collapse sidebar',
  'sidebar.expand': 'Expand sidebar',

  'autopilot.turnOff': 'Turning it off stops new claims; runs already going are unaffected',
  'autopilot.turnOn': 'Turning it on hands cards in Ready to an agent automatically',
  'autopilot.on': 'on',
  'autopilot.off': 'off',
  'autopilot.limitHint': 'Concurrency limit per agent',
  'autopilot.less': 'Fewer concurrent runs per agent',
  'autopilot.more': 'More concurrent runs per agent',
  'autopilot.repoLimitHint': 'Concurrent runs in one repository. Each run gets its own worktree, so raising this is safe; the default of 1 just keeps merge conflicts down',
  'autopilot.repoLess': 'Fewer concurrent runs per repository',
  'autopilot.repoMore': 'More concurrent runs per repository',

  'column.backlog.hint': 'Idea pool · agents can’t claim',
  'column.ready.hint': 'Queue · waiting to be claimed',
  'column.running.hint': 'Agent at work',
  'column.review.hint': 'Waiting on you · pass and fail both land here',
  'column.done.hint': 'Merged',

  'card.empty': 'Nothing written yet',
  'card.leaseExpired': 'Lease expired · to be reclaimed',
  'card.draftCleanupFailed': 'That blank new card could not be removed — it is still in the idea pool, so delete it by hand.',

  'skip.blocked-by-dependency': 'Unfinished dependencies: {0}',
  'skip.provider-unavailable': 'No agent CLI detected on this machine',
  'skip.provider-unavailable.pinned': 'Pinned agent {0} was not detected',
  'skip.provider-limit-reached': '{0} is at its concurrency limit ({1})',
  'skip.repo-limit-reached': '{0} is at its per-repository limit ({1})',

  'panel.unknownProject': 'Unknown project',
  'panel.baseLabel': 'base',
  'panel.archive': 'Archive',
  'panel.unarchive': 'Restore',
  'panel.archiveBlocked': 'A running card can’t be archived — stop the run first',
  'panel.delete': 'Delete',
  'panel.deleteConfirm': 'Confirm delete',
  'panel.deleteArmed': 'One more click deletes it. No undo.',
  'panel.deleteHint': 'Delete this card: run history plus the branch and worktree it left behind',
  'panel.close': 'Close',
  'panel.closeHint': 'Close · esc',
  'panel.archivedAt': 'Archived · {at}.',
  'panel.archivedNote': 'It stays in the {column} column but is off the board and won’t be claimed automatically. Restoring puts it back.',
  'panel.dispatchTo': 'Hand to',
  'panel.noAgents': 'No agent CLI available',
  'panel.pinnedMissing': 'Pinned {provider} was not detected here — change it in the spec',
  'panel.stop': 'Stop run',
  'panel.runAborted': 'This run was stopped.',
  'panel.runFailed': 'This run failed.',
  'panel.runFailedHint': 'Read the log, then say something in Talk to make it try again — or discard it.',
  'panel.acceptMerge': 'Accept & merge',
  'panel.accept': 'Accept',
  'panel.discard': 'Discard',
  'panel.acceptNote': 'Accepting only commits the work to branch {branch}; your main worktree is untouched. Discarding deletes the branch and sends the card back to Backlog. Want another pass? Say so in Talk — a comment requeues the card.',
  'panel.rounds': 'round {n}',
  'panel.roundsHint': 'Rounds this session has run — +1 each time the card is handed out; from the second one on it resumes the same agent session',
  'panel.round': '#{n}',
  'panel.tab.spec': 'Spec',
  'panel.tab.talk': 'Talk',
  'panel.tab.diff': 'Diff',
  'panel.tab.stream': 'Events',
  'panel.tab.runs': 'Runs',
  'panel.noDiff': 'No changes to look at yet',
  'panel.noRun': 'This card has no runs yet',
  'panel.waiting': 'Waiting for events…',
  'panel.noRuns': 'No runs yet',
  'panel.inProgress': 'running',
  'panel.branchHint': 'The branch the agent works on — every change lives there, and that is what gets merged',

  'pr.title': 'Pull request',
  'pr.refresh': 'Refresh',
  'pr.opened': 'Opened #{n}.',
  'pr.reused': 'This branch already had PR #{n}; the changes were pushed to it.',
  'pr.willOpen': 'This commits the changes, merges the base in, pushes to {repo}, and opens a PR against {base}. Merging stays your call on GitHub — once it lands, this card moves to Done on its own.',
  'pr.fallback': 'No PR possible here ({detail}), so this button does a local merge instead: the branch goes back into the base in your main worktree.',
  'pr.pendingHint': 'The PR is open. Review it on GitHub and merge it yourself. Once merged, this card moves to Done automatically — hit Refresh above to ask right now.',
  'pr.conflictingHint': 'GitHub says this PR conflicts — the base moved on in the meantime. Hit Accept & merge again and the conflict is pulled back into this card’s worktree for it to resolve.',
  'pr.conflicting': 'conflicts',
  'pr.conflict': 'Conflicts with the base: {files}.',
  'pr.conflictHandoff': 'The conflict is left in the worktree and the card went back to the queue — dispatch a round to resolve it, then hit Accept & merge again.',
  'pr.conflictDispatched': 'The conflict is left in the worktree and a round was dispatched to resolve it — hit Accept & merge again once it lands.',
  'pr.conflictStuck': 'The worktree still has unresolved conflicts and this card is still in Review — say so in Talk to have it finish the job, or resolve them yourself and hit the button again.',
  'pr.collected': 'PR merged; this card moved to Done.',
  'pr.stillOpen': 'Not merged yet.',
  'pr.state.open': 'open',
  'pr.state.merged': 'merged',
  'pr.state.closed': 'closed',

  'talk.you': 'You',
  'talk.placeholderRequeue': 'What should it change? Sending this puts the card back in the queue',
  'talk.placeholder': 'Leave a note; the next run will carry it',
  'talk.noteRequeue': 'Sending puts this card back in Ready, and the next run carries the whole thread.',
  'talk.note': 'The next run carries the whole thread.',
  'talk.nextRound': 'Next round goes to',
  'talk.sendFailed': 'Could not send — try again',
  'talk.send': 'Send',
  'talk.attach': 'Attach files',
  'talk.attachDropActive': 'Let go to upload',
  'talk.attachUploading': 'Uploading {name}',
  'talk.attachRemove': 'Drop this file',
  'talk.attachFull': 'A comment carries at most {max} files',
  'talk.attachFailed': 'That file didn’t upload — try again',
  'talk.attachRemoveFailed': 'Couldn’t drop that file — try again',

  'editor.lockedRunning': 'A run is in progress, so the spec is frozen — otherwise you and the agent would be reading two different ones. Stop the run to edit.',
  'editor.lockedArchived': 'Archived, so the content is frozen. Restore it from the archive to edit.',
  'editor.description': 'Task',
  'editor.descriptionHint': 'The first line becomes this card’s name',
  'editor.descriptionPlaceholder': 'What should the agent do?',
  'editor.acceptance': 'Acceptance criteria',
  'editor.acceptanceHint': 'Optional. Written down, the agent works to them and you check against them; without them it still runs',
  'editor.acceptancePlaceholder': 'One checkable criterion',
  'editor.acceptanceRemove': 'Remove this one',
  'editor.acceptanceAdd': 'Add one',
  'editor.provider': 'Pin an agent',
  'editor.providerHint': 'Leave it open and the scheduler picks whichever is free',
  'editor.providerAny': 'Any',
  'editor.model': 'Model',
  'editor.modelUnsupported': 'This build of {provider} has no --model flag, so it uses its own default.',
  'editor.modelUnknown': 'Couldn’t list models for {provider} (offline, or it won’t report them) — this run uses its own default.',
  'editor.modelHint': '{count} available; leave it unset to use {provider}’s own default',
  'editor.modelDefault': '(default model)',
  'editor.attachments': 'Attachments',
  'editor.attachmentsHint': 'Images, PDFs, Word documents. They are copied into the workspace at dispatch and listed for the agent in TASK.md',
  'editor.attachmentsDrop': 'Drop files here, or click to pick',
  'editor.attachmentsDropActive': 'Let go to upload',
  'editor.attachmentsAdd': 'Add files',
  'editor.attachmentsRemove': 'Remove this attachment',
  'editor.attachmentsOpen': 'Open in a new tab',
  'editor.attachmentsUploading': 'Uploading {name}',
  'editor.attachmentsFull': 'A card holds at most {max} attachments',
  'editor.attachmentsLocked': 'Attachments are frozen on this card right now',
  'editor.attachmentsEmpty': 'No attachments yet',
  'editor.project': 'Project',
  'editor.projectHint': 'The task runs in a worktree derived from it, then merges back into the base',
  'editor.baseline': 'base {branch}',
  'editor.dirty': 'Unsaved changes',
  'editor.saved': 'Saved',
  'editor.save': 'Save',

  'diff.empty': 'This run produced no changes',
  'diff.truncated': 'The change is too large to show in full; only the first part is here. The complete patch is in the artifacts directory.',

  'preview.close': 'Close preview · esc',
  'preview.loading': 'Reading…',
  'preview.truncated': 'The file is too large to show in full; only the first part is here. The whole thing is on disk.',
  'preview.rendered': 'Rendered',
  'preview.source': 'Source',
  'preview.binary': 'This format can’t be shown here.',
  'preview.legacyDoc': 'Legacy .doc is a binary proprietary format. Save it as .docx in Word and it will show up.',
  'preview.noRaw': 'This file has to be opened by the browser itself, and there’s no address for it here.',
  'preview.emptyDoc': 'This document is empty.',
  'preview.docTruncated': 'The document is long; only the first part is shown here.',

  'newProject.pickTitle': 'Pick a project folder',
  'newProject.pickHint': 'You’re browsing the machine running LoopKanban. Only git repos can be projects.',
  'newProject.title': 'Add project',
  'newProject.hint': 'A project is one git repo on this machine. Tasks run in worktrees derived from it and merge back when done.',
  'newProject.name': 'Project name',
  'newProject.namePlaceholder': 'Give it a name you’ll recognize',
  'newProject.folder': 'Project folder',
  'newProject.browse': 'Browse…',
  'newProject.pathHint': 'An absolute path on this machine.',
  'newProject.base': 'Base branch',
  'newProject.baseHint': 'Task branches are derived from it, and accepted work merges back into it. Defaults to main — branch off anything else and every card carries that branch’s changes.',
  'newProject.baseWaiting': 'Pick a folder and its branches show up here.',
  'newProject.baseEmpty': 'This repo has no commits yet, so there are no branches to pick — make one commit first.',
  'newProject.cancel': 'Cancel',
  'newProject.submit': 'Add',
  'newProject.err.not-a-repo': 'That folder isn’t a git repo. Tasks work in a worktree derived from it, and there’s nothing to derive from.',
  'newProject.err.path-not-absolute': 'It has to be an absolute path — the server shouldn’t have to guess what it’s relative to.',
  'newProject.err.project-exists': 'That folder is already a project.',
  'newProject.err.no-such-branch': 'That branch isn’t in this repo. Reload and pick another one.',

  'deleteProject.title': 'Delete project “{name}”?',
  'deleteProject.irreversible': 'This can’t be undone.',
  'deleteProject.lead': 'What gets deleted is LoopKanban’s own bookkeeping:',
  'deleteProject.tasks': '· The {count} cards under this project, with their run history and logs',
  'deleteProject.branches': '· The task branches and worktrees they left behind (.loopkanban/worktrees/)',
  'deleteProject.safe': 'Your repo at {path} is untouched, and anything already merged into the base is still there.',
  'deleteProject.cancel': 'Cancel',
  'deleteProject.submit': 'Delete project',
  'deleteProject.err.project-busy': 'Cards are still running — those are live processes editing this repo. Stop them first.',
  'deleteProject.err.project-not-found': 'That project is already gone.',

  'picker.up': 'Up one level',
  'picker.home': 'Back to home directory',
  'picker.loading': 'Loading…',
  'picker.emptyDir': 'No subfolders here',
  'picker.isRepo': 'This directory is a git repo — you can pick it as is.',
  'picker.notRepo': 'Step into a repo, then pick it.',
  'picker.back': 'Back',
  'picker.pick': 'Pick this folder',

  'stats.successRate': 'success',
  'stats.failed': 'failed',
  'stats.cost': 'known cost',
  'stats.costHint': 'Only CLIs that report cost are counted',

  'theme.toLight': 'Switch to light',
  'theme.toDark': 'Switch to dark',

  'notify.review': 'Ready for review',

  'err.illegal-transition': 'That move isn’t allowed. The flow is Backlog → Ready → Running → Review → Done.',
  'err.blocked-by-dependency': 'A task it depends on isn’t done yet.',
  'err.lease-held': 'An agent holds this card. Wait for it to finish or for the lease to expire.',
  'err.revision-conflict': 'This card changed just now; it has been reloaded for you.',
  'err.provider-unavailable': 'That agent CLI wasn’t detected here. Install it, or pick another.',
  'err.launch-failed': 'The process failed to start — usually the worktree couldn’t be created. Check the repo path and base branch.',
  'err.no-runner': 'This instance has no runner enabled: you can look at the board but not dispatch.',
  'err.dirty-worktree': 'Your main worktree has uncommitted changes; clean it up before merging. The work is already committed on the task branch, so nothing is lost.',
  'err.wrong-branch': 'Your main worktree isn’t on the base branch. The work is already committed on the task branch — switch back and merge again.',
  'err.no-run': 'This card has no runs yet.',
  'err.gh-missing': 'No gh found here. Opening a PR uses your own logged-in GitHub CLI — install it and run `gh auth login`, or fall back to a local merge.',
  'err.no-remote': 'This repo has no remote, so there is nothing to push to and no PR to open.',
  'err.not-github': 'That remote isn’t GitHub, so no PR can be opened — gh only speaks GitHub (Enterprise included).',
  'err.gh-failed': 'gh errored out. Usually that means not logged in or no access: run `gh auth status` in a terminal and see what it says.',
  'err.push-failed': 'The push failed. The remote branch may have been changed by someone else, or you lack push access — the work is committed on the task branch either way.',
  'err.fetch-failed': 'Could not fetch the base branch from the remote. Check your network and remote config.',
  'err.merge-failed': 'Merging the base into the task branch failed (not a conflict). Run git status in that worktree to see where it stopped.',
  'err.merge-conflict': 'Conflicts with the base. They are left in this card’s worktree — resolve them, then hit Accept & merge again.',
  'err.no-worktree': 'That run left no worktree (it most likely failed at launch), so there’s nothing to review — say something in Talk to make it try again, or discard it.',
  'err.task-archived': 'This card is archived. Restore it first — archived cards are frozen and never claimed automatically.',
  'err.already-archived': 'This card is already archived.',
  'err.not-archived': 'This card isn’t archived.',
  'err.not-deletable': 'Only Backlog and Ready cards can be deleted — past that an agent has already touched the repo. Discard it back to the idea pool first.',
  'err.no-project': 'No projects yet. Add one on the left — a task has to know which repo it works in.',
  'err.task-not-found': 'This card is gone; it may have just been deleted.',
  'err.no-such-branch': 'That branch isn’t in this repo — it may have just been deleted.',
  'err.task-running': 'A run is in progress, so the spec and its attachments are frozen. Stop the run to edit.',
  'err.too-many-attachments': 'Too many attachments. Remove a few first — dozens of files at once and the agent loses the thread.',
  'err.attachment-sent': 'This file already went out with a comment — the thread is a record. Leave another comment instead.',
  'err.no-attachments': 'This instance has no attachment storage configured, so files can’t be uploaded.',
  'err.attachment-not-found': 'That attachment is gone; it may have just been deleted.',
  'err.attachment-gone': 'That attachment’s file is no longer on disk — upload it again.',
  'err.path-outside-workspace': 'That path is outside what this card can reach (its worktree and the project repo).',
  'err.not-text': 'That’s a binary file — previewing it here would just be a screen of noise.',
  'err.bad-document': 'This Word document can’t be read — it may be damaged, encrypted, too large to page through, or just something else with a .docx name.',
  'err.too-large': 'This document is too large to read in and page through here. Open it on your machine.',
  'err.not-inlineable': 'This format can’t be opened directly in the browser.',
  'err.unreadable': 'That file can’t be opened — most likely permissions. It is there, but this user can’t read it.',
  'err.no-such-file': 'That file is gone — deleted or renamed, or the worktree for that run was removed.',
  'err.no-such-dir': 'Can’t open that directory; it may have just been deleted or renamed.',
  'err.outside-project': 'Browsing stays inside this project’s repo, and the requested path is outside it.',
  'err.repo-missing': 'This project’s repo directory is gone — moved or deleted. Put it back, or delete the project and add it again.',
  'err.empty-command': 'Type a command first.',
  'err.no-testenv': 'This instance has no test environments enabled.',
  'err.no-test-command': 'This project has no start command yet — write one above, e.g. `pnpm install && pnpm dev`.',
}

const TABLES: Record<Lang, Record<MessageKey, string>> = { zh, en }

/** 翻译函数：查表，然后把 `{name}` 换成给的值。 */
export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string

interface Context {
  lang: Lang
  setLang: (lang: Lang) => void
  t: Translate
}

const I18nContext = createContext<Context | null>(null)

/** 手动选过的语言；没选过（或读不到）返回 null，此时以浏览器为准。 */
function storedLang(): Lang | null {
  let value: string | null = null
  try {
    value = localStorage.getItem(KEY)
  } catch {
    // 隐私模式下 localStorage 会抛。当作没选过。
  }
  return value === 'zh' || value === 'en' ? value : null
}

/** 浏览器说的话。认不出来就用英文 —— 这是更保险的那一边。 */
function browserLang(): Lang {
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export function I18nProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [lang, setLangState] = useState<Lang>(() => storedLang() ?? browserLang())

  // html[lang] 跟着走：断词、拼写检查、朗读都看它。
  useEffect(() => { document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en' }, [lang])

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    try {
      localStorage.setItem(KEY, next)
    } catch {
      // 存不下不影响这一次切换，只是刷新后回到跟随浏览器。
    }
  }, [])

  const value = useMemo<Context>(() => {
    const table = TABLES[lang]
    const t: Translate = (key, vars) => {
      const template = table[key]
      if (vars === undefined) return template
      return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
        const value = vars[name]
        return value === undefined ? whole : String(value)
      })
    }
    return { lang, setLang, t }
  }, [lang, setLang])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): Context {
  const context = useContext(I18nContext)
  if (context === null) throw new Error('useI18n 必须在 I18nProvider 内使用')
  return context
}

/** 只要翻译函数的地方用这个 —— 绝大多数组件都是。 */
export function useT(): Translate {
  return useI18n().t
}

/**
 * 表里有这条就照表说，没有就用兜底那句。
 *
 * 服务端会带来我们没预料到的错误码 —— 那时把码和原文一起端出来，
 * 比咽掉它有用得多。
 */
export function maybe(t: Translate, key: string, fallback: string): string {
  return key in zh ? t(key as MessageKey) : fallback
}

/**
 * 「我的卡为什么不动」——把调度器的跳过原因按当前语言组成一句话。
 *
 * 服务端给的 `detail` 是中文的，只在拿不到 `params` 时兜底（老版本 host）。
 */
export function skipMessage(t: Translate, skip: Skip): string {
  const params = skip.params
  if (params === undefined) return skip.detail
  const vars = Object.fromEntries(params.map((value, index) => [String(index), value]))
  if (skip.reason === 'provider-unavailable' && params.length > 0) {
    return t('skip.provider-unavailable.pinned', vars)
  }
  return t(`skip.${skip.reason}`, vars)
}
