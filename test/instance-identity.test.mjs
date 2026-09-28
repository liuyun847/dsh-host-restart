/**
 * 「重启只杀自己这个实例」的判据测试(2026-09-21 新增)。
 *
 * 背景(teamlab 试跑实测的地雷):dsh 的 profile 名是**位置参数**(`dsh web …` 等价
 * `dsh --profile web`),而旧的杀进程判据是"命令行含 dsh\lib\bin\.js 且含 ' web '" ⇒ 跨实例:
 * 从 teamlab 实例(`bin.js teamlab --port 3090`)里点重启,不会杀它自己,会杀掉生产 web 实例(3080)。
 *
 * 本文件钉住三件事:
 *   1) `resolveInstanceIdentity`:从宿主自己的 argv 里读 pid/profile/端口(两种 profile 形态都认);
 *   2) `matchesInstanceCommandLine`:多实例的一组命令行里**只命中自己** —— 它是驱动脚本里
 *      `Test-DshInstanceCommandLine` 的 JS 镜像,两边正则逐字一致(下面有静态断言钉住这点);
 *   3) 启动命令行把身份带给脚本(`-DshPid`/`-ProfileName`/`-Port`),且 profile 名过白名单。
 *
 * 零副作用:全是纯函数 + 只读静态文件;本文件不 apply 也不 execute 任何插件代码,不起任何进程。
 * 跑法:node --test "test/*.test.mjs"(或 npm test)
 */
import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  DSH_HOST_COMMAND_LINE,
  WAIT_SECONDS,
  buildLauncherCommandLine,
  matchesInstanceCommandLine,
  resolveInstanceIdentity,
} from '../lib/index.js'

// 本机真实形态(取自 2026-09-21 的活进程命令行,已脱敏:不含 token/URL)
const ENTRY = 'C:\\Users\\MLTZ\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const WEB_LINE = `"C:\\Program Files\\nodejs\\node.exe" ${ENTRY} web --no-open --port 3080`
const TEAMLAB_LINE = `"C:\\Program Files\\nodejs\\node.exe" ${ENTRY} teamlab --no-open --port 3090`
/** dsh 子进程 runner 会把整条 PowerShell 命令文本带进命令行 —— 命中了就是误杀别的进程。 */
const RUNNER_LINE = `"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\MLTZ\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai\\dsh-subprocess-local\\lib\\runner.js -- "pwsh.exe" -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'dsh\\lib\\bin.js' }"`

const RESTART_SCRIPT = join('C:\\run\\tools', 'dsh-restart.ps1')
const argv = (...tail) => ['C:\\Program Files\\nodejs\\node.exe', ENTRY, ...tail]

// ── 1) 身份解析 ────────────────────────────────────────────────────────────

test('resolveInstanceIdentity:认位置参数形态(dsh web … —— 本机看门狗就是这么拉的)', () => {
  assert.deepEqual(resolveInstanceIdentity(argv('web', '--no-open', '--port', '3080'), 46948), {
    pid: 46948,
    profile: 'web',
    port: 3080,
  })
  assert.deepEqual(resolveInstanceIdentity(argv('teamlab', '--no-open', '--port', '3090'), 100), {
    pid: 100,
    profile: 'teamlab',
    port: 3090,
  })
})

test('resolveInstanceIdentity:也认显式 --profile / --port= 形态', () => {
  assert.deepEqual(resolveInstanceIdentity(argv('--profile', 'teamlab', '--port=3090'), 7), {
    pid: 7,
    profile: 'teamlab',
    port: 3090,
  })
})

test('resolveInstanceIdentity:带值选项的值不会被当成 profile(--patch 的路径)', () => {
  assert.equal(resolveInstanceIdentity(argv('--patch', './extra.yml', 'tui', '--port', '3080'), 1).profile, 'tui')
  assert.equal(resolveInstanceIdentity(argv('--from-default-profile', 'web', 'tui'), 1).profile, 'tui')
  // `dsh plugin …` 不是 boot,没有 profile
  assert.equal(resolveInstanceIdentity(argv('plugin', 'add', 'x'), 1).profile, undefined)
})

