/**
 * 开机自启。
 *
 * 自动认领的价值在于"关掉浏览器去睡觉，回来全在 Review"，而那要求进程一直
 * 活着。这里生成对应平台的用户级服务单元 —— **用户级**，不碰系统目录，
 * 也不需要 sudo。
 *
 * 装与卸都会把要执行的命令原样打印出来。改动用户机器上的常驻配置这件事，
 * 不该在他看不见的地方发生。
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { capture } from '../agents/discover.ts'

/** 服务标识。反写域名是 launchd 的惯例，systemd 只取文件名。 */
export const SERVICE_LABEL = 'dev.loopkanban.agent'

export interface ServicePlan {
  readonly platform: 'darwin' | 'linux'
  /** 单元文件落盘位置。 */
  readonly unitPath: string
  readonly unitContent: string
  /** 装好之后要跑的命令。 */
  readonly enableCommands: readonly string[][]
  readonly disableCommands: readonly string[][]
}

export interface ServiceContext {
  /** `loopkanban` 可执行文件的绝对路径。 */
  readonly bin: string
  readonly nodePath: string
  readonly port?: number
  readonly dataDir?: string
}

/** 服务启动时的完整命令行。 */
function argv(context: ServiceContext): string[] {
  const args = [context.nodePath, context.bin, '--no-open']
  if (context.port !== undefined) args.push('--port', String(context.port))
  if (context.dataDir !== undefined) args.push('--data', context.dataDir)
  return args
}

function darwinPlan(context: ServiceContext): ServicePlan {
  const unitPath = join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
  const args = argv(context)
  const logDir = join(homedir(), 'Library', 'Logs', 'loopkanban')
  const unitContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(join(logDir, 'out.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(logDir, 'err.log'))}</string>
</dict>
</plist>
`
  return {
    platform: 'darwin',
    unitPath,
    unitContent,
    enableCommands: [['launchctl', 'load', '-w', unitPath]],
    disableCommands: [['launchctl', 'unload', '-w', unitPath]],
  }
}

function linuxPlan(context: ServiceContext): ServicePlan {
  const unitPath = join(
    process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'),
    'systemd', 'user', 'loopkanban.service',
  )
  const unitContent = `[Unit]
Description=LoopKanban agent dispatch
After=network.target

[Service]
Type=simple
ExecStart=${argv(context).map(shellQuote).join(' ')}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
  return {
    platform: 'linux',
    unitPath,
    unitContent,
    enableCommands: [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'loopkanban.service'],
    ],
    disableCommands: [['systemctl', '--user', 'disable', '--now', 'loopkanban.service']],
  }
}

/**
 * 算出该平台的安装方案，但**不执行**。
 * @param context - 可执行文件路径与启动参数。
 * @throws 平台不支持时抛出。
 */
export function planService(context: ServiceContext): ServicePlan {
  if (process.platform === 'darwin') return darwinPlan(context)
  if (process.platform === 'linux') return linuxPlan(context)
  throw new Error(`暂不支持在 ${process.platform} 上安装为服务，请自行配置开机启动。`)
}

export interface ServiceOutcome {
  readonly plan: ServicePlan
  readonly ran: readonly { argv: readonly string[]; code: number | null }[]
}

/**
 * 落盘单元文件并启用服务。
 * @param plan - {@link planService} 的结果。
 */
export async function installService(plan: ServicePlan): Promise<ServiceOutcome> {
  await mkdir(join(plan.unitPath, '..'), { recursive: true })
  await writeFile(plan.unitPath, plan.unitContent, 'utf8')
  const ran: ServiceOutcome['ran'][number][] = []
  for (const command of plan.enableCommands) {
    const { code } = await capture(command, 30_000)
    ran.push({ argv: command, code })
  }
  return { plan, ran }
}

/**
 * 停用并删除单元文件。
 * @param plan - {@link planService} 的结果。
 */
export async function uninstallService(plan: ServicePlan): Promise<ServiceOutcome> {
  const ran: ServiceOutcome['ran'][number][] = []
  for (const command of plan.disableCommands) {
    // 本来就没装时这些命令会失败，那不是错误，如实记下就好。
    const { code } = await capture(command, 30_000).catch(() => ({ code: null }))
    ran.push({ argv: command, code })
  }
  await rm(plan.unitPath, { force: true })
  return { plan, ran }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** systemd 的 ExecStart 不走 shell，但含空格的路径仍需引号。 */
function shellQuote(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replace(/(["\\$`])/g, '\\$1')}"` : value
}
