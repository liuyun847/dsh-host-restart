/**
 * restart_dsh 的「其它顶层会话正在运行 ⇒ 拒绝重启」准入测试(2026-09-2x 新增,2026-09-21 事故后加固)。
 *
 * 背景:所有标签页/窗口共用同一个 dsh 宿主进程,restart_dsh 会硬杀它(Stop-Process -Force),
 * 新进程只复活发起重启的那一个会话 —— 其它会话的当前轮直接蒸发且不会被接回。
 * 所以多开标签页时重启必须被拒绝,而不是静默毁掉别人的对话。
 *
 * 口径(用户拍板):
 *   · 只拦 status === 'running' 的会话,空闲但开着的标签页放行;
 *   · 只看顶层会话 roots():子代理属于发起者自己(同进程共命),算进去会让"本会话派过子代理"永远无法重启;
 *   · 发起者自己按 session.id 排除;
 *   · 拿不到 agents 服务时 fail-soft 放行(守护不能把工具变成永远不可用)。
 *
 * ⚠ 2026-09-21 事故 + 本文件的加固(动这个文件之前先读完这段):
 *   上一版只 apply 了 { logFile, pendingDir },而决定「启动哪个脚本 / 用哪个 pwsh」的
 *   restartScript(默认 C:\run\tools\dsh-restart.ps1)与 psExe(默认 pwsh)**没被覆盖**,
 *   于是五个"应当放行"的用例真的走通了 writePendingFile → launchDriver → execFile(pwsh, WMI Create):
 *   6~7 秒后真驱动脚本杀掉 dsh,同时掐掉另外两个会话。而它们"看起来通过了" ——
 *   断言等的是测试自己的 logFile,真驱动写的是 C:\run\tools\dsh-restart.log,永远等不到启动确认
 *   ⇒ 换通道再启一次 ⇒ 最后抛错 ⇒ 断言"通过"。假阴性盖住了真实副作用。
 *
 *   现在放行路径有三道互不重叠的防线,**任意一道成立都不可能起真实进程**:
 *     1) 桩点在最底层:apply 的 config 传 `wmiExec` —— 源里唯一会 spawn 的那一步(realExecFile)
 *        被整段替换。放行用例断言"桩被调用了几次、命令行里是哪个脚本路径",而不是某个日志文件的内容。
 *     2) restartScript / psExe 指向 scratch 下**不存在**的路径 ⇒ 桩万一被摘掉,launchDriver 只会拿到 ENOENT。
 *     3) 进程级熔断 DSH_RESTART_NO_LAUNCH=1(本文件顶部设置,另有专门用例证明它真的拦得住)。
 *
 * 副作用边界:只写 scratch 临时目录(日志 + 标记),不碰真实 profile / 标记 / 日志,不起任何进程。
 * 跑法:node --test "test/*.test.mjs"(或 npm test)
 */
import { strict as assert } from 'node:assert'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  DEFAULT_WAIT_SECONDS,
  LAUNCH_TIMEOUT_MS,
  MAX_LISTED_SESSIONS,
  TOOL_NAME,
  apply,
  detectRunningSessions,
  formatOtherSessionsMessage,
} from '../lib/index.js'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-restart-gate-'))
const testLog = join(scratch, 'restart.log')

// ── 防线 3:进程级熔断。必须在任何 execute 之前设好(realExecFile 是调用时才检查它)。
process.env.DSH_RESTART_NO_LAUNCH = '1'
// 日志只走 DSH_RESTART_LOG_FILE 兜底出口(与 inject-coverage 同款做法,避免落真实日志文件)
process.env.DSH_RESTART_LOG_FILE = testLog
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* 忽略 */ } })

// ── 防线 2:假脚本 / 假解释器路径(都不存在)
const FAKE_SCRIPT = join(scratch, 'no-such-driver-dir', 'definitely-missing.ps1')
const FAKE_PS_EXE = join(scratch, 'no-such-pwsh-dir', 'also-missing.exe')
assert.equal(existsSync(FAKE_SCRIPT), false, '假驱动脚本路径必须不存在')
assert.equal(existsSync(FAKE_PS_EXE), false, '假解释器路径必须不存在')

/** 桩回显的 WMI 侧 pid —— 断言"放行后工具报告的到底是什么"时用。 */
const STUB_PID = 42424

/** 假 agent 条目:插件只读 session.id 与 status 两个字段。 */
const topAgent = (id, status) => ({ session: { id }, status })
/** 假子代理条目:owner 非空 ⇒ 不出现在 roots() 里。 */
const subAgent = (id, status) => ({ session: { id }, status, owner: {} })