test('resolveInstanceIdentity:认不出来就返回 undefined,绝不猜', () => {
  // 没有 dsh 入口脚本(测试进程自己就是这样:node --test …)
  assert.deepEqual(resolveInstanceIdentity(['C:\\Program Files\\nodejs\\node.exe', 'C:\\x\\session-gate.test.mjs'], 5), {
    pid: 5,
    profile: undefined,
    port: undefined,
  })
  assert.equal(resolveInstanceIdentity(argv('web', '--port', 'abc'), 1).port, undefined)
  assert.equal(resolveInstanceIdentity(argv('web', '--port', '99999'), 1).port, undefined)
  assert.equal(resolveInstanceIdentity(argv('../evil', '--port', '3080'), 1).profile, undefined, '带路径分隔符的名字不是合法 profile 名')
  assert.equal(resolveInstanceIdentity(argv('web'), 0).pid, undefined, '非法 pid 不返回')
})

// ── 2) 判据:多实例下只命中自己 ─────────────────────────────────────────────

/** 在一组候选命令行里按身份挑出"本实例" —— 驱动脚本 Get-InstanceDshProcess 的等价操作。 */
const selectCandidates = (identity, candidates = [WEB_LINE, TEAMLAB_LINE, RUNNER_LINE]) =>
  candidates.filter((line) => matchesInstanceCommandLine(line, identity))

test('多 profile 下只命中自己:teamlab(--port 3090)绝不选中 web(--port 3080)', () => {
  // 这就是事故现场:teamlab 实例发起重启,只允许杀 teamlab 那一行
  assert.deepEqual(selectCandidates({ profile: 'teamlab', port: 3090 }), [TEAMLAB_LINE])
  assert.deepEqual(selectCandidates({ profile: 'web', port: 3080 }), [WEB_LINE])
  // 只有一端可判时也够用:端口在本机是独占的;profile 相同而端口不同才算歧义
  assert.deepEqual(selectCandidates({ port: 3090 }), [TEAMLAB_LINE])
  assert.deepEqual(selectCandidates({ profile: 'web' }), [WEB_LINE])
  assert.deepEqual(selectCandidates({ profile: 'tui', port: 3080 }), [], '不存在的实例一个都不匹配')
})

test('matchesInstanceCommandLine:边界(runner 自匹配 / 端口前缀 / 路径里的 web)', () => {
  assert.equal(matchesInstanceCommandLine(WEB_LINE, { profile: 'web', port: 3080 }), true)
  assert.equal(matchesInstanceCommandLine(RUNNER_LINE, { profile: 'web', port: 3080 }), false,
    'runner 的命令行里提到过 bin.js,但它不是 dsh 宿主')
  assert.equal(matchesInstanceCommandLine(WEB_LINE, { port: 30800 }), false, '30800 不能被 3080 命中')
  assert.equal(
    matchesInstanceCommandLine(`"node.exe" ${ENTRY} --cwd C:\\work\\web-project --port 3080`, { profile: 'web' }),
    false,
    '路径里的 web-project 不是 profile token',
  )
  assert.equal(matchesInstanceCommandLine(`"node.exe" ${ENTRY} --profile=web --port=3080`, { profile: 'web', port: 3080 }), true)
  assert.equal(matchesInstanceCommandLine('', { profile: 'web' }), false)
  assert.equal(matchesInstanceCommandLine(undefined, {}), false)
  // 身份为空对象时只校验"是不是 dsh 宿主",不代表认得出是谁
  assert.equal(matchesInstanceCommandLine(WEB_LINE, {}), true)
})

// ── 3) 身份随启动命令行传给驱动脚本 ─────────────────────────────────────────

