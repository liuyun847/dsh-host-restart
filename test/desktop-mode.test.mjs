/**
 * 桌面端(Electron)重启判据测试(2026-09-30 新增,v0.6.0)。
 *
 * 背景:本机 DSH 于 2026-09-30 从 web 端切到官方桌面端 `0.2.0-rc.2`,而 v0.5.0 的两处判据在桌面端
 * **双双失效**(实测):后端是 `DeepSeek Harness.exe`(Electron 的 Node 模式子进程),既不是 node.exe、
 * 也没有 `dsh\lib\bin.js`;看门狗自启已停用、桌面端也没有 3080。桌面端只有一种可行语义 = **整树重启**
 * (Host 一死,Electron 主进程会走"崩溃恢复"弹原生对话框,那条路要人点,不能当自动化用)。
 *
 * 本文件钉住四件事:
 *   1) `isDesktopHostArgv` / `resolveInstanceIdentity`:认出桌面端,身份 = pid + exe 路径 + 端口;
 *   2) `normalizeExePath`:命令行里取 exe 路径的规则(它是 ps1 `Get-CommandLineExePath` 的 JS 镜像);
 *   3) `matchesInstanceCommandLine` 的桌面分支 + `buildLauncherCommandLine` 把 `-Mode desktop`
 *      / `-DesktopExe` 传给脚本,且可疑 exe 路径不拼进命令行;
 *   4) 与驱动脚本的一致性(静态护栏):ps1 里必须有桌面分支、必须 fail closed、必须有演练开关。
 *
 * 零副作用:全是纯函数 + 只读静态文件;不 apply 也不 execute 插件代码,不起任何进程。
 * 跑法:node --test "test/*.test.mjs"(或 npm test)
 */
import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  DEFAULT_DESKTOP_PORT,
  DEFAULT_RESTART_SCRIPT,
  buildLauncherCommandLine,
  isDesktopHostArgv,
  matchesInstanceCommandLine,
  normalizeExePath,
  resolveInstanceIdentity,
} from '../lib/index.js'

// 本机真实形态(2026-09-30 取自活进程命令行,已截去无关尾部)
const EXE = 'C:\\Users\\tester\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe'
const HOST_ENTRY = 'C:\\Users\\tester\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js'
const RUNTIME = 'C:\\Users\\tester\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh'
const PROJECT = 'C:\\Users\\tester\\.dsh\\profiles\\desktop'

/**
 * 后端 Host 子进程(插件就跑在这里面)的真实 **argv**。
 * ⚠ 这里**没有** `--expose-internals`:它是 Node 自己的选项,**会被 Node 消费掉、不进 `process.argv`**
 * —— 2026-09-30 实测踩到过(第一版判据要求"两个 token 都要有",于是桌面端被认成 web:
 * 日志打出 `apply: v0.6.0 mode=web`)。它只在 `Win32_Process.CommandLine` 那种原始命令行字符串里可见。
 */
const HOST_ARGV = [
  EXE,
  HOST_ENTRY,
  RUNTIME,
  PROJECT,
  'C:\\Users\\tester\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime',
  'C:\\Users\\tester\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\pnpm\\bin\\pnpm.mjs',
  'C:\\Users\\tester\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\bin',
]
/** 同一条进程的**原始命令行**(取自 Win32_Process.CommandLine,含 --expose-internals) */
const HOST_COMMAND_LINE = `"${EXE}" --expose-internals "${HOST_ENTRY}" "${RUNTIME}"`
/** 主进程:命令行就是 exe 本身(实测,无任何参数) */
const MAIN_ARGV = [EXE]
/** 渲染进程:有 --type= */
const RENDERER_ARGV = [EXE, '--type=renderer', `--user-data-dir=C:\\Users\\tester\\AppData\\Roaming\\@deepseek-ai/dsh-desktop`]
/** 工具子进程壳(dsh-subprocess-local 的 runner):同一 exe、命令行里提到入口路径,但**不是**宿主 */
const RUNNER_ARGV = [EXE, `${RUNTIME}\\node_modules\\@deepseek-ai\\dsh-subprocess-local\\lib\\runner.js`, '--', 'pwsh.exe']
/** web 宿主(退役但仍在的另一条路):不能被桌面判据命中 */
const WEB_ARGV = ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js', 'web', '--no-open', '--port', '3080']