/** tools 服务桩:拿住 defineTool 的定义以便直接调 execute。 */
function makeTools(sink) {
  return {
    register: (definition) => {
      sink.push(definition)
      return () => {}
    },
  }
}

/**
 * 造一个够用的 cordis ctx 桩。
 * @param services 服务表;键存在即表示该服务已挂载。
 * @param options.servicesThrow true 时访问服务属性抛错(复现"服务未注入/已卸载"的形态)。
 */
function makeCtx(services = {}, options = {}) {
  const handlers = new Map()
  const base = {
    get: (name) => {
      if (options.servicesThrow === true && name in services) {
        throw new Error(`cannot access ctx.${name} without an inject declaration`)
      }
      return services[name]
    },
    on: (event, handler) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    timeout: (fn, ms) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    },
  }
  return {
    ctx: base,
    fire: (event) => { for (const handler of handlers.get(event) ?? []) handler() },
  }
}

/**
 * ── 防线 1:WMI 启动桩 ──
 * 替掉源里唯一会 spawn 的那一步(realExecFile)。收到的参数与真实 execFile 完全同形
 * (file / args / options),所以"桩被调用"等价于"真实链路正要创建进程"。
 * @param options.fail true ⇒ 每次调用都抛错(模拟所有通道都起不来,覆盖撤销标记那条分支)
 * @param options.confirm false ⇒ 不写启动确认行(模拟"进程被创建但脚本没写日志")
 */
function makeLauncherStub(options = {}) {
  const calls = []
  const wmiExec = async (file, args, execOptions) => {
    calls.push({ file, args, options: execOptions })
    if (options.fail === true) throw new Error(`桩:${file} 起不来(模拟通道失败)`)
    // 真实链路里这行是驱动脚本自己写的:启动确认的唯一判据 = 日志里出现本次 SessionId
    const command = typeof args?.[3] === 'string' ? args[3] : ''
    const sessionId = /-SessionId "([^"]+)"/.exec(command)?.[1]
    if (options.confirm !== false && typeof sessionId === 'string') {
      appendFileSync(testLog, `${new Date().toISOString()}  [driver] ===== 重启驱动启动 SessionId=${sessionId}\n`)
    }
    return { stdout: `${STUB_PID}\n`, stderr: '' }
  }
  return { calls, wmiExec }
}

/**
 * 造一次工具调用现场:注册工具 → 取出定义 → 跑 execute。
 * @param services 服务表。
 * @param options.execArgs execute 的第二个参数(默认是一个普通主会话调用)。
 * @param options.stub WMI 启动桩,默认新建一个。
 * @param options.pendingDir 本次调用专属的标记目录,默认新建一个(每条用例互不干扰)。
 * @param options.injectStub false ⇒ 不注入桩,用来单独验证 DSH_RESTART_NO_LAUNCH 熔断。
 */
async function callTool(services, options = {}) {
  const {
    execArgs = {},
    stub = makeLauncherStub(),
    pendingDir = mkdtempSync(join(scratch, 'pending-')),
    injectStub = true,
  } = options
  const registered = []
  const { ctx, fire } = makeCtx({ ...services, tools: makeTools(registered) })
  apply(ctx, {
    logFile: testLog,
    pendingDir,
    // 防线 2:即便桩被摘掉,启动命令里也只有不存在的假路径
    restartScript: FAKE_SCRIPT,
    psExe: FAKE_PS_EXE,
    // 防线 1:替换唯一会 spawn 的那一步
    wmiExec: injectStub ? stub.wmiExec : undefined,
  })
  assert.equal(registered.length, 1, 'tools.register 应当被调用一次')
  assert.equal(registered[0].name, TOOL_NAME)
  const result = await registered[0].execute({}, {
    agent: { session: { id: 'session-self', header: { origin: 'main' } } },
    ...execArgs,
  })
  // 撤掉 apply 排的启动注入定时器:测试不留悬挂副作用
  fire('dispose')
  return { result, stub, pendingDir, pendingFile: join(pendingDir, 'pending.json') }
}

/**
 * 放行路径的硬事实(消除假阴性):守卫放行后**到底做了什么** ——
 * 写下一份可核对的标记,并经启动桩发起**恰好一次**启动;调用 0 次就说明测试压根没走到启动层。
 * @returns 解析后的标记内容,供用例追加断言。
 */