test('buildLauncherCommandLine:身份三件套随命令行传给脚本', () => {
  const line = buildLauncherCommandLine({
    psExe: 'pwsh',
    mode: 'headless',
    scriptPath: RESTART_SCRIPT,
    sessionId: 'session-abc',
    waitSeconds: WAIT_SECONDS,
    identity: { pid: 4242, profile: 'teamlab', port: 3090 },
    pendingFile: 'C:\\Users\\MLTZ\\.dsh\\storages\\dsh-restart\\pending.json',
  })
  assert.ok(line.includes('-DshPid 4242'), line)
  assert.ok(line.includes('-ProfileName "teamlab"'), line)
  assert.ok(line.includes('-Port 3090'), line)
  assert.ok(line.includes('-SessionId "session-abc"'), line)
  assert.ok(line.includes('-PendingFile "C:\\Users\\MLTZ\\.dsh\\storages\\dsh-restart\\pending.json"'), line)
  assert.ok(line.includes('conhost.exe --headless'), '首选通道不变')
})

test('buildLauncherCommandLine:身份缺失时不硬编,也不接受可疑 profile 名', () => {
  const base = { psExe: 'pwsh', mode: 'hidden', scriptPath: RESTART_SCRIPT, sessionId: 's', waitSeconds: WAIT_SECONDS }
  const noIdentity = buildLauncherCommandLine(base)
  assert.ok(!noIdentity.includes('-DshPid'), noIdentity)
  assert.ok(!noIdentity.includes('-ProfileName'), noIdentity)
  assert.ok(!noIdentity.includes('-Port'), noIdentity)

  // profile 名来自 argv,必须过白名单才允许拼进命令行(否则可注入额外参数)
  const evil = buildLauncherCommandLine({ ...base, identity: { pid: 1, profile: 'web" -KillScript "x', port: 3080 } })
  assert.ok(!evil.includes('-ProfileName'), evil)
  assert.ok(evil.includes('-DshPid 1') && evil.includes('-Port 3080'), evil)
  const badPort = buildLauncherCommandLine({ ...base, identity: { pid: 1, port: 70000 } })
  assert.ok(!badPort.includes('-Port'), badPort)
})

// ── 4) 与驱动脚本的一致性(静态护栏) ───────────────────────────────────────

test('驱动脚本用的是同一套判据(静态护栏:正则逐字一致 + 旧宽松判据已消失)', (t) => {
  if (!existsSync(RESTART_SCRIPT)) {
    t.skip(`未找到 ${RESTART_SCRIPT}(非本机或已卸载),跳过`)
    return
  }
  const source = readFileSync(RESTART_SCRIPT, 'utf8')
  // 两边共用同一个正则源串:改一边不改另一边会在这里炸
  assert.ok(source.includes(DSH_HOST_COMMAND_LINE.source), 'ps1 里的宿主判据正则必须与 DSH_HOST_COMMAND_LINE 逐字一致')
  assert.ok(source.includes('--port[\\s=]+'), 'ps1 里的端口判据必须与 JS 镜像一致')
  assert.ok(source.includes('function Test-DshInstanceCommandLine'), '判据函数必须在')
  assert.ok(source.includes('[int]$DshPid') && source.includes('[string]$ProfileName'), '身份参数必须在')
  assert.ok(source.includes('exit 4'), 'fail closed 的退出码必须在')
  // 旧版插件(不传身份参数)的过渡路径:必须能从重启标记的 pidBefore 兜底认出宿主
  assert.ok(source.includes('pidBefore'), '标记兜底(pidBefore)必须在,否则加载新插件的第一次重启会空转')
  // 旧判据与跨实例的杀进程脚本都不能再出现
  assert.ok(!source.includes("-match ' web '"), '旧判据"命令行含 web"必须已删除')
  assert.ok(!source.includes('Get-LiveDshProcess'), '旧的宽松扫描函数必须已删除')
  assert.ok(!source.includes('cmd.exe /c'), '不得再调用 kill_dsh.bat(判据跨实例)')
})