// 驱动脚本的**默认落点**(`<DSH_HOME>\tools\dsh-restart.ps1`):装在别处时下面两条交叉校验按"非本机"跳过
const RESTART_SCRIPT = DEFAULT_RESTART_SCRIPT

// ── 1) 认出桌面端 ──────────────────────────────────────────────────────────

test('isDesktopHostArgv:桌面端 Host 命中,web 宿主 / 渲染进程 / 工具壳都不命中', () => {
  assert.equal(isDesktopHostArgv(HOST_ARGV), true)
  assert.equal(isDesktopHostArgv(MAIN_ARGV), false, 'Electron 主进程不是宿主(插件不在里面跑)')
  assert.equal(isDesktopHostArgv(RENDERER_ARGV), false)
  assert.equal(isDesktopHostArgv(RUNNER_ARGV), false, '工具子进程壳只是提到入口路径,不是宿主')
  assert.equal(isDesktopHostArgv(WEB_ARGV), false, 'web 宿主的 argv 里是 dsh\\lib\\bin.js')
  assert.equal(isDesktopHostArgv([]), false)
})

test('isDesktopHostArgv:判据**不依赖 --expose-internals**(Node 会消费它,process.argv 里没有)', () => {
  // 真实 argv(无 --expose-internals)必须命中 —— 这条就是 2026-09-30 那次"认成 web"的回归锁
  assert.ok(!HOST_ARGV.includes('--expose-internals'), '真实 argv 里不该有它')
  assert.equal(isDesktopHostArgv(HOST_ARGV), true)
  // 原始命令行(含它)同样命中 —— 两条来源给出的结论必须一致
  assert.equal(isDesktopHostArgv(['--expose-internals', HOST_ENTRY, RUNTIME]), true)
  assert.ok(HOST_COMMAND_LINE.includes('--expose-internals'), '原始命令行里确实有它')
})

test('resolveInstanceIdentity:桌面端返回 mode/pid/exe/port,不再有 profile', () => {
  const identity = resolveInstanceIdentity(HOST_ARGV, 28564, EXE)
  assert.deepEqual(identity, { mode: 'desktop', pid: 28564, exe: EXE, port: undefined })
  assert.equal(identity.profile, undefined, '桌面端没有 profile 位置参数')
})

test('resolveInstanceIdentity:桌面端端口从 argv 读(--port 19387,桌面主进程硬编码传给 Host)', () => {
  const withPort = [...HOST_ARGV, '--no-open', '--port', '19387']
  assert.equal(resolveInstanceIdentity(withPort, 1, EXE).port, 19387)
  // 形态不对/越界的端口不认(与 web 分支同一套白名单)
  assert.equal(resolveInstanceIdentity([...HOST_ARGV, '--port', 'abc'], 1, EXE).port, undefined)
  assert.equal(resolveInstanceIdentity([...HOST_ARGV, '--port', '99999'], 1, EXE).port, undefined)
})

test('resolveInstanceIdentity:exe 只接受绝对路径且不含双引号(它要拼进脚本命令行)', () => {
  assert.equal(resolveInstanceIdentity(HOST_ARGV, 1, EXE).exe, EXE)
  assert.equal(resolveInstanceIdentity(HOST_ARGV, 1, 'DeepSeek Harness.exe').exe, undefined, '相对路径不认')
  assert.equal(resolveInstanceIdentity(HOST_ARGV, 1, `${EXE}" -Mode web`).exe, undefined, '带引号就能注入额外参数')
  // 注意:传 undefined 会走默认参数(= process.execPath,测试进程里就是 node.exe 的绝对路径),
  // 所以"拿不到 exe"要用空串来模拟
  assert.equal(resolveInstanceIdentity(HOST_ARGV, 1, '').exe, undefined, '空路径不认')
  assert.equal(resolveInstanceIdentity(HOST_ARGV, 1).exe, process.execPath, '默认参数就是 process.execPath')
  assert.equal(resolveInstanceIdentity(HOST_ARGV, 0, EXE).pid, undefined, '非法 pid 不返回')
})