function assertAllowPath({ result, stub, pendingFile }, expected = {}) {
  const sessionId = expected.sessionId ?? 'session-self'
  assert.equal(result.ok, true, `放行用例必须真的发起重启,实际:${result.message}`)
  assert.equal(result.launcherPid, STUB_PID, '工具报告的应当是桩回显的 WMI 侧 pid')
  assert.equal(result.launcherMode, 'headless', '首选通道应当是 conhost --headless')
  assert.equal(result.sessionId, sessionId)
  assert.equal(result.pendingFile, pendingFile)
  assert.equal(result.logFile, testLog)

  assert.equal(stub.calls.length, 1, '放行路径必须且只能调用一次启动桩(0 次说明没走到启动层)')
  const [call] = stub.calls
  assert.equal(call.file, FAKE_PS_EXE, '启动用的解释器必须是测试的假路径')
  assert.deepEqual(call.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'])
  assert.equal(call.options.windowsHide, true)
  assert.equal(call.options.timeout, LAUNCH_TIMEOUT_MS)
  const wmiScript = call.args[3]
  assert.ok(wmiScript.includes('Win32_Process'), '桩收到的应当是一段 Win32_Process.Create 脚本')
  assert.ok(wmiScript.includes(FAKE_SCRIPT), '命令行里必须是假脚本路径')
  assert.ok(!wmiScript.includes('dsh-restart.ps1'), '命令行里绝不能出现真实驱动脚本')
  assert.ok(!wmiScript.includes('C:\\run\\tools'), '命令行里绝不能出现 C:\\run\\tools 下的真实路径')
  assert.ok(wmiScript.includes(`-SessionId "${sessionId}"`), '命令行必须带上发起者会话 id')
  // 实例身份:驱动脚本据此只杀"本实例"的 dsh。测试进程 argv 里没有 profile/端口 ⇒ 只带 pid,
  // 正好同时验证"身份不全时不硬编"。
  assert.ok(wmiScript.includes(`-DshPid ${process.pid}`), '启动命令行必须带发起者宿主 pid')
  assert.ok(!wmiScript.includes('-ProfileName'), 'argv 里认不出 profile 时不该硬编一个')
  assert.ok(wmiScript.includes(`-PendingFile "${pendingFile}"`), '标记路径要传给脚本(旧版插件过渡时的身份兜底)')

  const pending = JSON.parse(readFileSync(pendingFile, 'utf8'))
  assert.equal(pending.version, 1)
  assert.equal(pending.sessionId, sessionId)
  assert.equal(pending.pidBefore, process.pid)
  assert.equal(pending.waitSeconds, expected.waitSeconds ?? DEFAULT_WAIT_SECONDS)
  assert.ok(pending.text.startsWith('已重启。'), '标记里必须带注入正文')
  assert.ok(Math.abs(Date.now() - pending.createdAt) < 60_000, 'createdAt 应当就是刚刚')
  return pending
}

/** 拒绝路径的硬事实:一个字节都不写,也绝不触碰启动桩。 */
function assertNothingHappened({ stub, pendingDir, pendingFile }) {
  assert.equal(stub.calls.length, 0, '拒绝路径不该调用启动桩')
  assert.equal(existsSync(pendingFile), false, '拒绝路径不许写 pending.json')
  const entries = existsSync(pendingDir) ? readdirSync(pendingDir) : []
  assert.deepEqual(entries, [], `拒绝路径不许在 pendingDir 留下任何文件,实际:${entries.join(', ')}`)
}

/** 日志里最后一条"会话检测"行(多条用例共用一个日志文件,取最后一次)。 */
function lastGateLog() {
  const lines = readFileSync(testLog, 'utf8').split('\n').filter((line) => line.includes('会话检测:'))
  return lines.at(-1) ?? ''
}

// ── 纯函数:检测口径 ────────────────────────────────────────────────────────

test('detectRunningSessions:其它顶层 running 被点名,自己的子代理不计入', () => {
  const agents = {
    roots: () => [
      topAgent('session-self', 'running'),
      topAgent('session-other-1', 'running'),
      topAgent('session-idle', 'idle'),
    ],
    list: () => [
      topAgent('session-self', 'running'),
      topAgent('session-other-1', 'running'),
      topAgent('session-idle', 'idle'),
      subAgent('session-sub-1', 'running'),
    ],
  }
  const { ctx } = makeCtx({ agents })
  assert.deepEqual(detectRunningSessions(ctx, 'session-self'), {
    available: true,
    total: 3,
    running: 2,
    others: ['session-other-1'],
  })
})

test('detectRunningSessions:只看顶层 —— 正在跑的子代理不算"其它会话"', () => {
  // roots() 由注册表按 owner===undefined 过滤,子代理天然不在其中
  const agents = {
    roots: () => [topAgent('session-self', 'running')],
    list: () => [topAgent('session-self', 'running'), subAgent('session-sub-1', 'running')],
  }
  const { ctx } = makeCtx({ agents })
  const detected = detectRunningSessions(ctx, 'session-self')
  assert.equal(detected.available, true)
  assert.deepEqual(detected.others, [], '子代理与本会话同进程共命,不能拦住本会话重启')
  assert.equal(detected.total, 1, '只统计顶层会话')
})

test('detectRunningSessions:接口形态不符一律 fail-soft(可读原因,不抛)', () => {
  const cases = [
    [{}, /agents 服务不可用/],
    [{ agents: null }, /agents 服务不可用/],
    [{ agents: {} }, /没有 roots\(\)\/list\(\) 函数/],
    [{ agents: { roots: 'not-a-function', list: 42 } }, /没有 roots\(\)\/list\(\) 函数/],
    [{ agents: { roots: () => 'not-an-array' } }, /不是数组/],
    [{ agents: { roots: () => { throw new Error('registry disposed') } } }, /枚举会话抛错/],
  ]
  for (const [services, pattern] of cases) {
    const { ctx } = makeCtx(services)
    let detected
    assert.doesNotThrow(() => { detected = detectRunningSessions(ctx, 'session-self') }, `${JSON.stringify(Object.keys(services))} 不该抛`)
    assert.equal(detected.available, false)
    assert.match(detected.reason, pattern)
  }
  // 连 ctx.get 都抛(服务未声明/已卸载)时同样不抛
  const { ctx: throwing } = makeCtx({ agents: {} }, { servicesThrow: true })
  const detected = detectRunningSessions(throwing, 'session-self')
  assert.equal(detected.available, false)
  assert.match(detected.reason, /读取 agents 服务抛错/)
})

test('formatOtherSessionsMessage:最多列 3 个 id,超出用"等 N 个"', () => {
  const two = formatOtherSessionsMessage(['session-a', 'session-b'])
  assert.match(two, /检测到 2 个其它会话正在运行/)
  assert.ok(two.includes('`session-a`') && two.includes('`session-b`'))
  assert.ok(!two.includes('等 2 个'))
  assert.match(two, /等它们跑完再重启,或先让它们结束/)

  const five = formatOtherSessionsMessage(['s-1', 's-2', 's-3', 's-4', 's-5'])
  assert.equal(MAX_LISTED_SESSIONS, 3)
  assert.match(five, /检测到 5 个其它会话正在运行/)
  assert.ok(five.includes('`s-3`'))
  assert.ok(!five.includes('`s-4`'), '第 4 个 id 不该被列出')
  assert.ok(five.includes('等 5 个'))
})

// ── 工具层:准入判定 ────────────────────────────────────────────────────────

test('其它顶层会话 running ⇒ 拒绝,且不写标记、不启动任何东西', async () => {
  const writeFileCalls = []
  const scene = await callTool({
    agents: {
      roots: () => [topAgent('session-self', 'running'), topAgent('session-other-a', 'running')],
    },
    fs: { writeFile: (...args) => { writeFileCalls.push(args) } },
  })
  const { result } = scene
  assert.equal(result.ok, false)
  assert.match(result.message, /restart_dsh 未执行:检测到 1 个其它会话正在运行/)
  assert.ok(result.message.includes('`session-other-a`'), '拒绝文案要给出会话 id')
  assert.match(result.message, /等它们跑完再重启,或先让它们结束/)
  assert.equal('launcherPid' in result, false, '拒绝路径不该返回 launcherPid')
  assert.deepEqual(writeFileCalls, [], '拒绝路径不该经 fs 服务写任何文件')
  assertNothingHappened(scene)
  assert.match(lastGateLog(), /会话检测: 顶层会话 2 个\(运行中 2 个\), 其它运行中 1 个/)
})

test('其它顶层会话只 idle(标签页开着但没跑)⇒ 放行:写标记 + 经桩发起一次启动', async () => {
  const scene = await callTool({
    agents: { roots: () => [topAgent('session-self', 'running'), topAgent('session-idle', 'idle')] },
  })
  assertAllowPath(scene)
  assert.ok(!scene.result.message.includes('个其它会话正在运行'), 'idle 的标签页不该被算作拦阻理由')
  assert.match(lastGateLog(), /会话检测: 顶层会话 2 个\(运行中 1 个\), 其它运行中 0 个/)
})

test('只有自己(唯一的 running 顶层会话)⇒ 放行', async () => {
  const scene = await callTool({ agents: { roots: () => [topAgent('session-self', 'running')] } })
  assertAllowPath(scene)
  assert.match(lastGateLog(), /会话检测: 顶层会话 1 个\(运行中 1 个\), 其它运行中 0 个/)
})

test('自己的子代理在跑 ⇒ 放行(回归锁:否则派过子代理就永远无法重启)', async () => {
  const agents = {
    // 注册表按 owner===undefined 给 roots():子代理只出现在 list() 里
    roots: () => [topAgent('session-self', 'running')],
    list: () => [topAgent('session-self', 'running'), subAgent('session-sub-1', 'running'), subAgent('session-sub-2', 'running')],
  }
  const scene = await callTool({ agents })
  assertAllowPath(scene)
  assert.ok(!scene.result.message.includes('个其它会话正在运行'), '子代理不该拦住本会话重启')
  assert.match(lastGateLog(), /会话检测: 顶层会话 1 个\(运行中 1 个\), 其它运行中 0 个/)
})

test('agents 服务缺失 ⇒ 不抛错、记 warn、照常重启(走到启动层)', async () => {
  const scene = await callTool({})
  assertAllowPath(scene, { waitSeconds: 6 })
  assert.ok(!/个其它会话正在运行/.test(scene.result.message))
  assert.match(readFileSync(testLog, 'utf8'), /无法检测其它会话\(agents 服务不可用\),按无其它会话处理,照常重启/)
})

test('agents 服务存在但没有 roots()/list() ⇒ 同样 fail-soft 放行并记原因', async () => {
  const scene = await callTool({ agents: { someOtherApi: () => [] } })
  assertAllowPath(scene)
  assert.match(readFileSync(testLog, 'utf8'), /无法检测其它会话\(agents 服务没有 roots\(\)\/list\(\) 函数\)/)
})

test('放行后所有通道都起不来(桩抛错)⇒ 四个通道都试过、撤销标记、如实报错', async () => {
  const stub = makeLauncherStub({ fail: true })
  const scene = await callTool(
    { agents: { roots: () => [topAgent('session-self', 'running')] } },
    { stub },
  )
  const { result, pendingFile } = scene
  assert.equal(result.ok, false, '启动没成功就不能报成功')
  assert.match(result.message, /^restart_dsh 未执行:驱动脚本启动失败/)
  assert.match(result.message, /headless/)
  assert.match(result.message, /hidden/)
  assert.equal(stub.calls.length, 4, '两个通道 × 两个解释器都要被试过')
  assert.deepEqual(stub.calls.map((call) => call.file), [FAKE_PS_EXE, 'powershell.exe', FAKE_PS_EXE, 'powershell.exe'])
  assert.equal(existsSync(pendingFile), false, '全通道失败必须撤销标记,不能留下"以为重启了"的痕迹')
  assert.match(readFileSync(testLog, 'utf8'), /启动驱动脚本失败,已撤销重启标记/)
})

test('未注入桩时由 DSH_RESTART_NO_LAUNCH=1 熔断兜底:连 execFile 都到不了', async () => {
  assert.equal(process.env.DSH_RESTART_NO_LAUNCH, '1', '本文件顶部必须先设好熔断')
  const stub = makeLauncherStub()
  const scene = await callTool(
    { agents: { roots: () => [topAgent('session-self', 'running')] } },
    { stub, injectStub: false },
  )
  const { result, pendingFile } = scene
  assert.equal(result.ok, false)
  assert.match(result.message, /驱动脚本启动失败/)
  assert.match(result.message, /DSH_RESTART_NO_LAUNCH=1:本进程禁止真实启动驱动脚本/, '必须是熔断拦下的,而不是别的巧合失败')
  assert.equal(stub.calls.length, 0, '熔断发生在 spawn 之前,连桩都不该被调用')
  assert.equal(existsSync(pendingFile), false, '熔断后必须撤销标记')
})

test('拿不到归属会话 / 子代理发起 ⇒ 仍在检测之前就拒绝(原有边界不变)', async () => {
  const orphan = await callTool(
    { agents: { roots: () => [topAgent('session-self', 'running')] } },
    { execArgs: { agent: {} } },
  )
  assert.equal(orphan.result.ok, false)
  assert.match(orphan.result.message, /没有归属会话/)
  assertNothingHappened(orphan)

  const sub = await callTool(
    { agents: { roots: () => [topAgent('session-self', 'running')] } },
    { execArgs: { agent: { session: { id: 'session-self', header: { origin: 'subagent' } } } } },
  )
  assert.equal(sub.result.ok, false)
  assert.match(sub.result.message, /子代理会话不支持重启续跑/)
  assertNothingHappened(sub)
})
