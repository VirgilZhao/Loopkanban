import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { planService, SERVICE_LABEL } from '../src/service/index.ts'

const context = {
  bin: '/opt/openkanban/dist/openkanban.js',
  nodePath: '/usr/local/bin/node',
}

const onDarwin = process.platform === 'darwin'
const onLinux = process.platform === 'linux'

describe('planService', () => {
  it('只生成方案，不碰文件系统', () => {
    if (!onDarwin && !onLinux) return
    const plan = planService(context)
    expect(plan.unitContent.length).toBeGreaterThan(0)
    expect(plan.enableCommands.length).toBeGreaterThan(0)
    // 单元文件在用户目录下 —— 用户级服务，不需要 sudo，也不碰系统目录。
    expect(plan.unitPath.startsWith(homedir())).toBe(true)
  })

  it('服务启动时不弹浏览器 —— 后台常驻不该每次开机弹一个标签页', () => {
    if (!onDarwin && !onLinux) return
    expect(planService(context).unitContent).toContain('--no-open')
  })

  it('端口与数据目录被带进启动参数', () => {
    if (!onDarwin && !onLinux) return
    const plan = planService({ ...context, port: 7373, dataDir: '/data/ok' })
    expect(plan.unitContent).toContain('7373')
    expect(plan.unitContent).toContain('/data/ok')
  })

  it.runIf(onDarwin)('macOS 生成 launchd plist 并注册开机启动与崩溃重启', () => {
    const plan = planService(context)
    expect(plan.platform).toBe('darwin')
    expect(plan.unitPath).toContain('LaunchAgents')
    expect(plan.unitContent).toContain(`<string>${SERVICE_LABEL}</string>`)
    expect(plan.unitContent).toContain('<key>RunAtLoad</key><true/>')
    expect(plan.unitContent).toContain('<key>KeepAlive</key><true/>')
    expect(plan.enableCommands[0]).toEqual(['launchctl', 'load', '-w', plan.unitPath])
  })

  it.runIf(onDarwin)('plist 里的路径被 XML 转义 —— 含 & 的路径不该破坏文件结构', () => {
    const plan = planService({ ...context, dataDir: '/data/a&b<c>' })
    expect(plan.unitContent).toContain('&amp;')
    expect(plan.unitContent).not.toContain('a&b')
  })

  it.runIf(onLinux)('Linux 生成 systemd user unit', () => {
    const plan = planService(context)
    expect(plan.platform).toBe('linux')
    expect(plan.unitPath).toContain('systemd/user')
    expect(plan.unitContent).toContain('Restart=on-failure')
    expect(plan.enableCommands.at(-1)).toEqual(
      ['systemctl', '--user', 'enable', '--now', 'openkanban.service'],
    )
  })

  it.runIf(onLinux)('含空格的路径被引号包住', () => {
    const plan = planService({ ...context, dataDir: '/data/with space' })
    expect(plan.unitContent).toContain('"/data/with space"')
  })

  it('停用命令与启用命令是对称的', () => {
    if (!onDarwin && !onLinux) return
    const plan = planService(context)
    expect(plan.disableCommands.length).toBeGreaterThan(0)
    expect(plan.disableCommands.flat().join(' ')).not.toContain('enable --now')
  })
})