test('resolveInstanceIdentity:web 形态不受影响(桌面判据不误伤)', () => {
  assert.deepEqual(resolveInstanceIdentity(WEB_ARGV, 4242, 'C:\\Program Files\\nodejs\\node.exe'), {
    pid: 4242,
    profile: 'web',
    port: 3080,
  })
})

// ── 2) exe 路径规范化(ps1 Get-CommandLineExePath 的 JS 镜像)───────────────

test('normalizeExePath:剥引号 / 统一分隔符 / 转小写', () => {
  assert.equal(normalizeExePath(`"${EXE}"`), EXE.toLowerCase())
  assert.equal(normalizeExePath(`"${EXE}" --type=renderer`), EXE.toLowerCase())
  assert.equal(normalizeExePath(EXE.replace(/\\/g, '/')), EXE.toLowerCase(), '正斜杠等价')
  assert.equal(normalizeExePath(`"${EXE.toUpperCase()}"`), EXE.toLowerCase(), '大小写不敏感')
  assert.equal(normalizeExePath(''), '')
  assert.equal(normalizeExePath(undefined), '')
  assert.equal(normalizeExePath('   '), '')
})

test('normalizeExePath:真实命令行里能取出 exe(带空格路径必须靠引号切分)', () => {
  assert.equal(normalizeExePath(`"${EXE}"`), EXE.toLowerCase())
  // 裸路径(没有外层引号)必须原样返回 —— 这里踩过一次真缺陷:按"第一个空格"切分会把
  // `…\DeepSeek Harness.exe` 截成 `…\DeepSeek`,于是"同一安装的进程"永远匹配不上。
  assert.equal(normalizeExePath(EXE), EXE.toLowerCase(), '裸路径不能被空格切分')
  assert.equal(normalizeExePath(EXE.replace(/\\/g, '/')), EXE.toLowerCase(), '裸路径的正斜杠同样等价')
  // 命令行形态且**没有引号**时,开头的裸路径被当成"整条命令行都是路径"原样保留(不再按空格切分)
  assert.equal(normalizeExePath(`${EXE} --type=renderer`), `${EXE} --type=renderer`.toLowerCase())
})

// ── 3) 判据:桌面端只命中同一安装的进程 ────────────────────────────────────

test('matchesInstanceCommandLine:桌面端按 exe 路径命中(整棵树的进程都算)', () => {
  // 不带端口的身份 = 纯 exe 判据:同一 exe 的各个进程都命中(桌面端要杀的正是整棵树)
  const byExe = { mode: 'desktop', pid: 28564, exe: EXE }
  assert.equal(matchesInstanceCommandLine(`"${EXE}"`, byExe), true, '主进程')
  assert.equal(matchesInstanceCommandLine(`"${EXE}" --type=renderer`, byExe), true, '渲染进程')
  assert.equal(matchesInstanceCommandLine(`"${EXE}" --expose-internals "${HOST_ENTRY}"`, byExe), true, '后端 Host')
  // 别的安装位置 / 别的 exe 一律不命中(用户 2026-09-30 选定"只杀同一安装路径")
  assert.equal(matchesInstanceCommandLine('"C:\\Other\\DeepSeek Harness.exe"', byExe), false)
  assert.equal(matchesInstanceCommandLine('"C:\\Program Files\\nodejs\\node.exe" x\\bin.js web', byExe), false)
  assert.equal(matchesInstanceCommandLine('', byExe), false)

  // 带端口的身份 = exe + 端口两条判据都过才算(主进程命令行里没有 --port,所以它不命中 —— 这正是
  // "按身份扫描主进程"时不能拿带端口的身份去扫的原因;根进程的确定走父子关系,见 ps1 Test-DesktopTreeMember)
  const withPort = { mode: 'desktop', exe: EXE, port: 19387 }
  assert.equal(matchesInstanceCommandLine(`"${EXE}"`, withPort), false, '主进程命令行没有 --port')
  assert.equal(matchesInstanceCommandLine(`"${EXE}" --expose-internals "${HOST_ENTRY}" --port 19387`, withPort), true, '后端 Host 带端口')
  assert.equal(matchesInstanceCommandLine(`"${EXE}" --port 19387`, withPort), true)
  assert.equal(matchesInstanceCommandLine(`"${EXE}" --port 193870`, withPort), false, '193870 不能被 19387 命中')
})

test('matchesInstanceCommandLine:web 分支行为一字不变', () => {
  const webLine = `"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web --no-open --port 3080`
  assert.equal(matchesInstanceCommandLine(webLine, { profile: 'web', port: 3080 }), true)
  assert.equal(matchesInstanceCommandLine(webLine, { profile: 'teamlab', port: 3090 }), false)
  // 桌面身份传给 web 命令行时不该命中(判据互不串台)
  assert.equal(matchesInstanceCommandLine(webLine, { mode: 'desktop', exe: EXE }), false)
})

// ── 4) 身份随启动命令行传给驱动脚本 ───────────────────────────────────────

test('buildLauncherCommandLine:桌面端传 -Mode desktop 与 -DesktopExe', () => {
  const line = buildLauncherCommandLine({
    psExe: 'pwsh',
    mode: 'headless',
    scriptPath: RESTART_SCRIPT,
    sessionId: 'session-abc',
    waitSeconds: 2,
    identity: { mode: 'desktop', pid: 27936, exe: EXE, port: 19387 },
    pendingFile: 'C:\\Users\\tester\\.dsh\\storages\\dsh-restart\\pending.json',
  })
  assert.ok(line.includes('-Mode desktop'), line)
  assert.ok(line.includes(`-DesktopExe "${EXE}"`), line)
  assert.ok(line.includes('-DshPid 27936'), line)
  assert.ok(line.includes('-Port 19387'), line)
  assert.ok(!line.includes('-ProfileName'), '桌面端没有 profile,不该传')
  assert.ok(line.includes('conhost.exe --headless'), '首选通道不变')
})

test('buildLauncherCommandLine:桌面端拿不到合法 exe 时不传 -DesktopExe(脚本侧 fail closed)', () => {
  const base = {
    psExe: 'pwsh', mode: 'headless', scriptPath: RESTART_SCRIPT, sessionId: 's', waitSeconds: 2,
    identity: { mode: 'desktop', pid: 1, port: 19387 },
  }
  const line = buildLauncherCommandLine(base)
  assert.ok(line.includes('-Mode desktop'), line)
  assert.ok(!line.includes('-DesktopExe'), line)
  // 可疑 exe(带引号 / 相对路径 / 非 Windows 绝对路径)一律不拼进命令行
  for (const evil of [`${EXE}" -Mode web`, 'DeepSeek Harness.exe', '/usr/bin/x']) {
    const bad = buildLauncherCommandLine({ ...base, identity: { mode: 'desktop', pid: 1, exe: evil, port: 19387 } })
    assert.ok(!bad.includes('-DesktopExe'), `${evil} 不该被拼进命令行:${bad}`)
  }
})

test('buildLauncherCommandLine:web 端行为一字不变(不带 -Mode/-DesktopExe)', () => {
  const line = buildLauncherCommandLine({
    psExe: 'pwsh',
    mode: 'headless',
    scriptPath: RESTART_SCRIPT,
    sessionId: 'session-abc',
    waitSeconds: 2,
    identity: { pid: 4242, profile: 'web', port: 3080 },
  })
  assert.ok(!line.includes('-Mode'), line)
  assert.ok(!line.includes('-DesktopExe'), line)
  assert.ok(line.includes('-ProfileName "web"') && line.includes('-Port 3080'), line)
})

test('DEFAULT_DESKTOP_PORT:与官方桌面端硬编码的端口一致(19387)', () => {
  // 取值来源:dsh-desktop-host 的 runProfile args ['--no-open','--port','19387'](本机 0.2.0-rc.2 实测)
  assert.equal(DEFAULT_DESKTOP_PORT, 19387)
})

// ── 5) 与驱动脚本的一致性(静态护栏) ───────────────────────────────────────

test('驱动脚本有桌面分支:身份/exe 判据/先杀后起/fail closed/演练开关都在', (t) => {
  if (!existsSync(RESTART_SCRIPT)) {
    t.skip(`未找到 ${RESTART_SCRIPT}(非本机或已卸载),跳过`)
    return
  }
  const source = readFileSync(RESTART_SCRIPT, 'utf8')
  // 参数与模式校验
  assert.ok(source.includes('[string]$Mode'), 'ps1 必须有 -Mode 参数')
  assert.ok(source.includes('[string]$DesktopExe'), 'ps1 必须有 -DesktopExe 参数')
  assert.ok(source.includes("[switch]$DesktopDryRun"), 'ps1 必须有演练开关(离线自测用)')
  assert.ok(source.includes("$Mode -ne 'web' -and $Mode -ne 'desktop'"), '未知模式必须 fail loud')
  // 判据函数
  assert.ok(source.includes('function Get-CommandLineExePath'), 'exe 路径判据函数必须在')
  assert.ok(source.includes('function Get-DesktopAppProcess'), '按 exe 扫描的函数必须在')
  assert.ok(source.includes('function Test-DesktopTreeMember'), '"属于本树"判据必须在(pid 校验用它)')
  assert.ok(!source.includes('Test-DesktopMainProcess'), '旧的主进程判据必须已删除(不留两份重复逻辑)')
  // ⚠ 回归锁(2026-09-30 真机验收踩到的坑):插件注入的 pid 是**后端 Host** 的 pid,不是 Electron 主进程;
  // 若 pid 校验要求"必须是主进程",桌面端永远重启不了(实测 fail closed 退出 4)
  assert.ok(source.includes('Test-DesktopTreeMember -Process $exact'), 'pid 校验必须用"属于本树"判据')
  assert.ok(!source.includes('Test-DesktopMainProcess -Process $exact'), 'pid 校验不得要求它是主进程')
  // 关键语义
  assert.ok(source.includes('先杀旧、后起新') || source.includes('单实例锁'), '必须写明先杀后起与单实例锁')
  assert.ok(source.includes('Start-Process -FilePath $DesktopExe'), '冷启动必须用 Start-Process 起同一个 exe')
  assert.ok(source.includes('Test-TcpPort -TargetPort $Port'), '就绪判据必须含端口探测')
  assert.ok(source.includes('exit 4'), 'fail closed 的退出码必须在')
  // 桌面模式不许走 web 的老路
  const desktopBlock = source.slice(source.indexOf("if ($Mode -eq 'desktop') {"), source.indexOf('# ── 1.5) 本实例身份与目标进程'))
  assert.ok(desktopBlock.length > 2000, '桌面分支的代码块必须存在')
  assert.ok(!desktopBlock.includes('dsh-last-url'), '桌面端不写 dsh-last-url.txt(没有 token URL)')
  assert.ok(!desktopBlock.includes('Get-LiveWatchdogProcess'), '桌面端不探看门狗')
  assert.ok(!desktopBlock.includes('Invoke-SelfLaunchDsh'), '桌面端不走 web 的自行拉起分支')
})

test('驱动脚本的启动行带 Mode(插件的启动确认就认它)', (t) => {
  if (!existsSync(RESTART_SCRIPT)) {
    t.skip(`未找到 ${RESTART_SCRIPT},跳过`)
    return
  }
  const source = readFileSync(RESTART_SCRIPT, 'utf8')
  assert.ok(source.includes('Mode={1}'), '启动行必须回显 Mode —— 插件用 "Mode=desktop" 做启动确认')
})
