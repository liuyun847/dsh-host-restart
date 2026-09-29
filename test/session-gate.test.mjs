/**
 * restart_dsh 的「其它会话还有活在跑」检测测试
 * (2026-09-2x 新增,2026-09-21 事故后加固,2026-09-27 扩口径,2026-09-28 **不再拒绝**)。
 *
 * 背景:所有标签页/窗口共用同一个 dsh 宿主进程,restart_dsh 会硬杀它(Stop-Process -Force),
 * 新进程只复活发起重启的那一个会话 —— 其它会话正在跑的活直接蒸发。
 *
 * 现状(2026-09-28 用户明确要求「重启不应该被拒绝」):检测照旧跑,但**只告知、不拦截** ——
 * 工具照常写标记、照常起驱动脚本,返回文案里点名会被打断的会话 id、原因,以及交接记录存没存下。
 * 仍然拒绝的只剩两条:拿不到归属会话、发起者是子代理会话(只有主会话能在新进程里恢复)。
 *
 * 口径(三条,2026-09-27 扩):
 *   ① 自己在本轮运行(status === 'running');
 *   ② 名下还有正在跑的子代理 —— 顶层会话派完后**台**子代理就结束本轮 ⇒ 父会话是 idle、子代理还在跑
 *      (它只在结束时才 followup 唤醒父会话);roots() 按 owner===undefined 过滤,子代理不在其中,
 *      所以要靠 list() + session.header.parentSession 上溯把它归到血缘上的根;
 *   ③ 名下还有未结算的后台作业(running/stopping)—— 作业记录是纯内存态,硬杀即永久丢失;
 *   发起者自己名下的 ②③ 不算"其它会话"(同进程共命),但单独计进 own 并写进文案;
 *   拿不到 agents/jobs 服务时 fail-soft(照常重启,文案里说明"说不清会打断谁")。
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
  DEFAULT_INJECT_TEXT,
  HANDOFF_SERVICE,
  LAUNCH_TIMEOUT_MS,
  MAX_LISTED_SESSIONS,
  TOOL_NAME,
  WAIT_SECONDS,
  apply,
  describeHandoffProbeMismatch,
  detectRunningSessions,
  formatInterruptedNotice,
  saveHandoffBeforeRestart,
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

/** 假顶层会话条目:插件只读 session.id / session.header / status 三个字段。 */
const topAgent = (id, status, header = {}) => ({ session: { id, header }, status })
/** 假子代理条目:owner 非空 ⇒ 不出现在 roots() 里;血缘靠 header.parentSession 上溯。 */
const subAgent = (id, status, parentSession) => ({
  session: { id, header: { parentSession, origin: 'subagent' } },
  status,
  owner: {},
})

/**
 * jobs 服务桩:按 owner 会话给出作业视图(真实 list(caller) 只返回该 owner 的作业 + 无主作业)。
 * @param table { [ownerId]: Array<{ status, owner? }> } —— owner 缺省取查询者;显式写
 *   `owner: undefined` 表示"无主作业"(真实 list() 会把它一并返回,插件必须把它筛掉)。
 */
function makeJobs(table = {}) {
  const calls = []
  return {
    calls,
    service: {
      list: (caller) => {
        calls.push(caller)
        return (table[caller] ?? []).map((job) => ({ owner: caller, ...job }))
      },
    },
  }
}

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
  const effects = []
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
    // cordis 的清理机制:回调的返回值(清理函数)登记进当前 fiber,卸载时由 cordis 执行
    effect: (callback) => {
      const disposer = callback()
      if (typeof disposer === 'function') effects.push(disposer)
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
    /** 模拟 cordis 的 fiber 卸载:跑 ctx.effect 登记的清理函数(真宿主由 cordis 自己跑)。 */
    dispose: () => { for (const cleanup of effects.splice(0)) cleanup() },
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
 * slHandoff 服务桩(重启前的交接保存):记录调用次数与参数,按 options 决定返回/抛错。
 * 真实服务由 dsh-host-sl 提供,接口是 `saveAll(options) → {ok, saved, failed, items, message, …}`,
 * `options = {all:true, noteSessionId, session}`(v0.4.0 起覆盖**所有活跃会话**)。
 * ⚠ v0.5.0 起本插件**不再传 `note`**(注入文案固定,调用方改不了) —— 桩只收一个参数,
 * 多收一个就说明源码又把它传回来了。
 * @param options.result 自定义返回值(默认一条成功结果)。
 * @param options.throw true ⇒ saveAll() 抛错。
 * @param options.async true ⇒ saveAll() 返回 Promise(验证 await 语义:异步实现也要等它落盘)。
 */
function makeHandoff(options = {}) {
  const calls = []
  const result = options.result ?? {
    ok: true,
    saved: 1,
    failed: 0,
    items: [{ ok: true, sessionId: 'session-self', file: 'C:\\stub\\sl-handoff\\handoff-1.md', stats: { total: 3 } }],
    message: '交接记录已保存:C:\\stub\\sl-handoff\\handoff-1.md',
    pendingFile: 'C:\\stub\\sl-handoff\\pending.json',
    createdAt: Date.now(),
  }
  const service = {
    saveAll: (request) => {
      calls.push({ request })
      if (options.throw === true) throw new Error('桩:交接保存炸了')
      return options.async === true ? Promise.resolve(result) : result
    },
  }
  return { calls, service }
}

/**
 * 造一次工具调用现场:注册工具 → 取出定义 → 跑 execute。
 * @param services 服务表。
 * @param options.args execute 的第一个参数(工具参数,默认 {})。
 * @param options.execArgs execute 的第二个参数(默认是一个普通主会话调用)。
 * @param options.stub WMI 启动桩,默认新建一个。
 * @param options.pendingDir 本次调用专属的标记目录,默认新建一个(每条用例互不干扰)。
 * @param options.injectStub false ⇒ 不注入桩,用来单独验证 DSH_RESTART_NO_LAUNCH 熔断。
 */
async function callTool(services, options = {}) {
  const {
    args = {},
    execArgs = {},
    stub = makeLauncherStub(),
    pendingDir = mkdtempSync(join(scratch, 'pending-')),
    injectStub = true,
  } = options
  const registered = []
  const { ctx, dispose } = makeCtx({ ...services, tools: makeTools(registered) })
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
  const result = await registered[0].execute(args, {
    agent: { session: { id: 'session-self', header: { origin: 'main' } } },
    ...execArgs,
  })
  // 撤掉 apply 排的启动注入定时器:测试不留悬挂副作用(走 ctx.effect 登记的清理,与真宿主卸载同一条路)
  dispose()
  return { result, stub, pendingDir, pendingFile: join(pendingDir, 'pending.json'), definition: registered[0] }
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
  assert.equal(result.waitSeconds, WAIT_SECONDS, '等待是固定值,不受调用方影响')

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
  assert.ok(wmiScript.includes(`-WaitSeconds ${WAIT_SECONDS}`), `等待必须固定为 ${WAIT_SECONDS}s(参数已删,不可被调用方放大)`)
  // 实例身份:驱动脚本据此只杀"本实例"的 dsh。测试进程 argv 里没有 profile/端口 ⇒ 只带 pid,
  // 正好同时验证"身份不全时不硬编"。
  assert.ok(wmiScript.includes(`-DshPid ${process.pid}`), '启动命令行必须带发起者宿主 pid')
  assert.ok(!wmiScript.includes('-ProfileName'), 'argv 里认不出 profile 时不该硬编一个')
  assert.ok(wmiScript.includes(`-PendingFile "${pendingFile}"`), '标记路径要传给脚本(旧版插件过渡时的身份兜底)')

  const pending = JSON.parse(readFileSync(pendingFile, 'utf8'))
  assert.equal(pending.version, 1)
  assert.equal(pending.sessionId, sessionId)
  assert.equal(pending.pidBefore, process.pid)
  assert.equal(pending.waitSeconds, WAIT_SECONDS)
  assert.equal(pending.text, DEFAULT_INJECT_TEXT, '标记里必须带固定注入正文(v0.5.0)')
  assert.ok(Math.abs(Date.now() - pending.createdAt) < 60_000, 'createdAt 应当就是刚刚')
  return pending
}

/**
 * 拒绝路径的硬事实:一个字节都不写,也绝不触碰启动桩。
 * 2026-09-28 起只剩两条走到这里:拿不到归属会话 / 子代理发起。
 */
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

/** 日志里某个片段出现了几次(共用日志文件时用"前后差值"断言"只写了一次")。 */
function countIn(text, needle) {
  return text.split(needle).length - 1
}

// ── 纯函数:检测口径 ────────────────────────────────────────────────────────

test('detectRunningSessions:其它顶层 running 被点名,idle 的不算', () => {
  const roots = [
    topAgent('session-self', 'running'),
    topAgent('session-other-1', 'running'),
    topAgent('session-idle', 'idle'),
  ]
  const agents = { roots: () => roots, list: () => roots }
  const { ctx } = makeCtx({ agents })
  assert.deepEqual(detectRunningSessions(ctx, 'session-self'), {
    available: true,
    total: 3,
    running: 2,
    own: { subagents: 0, jobs: 0 },
    others: [{ id: 'session-other-1', reasons: ['session'] }],
  })
})

test('detectRunningSessions:父会话 idle + 名下子代理在跑 ⇒ 点名该父会话(这就是旧版的洞)', () => {
  // 顶层会话派完后**台**子代理就结束本轮 ⇒ 父 idle、子 running;roots() 里看不到子代理
  const agents = {
    roots: () => [topAgent('session-self', 'running'), topAgent('session-other', 'idle')],
    list: () => [
      topAgent('session-self', 'running'),
      topAgent('session-other', 'idle'),
      subAgent('session-sub-1', 'running', 'session-other'),
    ],
  }
  const { ctx } = makeCtx({ agents })
  const detected = detectRunningSessions(ctx, 'session-self')
  assert.equal(detected.available, true)
  assert.deepEqual(detected.others, [{ id: 'session-other', reasons: ['subagent'] }])
  assert.equal(detected.running, 1, 'running 仍只数顶层会话自己')
})

test('detectRunningSessions:自己的子代理不算 others,但计进 own(文案要一并告知)', () => {
  const agents = {
    roots: () => [topAgent('session-self', 'running')],
    list: () => [
      topAgent('session-self', 'running'),
      subAgent('session-sub-1', 'running', 'session-self'),
      subAgent('session-sub-2', 'idle', 'session-self'),
    ],
  }
  const { ctx } = makeCtx({ agents })
  const detected = detectRunningSessions(ctx, 'session-self')
  assert.deepEqual(detected.others, [], '自己的子代理不是"其它会话"')
  assert.deepEqual(detected.own, { subagents: 1, jobs: 0 }, 'idle 的子代理不算"在跑"')
})

test('detectRunningSessions:嵌套子代理归到血缘最上层那个根', () => {
  const agents = {
    roots: () => [topAgent('session-self', 'running'), topAgent('session-other', 'idle')],
    list: () => [
      topAgent('session-self', 'running'),
      topAgent('session-other', 'idle'),
      subAgent('session-sub-1', 'idle', 'session-other'),
      subAgent('session-sub-2', 'running', 'session-sub-1'), // 孙子在跑
      subAgent('session-self-sub', 'running', 'session-self'),
    ],
  }
  const { ctx } = makeCtx({ agents })
  assert.deepEqual(detectRunningSessions(ctx, 'session-self').others, [{ id: 'session-other', reasons: ['subagent'] }])
})

test('detectRunningSessions:血缘成环不挂死(损坏的 header 链只访问一次)', () => {
  const agents = {
    roots: () => [topAgent('session-self', 'running')],
    list: () => [
      topAgent('session-self', 'running'),
      subAgent('loop-a', 'running', 'loop-b'),
      subAgent('loop-b', 'running', 'loop-a'),
    ],
  }
  const { ctx } = makeCtx({ agents })
  let detected
  assert.doesNotThrow(() => { detected = detectRunningSessions(ctx, 'session-self') })
  // 成环时各自以"自己"为顶收尾(谁也不认谁是根):宁可多点名,也不能死循环或静默放行
  assert.deepEqual(detected.others, [
    { id: 'loop-a', reasons: ['subagent'] },
    { id: 'loop-b', reasons: ['subagent'] },
  ])
})

test('detectRunningSessions:名下未结算作业(running/stopping)⇒ 点名该会话', () => {
  const { service } = makeJobs({
    'session-other': [{ status: 'running' }, { status: 'completed' }],
    'session-third': [{ status: 'stopping' }],
    'session-idle': [{ status: 'failed' }],
  })
  const agents = {
    roots: () => [
      topAgent('session-self', 'running'),
      topAgent('session-other', 'idle'),
      topAgent('session-third', 'idle'),
      topAgent('session-idle', 'idle'),
    ],
  }
  const { ctx } = makeCtx({ agents, jobs: service })
  assert.deepEqual(detectRunningSessions(ctx, 'session-self').others, [
    { id: 'session-other', reasons: ['job'] },
    { id: 'session-third', reasons: ['job'] },
  ])
})

test('detectRunningSessions:无主作业不记在任何会话头上(list() 会把它们一并返回)', () => {
  const { service } = makeJobs({
    'session-other': [{ status: 'running', owner: undefined }],
    'session-self': [{ status: 'running' }],
  })
  const agents = { roots: () => [topAgent('session-self', 'running'), topAgent('session-other', 'idle')] }
  const { ctx } = makeCtx({ agents, jobs: service })
  const detected = detectRunningSessions(ctx, 'session-self')
  assert.deepEqual(detected.others, [], '无主作业与自己名下的作业都不算"其它会话"')
  assert.deepEqual(detected.own, { subagents: 0, jobs: 1 }, '自己名下的作业要计进 own(文案里告知)')
})

test('detectRunningSessions:同一会话命中多条时 reasons 齐全且顺序固定', () => {
  const { service } = makeJobs({ 'session-other': [{ status: 'running' }] })
  const agents = {
    roots: () => [topAgent('session-self', 'running'), topAgent('session-other', 'running')],
    list: () => [
      topAgent('session-self', 'running'),
      topAgent('session-other', 'running'),
      subAgent('session-sub-1', 'running', 'session-other'),
    ],
  }
  const { ctx } = makeCtx({ agents, jobs: service })
  assert.deepEqual(detectRunningSessions(ctx, 'session-self').others, [
    { id: 'session-other', reasons: ['session', 'subagent', 'job'] },
  ])
})

test('detectRunningSessions:jobs 服务缺失/形态不符/抛错 ⇒ 作业这条静默退化,不影响会话判定', () => {
  const agents = { roots: () => [topAgent('session-self', 'running'), topAgent('session-other', 'running')] }
  const broken = [
    {},
    { jobs: null },
    { jobs: {} },
    { jobs: { list: 'not-a-function' } },
    { jobs: { list: () => { throw new Error('registry disposed') } } },
    { jobs: { list: () => 'not-an-array' } },
  ]
  for (const extra of broken) {
    const { ctx } = makeCtx({ agents, ...extra })
    let detected
    assert.doesNotThrow(() => { detected = detectRunningSessions(ctx, 'session-self') }, `${JSON.stringify(Object.keys(extra))} 不该抛`)
    assert.deepEqual(detected.others, [{ id: 'session-other', reasons: ['session'] }])
  }
})

test('detectRunningSessions:agents 接口形态不符一律 fail-soft(可读原因,不抛)', () => {
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

test('detectRunningSessions:roots() 缺失时退回 list(),子代理会按顶层算(旧行为,可接受)', () => {
  const agents = {
    list: () => [topAgent('session-self', 'running'), topAgent('session-other', 'running')],
  }
  const { ctx } = makeCtx({ agents })
  const detected = detectRunningSessions(ctx, 'session-self')
  assert.equal(detected.available, true)
  assert.deepEqual(detected.others, [{ id: 'session-other', reasons: ['session'] }])
})

test('formatInterruptedNotice:点名"会被打断"+原因,最多列 3 个,超出用"等 N 个"', () => {
  const saved = { ok: true, files: ['C:\\stub\\sl-handoff\\a.md', 'C:\\stub\\sl-handoff\\b.md'], text: 'C:\\stub\\sl-handoff\\a.md' }
  const two = formatInterruptedNotice({
    others: [
      { id: 'session-a', reasons: ['subagent'] },
      { id: 'session-b', reasons: ['session', 'job'] },
    ],
    own: { subagents: 0, jobs: 0 },
  }, saved)
  assert.match(two, /本次重启会打断 2 个其它会话/)
  assert.ok(two.includes('`session-a`(子代理在跑)'), two)
  assert.ok(two.includes('`session-b`(会话在跑、后台作业在跑)'), two)
  assert.ok(!two.includes('等 2 个'))
  assert.ok(two.includes('会被一起硬杀'), '要说清后果:它们会被一起硬杀')
  assert.ok(two.includes('正在跑的那一步工具调用直接丢'), '代价不许说轻:交接救得回上下文、救不回这一步')
  assert.ok(two.includes('这些会话的交接记录已随本次重启存下(本次共 2 份,含本会话)'), two)
  assert.ok(two.includes('新进程启动时会由 dsh-host-sl 逐条注入、各自重起一轮接着跑'), two)
  assert.ok(!two.includes('本会话自己名下'), '没有自己名下的活就不该写那半句')

  const five = formatInterruptedNotice({
    others: ['s-1', 's-2', 's-3', 's-4', 's-5'].map((id) => ({ id, reasons: ['session'] })),
    own: { subagents: 0, jobs: 0 },
  }, saved)
  assert.equal(MAX_LISTED_SESSIONS, 3)
  assert.match(five, /本次重启会打断 5 个其它会话/)
  assert.ok(five.includes('`s-3`'))
  assert.ok(!five.includes('`s-4`'), '第 4 个 id 不该被列出')
  assert.ok(five.includes('等 5 个'))
})

test('formatInterruptedNotice:本会话自己的子代理/作业、没在飞的活、交接没存下,三种情形各说各话', () => {
  const saved = { ok: true, files: ['C:\\stub\\sl-handoff\\a.md'], text: '' }
  const failed = { ok: false, files: [], text: 'slHandoff 服务不可用(dsh-host-sl 未装载?)' }
  const noOthers = { others: [], own: { subagents: 0, jobs: 0 } }

  // ① 只有本会话自己名下的活:说"随本会话一起被硬杀",不冒称"其它会话"
  const own = formatInterruptedNotice({ others: [], own: { subagents: 2, jobs: 1 } }, saved)
  assert.ok(own.includes('本会话自己名下还有 2 个子代理在跑、1 个后台作业未结算'), own)
  assert.ok(own.includes('它们随本会话一起被硬杀'), own)
  assert.ok(!own.includes('其它会话'), own)
  // ② 两种情形同时存在:合成一段,交接结论只说一次(不重复那半句)
  const both = formatInterruptedNotice({
    others: [{ id: 'session-a', reasons: ['session'] }],
    own: { subagents: 1, jobs: 0 },
  }, saved)
  assert.ok(both.includes('本次重启会打断 1 个其它会话(`session-a`(会话在跑))、本会话自己名下还有 1 个子代理在跑'), both)
  assert.equal(both.split('这些会话的交接记录').length - 1, 1, '交接结论只该出现一次')
  // ③ 什么都没在飞:整段省略(调用方不该拿到半句话)
  assert.equal(formatInterruptedNotice(noOthers, saved), '')
  // ④ 交接没存下:不许说"已存",也不许承诺会注入回去
  const notSaved = formatInterruptedNotice({ others: [{ id: 'session-a', reasons: ['session'] }], own: { subagents: 0, jobs: 0 } }, failed)
  assert.ok(notSaved.includes('这些会话的交接记录这次没存下来(slHandoff 服务不可用(dsh-host-sl 未装载?))'), notSaved)
  assert.ok(notSaved.includes('新进程里没人会把它们唤回'), notSaved)
  assert.ok(!notSaved.includes('已随本次重启存下'), '没存下就不许说存下了')
  assert.ok(!notSaved.includes('逐条注入'), '没存下就不许承诺"会被注入回去"')
  // ⑤ 服务没回传记录路径:如实说,不编一个
  const noPath = formatInterruptedNotice({ others: [{ id: 'session-a', reasons: ['session'] }], own: { subagents: 0, jobs: 0 } }, { ok: true, files: [], text: '' })
  assert.ok(noPath.includes('服务未回传记录路径'), noPath)
})

// ── 工具层:检测只告知、不拦截(2026-09-28 起)────────────────────────────────

test('其它顶层会话 running ⇒ 照常重启,文案里点名会被打断的会话(不再拒绝)', async () => {
  const handoff = makeHandoff()
  const scene = await callTool({
    agents: {
      roots: () => [topAgent('session-self', 'running'), topAgent('session-other-a', 'running')],
    },
    [HANDOFF_SERVICE]: handoff.service,
  })
  const { result } = scene
  // ① 驱动脚本启动路径照常走完:标记写下了、启动桩恰好被调用一次
  assertAllowPath(scene)
  assert.equal(handoff.calls.length, 1, '其它会话在飞时交接保存照样要做 —— 那是重启后唤回它们的唯一依据')
  // ② 文案:同时出现"会被打断"与具体会话 id,并说清交接存到哪了
  assert.ok(result.message.includes('本次重启会打断 1 个其它会话'), result.message)
  assert.ok(result.message.includes('`session-other-a`(会话在跑)'), '告知文案要给出会话 id 与原因')
  assert.ok(result.message.includes('会被一起硬杀'), result.message)
  assert.ok(result.message.includes('这些会话的交接记录已随本次重启存下'), result.message)
  assert.ok(!result.message.includes('未执行'), '2026-09-28 起不再有"未执行"这条路径')
  assert.equal('launcherPid' in result, true, '照常返回启动结果')
  assert.match(lastGateLog(), /会话检测: 顶层会话 2 个\(本轮运行 2 个\), 其它有活在跑 1 个: session-other-a\(session\)/)
  assert.match(readFileSync(testLog, 'utf8'), /其它会话有活在跑\(1 个\),不再拒绝:照常重启/)
})

test('其它顶层会话 idle 但名下子代理在跑 ⇒ 照常重启,文案点名该会话(旧版会静默掐掉它)', async () => {
  const scene = await callTool({
    agents: {
      roots: () => [topAgent('session-self', 'running'), topAgent('session-other-b', 'idle')],
      list: () => [
        topAgent('session-self', 'running'),
        topAgent('session-other-b', 'idle'),
        subAgent('session-sub-b', 'running', 'session-other-b'),
      ],
    },
  })
  assertAllowPath(scene)
  assert.ok(scene.result.message.includes('`session-other-b`(子代理在跑)'), scene.result.message)
  assert.ok(scene.result.message.includes('本次重启会打断 1 个其它会话'), scene.result.message)
})

test('其它顶层会话 idle 但名下有未结算作业 ⇒ 照常重启,文案点名该会话(作业结果硬杀即丢)', async () => {
  const { service } = makeJobs({ 'session-other-c': [{ status: 'running' }] })
  const scene = await callTool({
    agents: { roots: () => [topAgent('session-self', 'running'), topAgent('session-other-c', 'idle')] },
    jobs: service,
  })
  assertAllowPath(scene)
  assert.ok(scene.result.message.includes('`session-other-c`(后台作业在跑)'), scene.result.message)
  assert.ok(scene.result.message.includes('本次重启会打断 1 个其它会话'), scene.result.message)
})

test('其它顶层会话只 idle(标签页开着但没跑、无子代理无作业)⇒ 放行:写标记 + 经桩发起一次启动', async () => {
  const { service } = makeJobs({ 'session-idle': [{ status: 'completed' }] })
  const scene = await callTool({
    agents: {
      roots: () => [topAgent('session-self', 'running'), topAgent('session-idle', 'idle')],
      list: () => [
        topAgent('session-self', 'running'),
        topAgent('session-idle', 'idle'),
        subAgent('session-sub-idle', 'idle', 'session-idle'),
      ],
    },
    jobs: service,
  })
  assertAllowPath(scene)
  assert.ok(!scene.result.message.includes('其它会话'), 'idle 的标签页不该被算作"会被打断的活"')
  assert.match(lastGateLog(), /会话检测: 顶层会话 2 个\(本轮运行 1 个\), 其它有活在跑 0 个$/)
})

test('只有自己(唯一的 running 顶层会话)⇒ 放行', async () => {
  const scene = await callTool({ agents: { roots: () => [topAgent('session-self', 'running')] } })
  assertAllowPath(scene)
  assert.match(lastGateLog(), /会话检测: 顶层会话 1 个\(本轮运行 1 个\), 其它有活在跑 0 个/)
})

test('自己的子代理 + 自己的后台作业在跑 ⇒ 放行,且文案把"本会话名下在跑的活"一并说清', async () => {
  const { service } = makeJobs({ 'session-self': [{ status: 'running' }] })
  const agents = {
    // 注册表按 owner===undefined 给 roots():子代理只出现在 list() 里
    roots: () => [topAgent('session-self', 'running')],
    list: () => [
      topAgent('session-self', 'running'),
      subAgent('session-sub-1', 'running', 'session-self'),
      subAgent('session-sub-2', 'running', 'session-self'),
    ],
  }
  const scene = await callTool({ agents, jobs: service })
  assertAllowPath(scene)
  assert.ok(!scene.result.message.includes('其它会话'), '自己的子代理不是"其它会话"')
  assert.ok(
    scene.result.message.includes('本会话自己名下还有 2 个子代理在跑、1 个后台作业未结算'),
    scene.result.message,
  )
  assert.ok(scene.result.message.includes('它们随本会话一起被硬杀'), scene.result.message)
  assert.match(lastGateLog(), /会话检测: 顶层会话 1 个\(本轮运行 1 个\), 其它有活在跑 0 个/)
})

test('工具**没有任何参数**(v0.5.0:note 与 wait_seconds 都已删,注入内容不可被调用方影响)', async () => {
  const scene = await callTool({ agents: { roots: () => [topAgent('session-self', 'running')] } })
  assert.deepEqual(Object.keys(scene.definition.parameters.properties), [], '参数表必须为空')
  assert.ok(!JSON.stringify(scene.definition.parameters).includes('wait'), '参数表里不该再有等待相关字段')
  assert.ok(!JSON.stringify(scene.definition.parameters).includes('note'), '参数表里不该再有 note(v0.5.0 删除)')
  // 描述里也不许再提 note —— 模型看得见的就是这段文字,提了就会去传一个不存在的参数
  assert.ok(!scene.definition.description.includes('note'), '工具描述里不该再提 note')
})

test('agents 服务缺失 ⇒ 不抛错、记 warn、照常重启(走到启动层),文案不假装"没有别的会话"', async () => {
  const scene = await callTool({})
  assertAllowPath(scene)
  assert.ok(!/其它会话/.test(scene.result.message), '检测不到时不该点名任何会话')
  assert.ok(scene.result.message.includes('本次没能读到宿主会话表(agents 服务不可用)'), scene.result.message)
  assert.ok(scene.result.message.includes('无法提前说明会打断哪些会话'), scene.result.message)
  assert.match(readFileSync(testLog, 'utf8'), /无法检测其它会话\(agents 服务不可用\),按无其它会话处理,照常重启/)
})

test('agents 服务存在但没有 roots()/list() ⇒ 同样 fail-soft 放行并记原因', async () => {
  const scene = await callTool({ agents: { someOtherApi: () => [] } })
  assertAllowPath(scene)
  assert.match(readFileSync(testLog, 'utf8'), /无法检测其它会话\(agents 服务没有 roots\(\)\/list\(\) 函数\)/)
})

test('jobs 服务缺失时作业这条退化,其它会话 idle 仍放行(fail-soft 不等于拦住)', async () => {
  const scene = await callTool({
    agents: { roots: () => [topAgent('session-self', 'running'), topAgent('session-idle', 'idle')] },
  })
  assertAllowPath(scene)
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

// ── 重启前的交接保存(slHandoff 服务,2026-09-28 新增)─────────────────────────

test('重启前会调用 slHandoff.saveAll 保存**所有活跃会话**:结果(含记录文件路径)写进返回文案', async () => {
  const handoff = makeHandoff()
  const scene = await callTool(
    { agents: { roots: () => [topAgent('session-self', 'running')] }, [HANDOFF_SERVICE]: handoff.service },
    { args: { note: '重启后确认插件已加载' } }, // v0.5.0:参数已删,这里故意多传一个,证明它进不了服务与注入内容
  )
  assertAllowPath(scene)
  assert.equal(handoff.calls.length, 1, '放行路径必须恰好调用一次交接保存')
  const [call] = handoff.calls
  assert.equal(call.request.all, true, '必须是"所有活跃会话"模式(不是只存当前这一个)')
  assert.equal(call.request.noteSessionId, 'session-self', 'noteSessionId 仍要带上(v0.7.0 的 dsh-host-sl 不读它,保留形参只为兼容)')
  assert.equal(call.request.session.id, 'session-self', '会话对象也要带上(服务枚举不到时的退路)')
  assert.equal(call.request.session.header.origin, 'main')
  assert.ok(!Object.hasOwn(call.request, 'note'), 'v0.5.0 起不许再往 saveAll 传 note')
  assert.ok(!scene.result.message.includes('重启后确认插件已加载'), '调用方传的 note 不该出现在返回文案里')
  assert.equal(JSON.parse(readFileSync(scene.pendingFile, 'utf8')).text, DEFAULT_INJECT_TEXT,
    '标记里必须是固定文案,调用方传的 note 一个字都不许拼进去')
  assert.equal(scene.result.handoff.ok, true)
  assert.deepEqual(scene.result.handoff.files, ['C:\\stub\\sl-handoff\\handoff-1.md'])
  assert.ok(scene.result.message.includes('重启前已保存会话交接记录'), scene.result.message)
  assert.ok(scene.result.message.includes('C:\\stub\\sl-handoff\\handoff-1.md'), '文案里要能看见记录文件路径')
  assert.ok(scene.result.message.includes('dsh-host-sl'), '文案要说清是谁会在新进程里注入它')
  assert.match(readFileSync(testLog, 'utf8'), /重启前已保存会话交接记录\(1 个会话\):/)
})

test('多个会话都被存下时,文案与日志里列出全部记录文件路径', async () => {
  const handoff = makeHandoff({
    result: {
      ok: true,
      saved: 3,
      failed: 0,
      items: [
        { ok: true, sessionId: 'session-self', file: 'C:\\stub\\sl-handoff\\handoff-self.md' },
        { ok: true, sessionId: 'session-other', file: 'C:\\stub\\sl-handoff\\handoff-other.md' },
        { ok: true, sessionId: 'session-sub', file: 'C:\\stub\\sl-handoff\\handoff-sub.md' },
      ],
      message: '交接记录已保存（所有活跃会话，共 3 个：顶层 2 / 子代理 1）',
    },
  })
  const scene = await callTool(
    { agents: { roots: () => [topAgent('session-self', 'running')] }, [HANDOFF_SERVICE]: handoff.service },
  )
  assertAllowPath(scene)
  assert.equal(scene.result.handoff.ok, true)
  assert.deepEqual(scene.result.handoff.files, [
    'C:\\stub\\sl-handoff\\handoff-self.md',
    'C:\\stub\\sl-handoff\\handoff-other.md',
    'C:\\stub\\sl-handoff\\handoff-sub.md',
  ], '三个会话的记录路径都要带出来(用户据此核对"都存上了")')
  assert.ok(scene.result.message.includes('handoff-sub.md'))
  assert.match(readFileSync(testLog, 'utf8'), /重启前已保存会话交接记录\(3 个会话\):/)
})

test('服务是异步实现时也要 await 到落盘(保存没回来就不许往下走)', async () => {
  const handoff = makeHandoff({ async: true })
  const scene = await callTool(
    { agents: { roots: () => [topAgent('session-self', 'running')] }, [HANDOFF_SERVICE]: handoff.service },
  )
  assertAllowPath(scene)
  assert.equal(handoff.calls.length, 1)
  assert.equal(scene.result.handoff.ok, true)
  assert.ok(scene.result.message.includes('C:\\stub\\sl-handoff\\handoff-1.md'))
})

test('服务返回 ok:false ⇒ 重启照常(桩调用一次、标记照写),文案带上服务给的原因', async () => {
  const handoff = makeHandoff({
    result: { ok: false, saved: 0, failed: 1, items: [{ ok: false, sessionId: 'session-self', message: '读会话历史失败(桩)' }], message: '读会话历史失败(桩)' },
  })
  const scene = await callTool(
    { agents: { roots: () => [topAgent('session-self', 'running')] }, [HANDOFF_SERVICE]: handoff.service },
  )
  assertAllowPath(scene)
  assert.equal(scene.result.handoff.ok, false)
  assert.ok(scene.result.message.includes('重启前的会话交接未保存'), scene.result.message)
  assert.ok(scene.result.message.includes('读会话历史失败(桩)'), '服务给的原因要如实带出来')
  assert.ok(scene.result.message.includes('不影响本次重启'))
  assert.match(readFileSync(testLog, 'utf8'), /重启前的交接保存未成功:读会话历史失败\(桩\);照常重启/)
})

test('服务抛错 ⇒ 重启照常,只记一行日志,文案说明未保存', async () => {
  const handoff = makeHandoff({ throw: true })
  const scene = await callTool(
    { agents: { roots: () => [topAgent('session-self', 'running')] }, [HANDOFF_SERVICE]: handoff.service },
  )
  assertAllowPath(scene)
  assert.equal(handoff.calls.length, 1, '抛错也要先被调用一次')
  assert.equal(scene.result.handoff.ok, false)
  assert.ok(scene.result.message.includes('重启前的会话交接未保存'), scene.result.message)
  assert.ok(scene.result.message.includes('桩:交接保存炸了'))
  assert.match(readFileSync(testLog, 'utf8'), /调用 slHandoff\.saveAll\(\) 抛错,跳过重启前的交接保存,照常重启:桩:交接保存炸了/)
})

test('服务不存在(dsh-host-sl 未装载)⇒ 重启照常,文案说明服务不可用', async () => {
  const scene = await callTool({ agents: { roots: () => [topAgent('session-self', 'running')] } })
  assertAllowPath(scene)
  assert.equal(scene.result.handoff.ok, false)
  assert.deepEqual(scene.result.handoff.files, [])
  assert.ok(scene.result.message.includes('重启前的会话交接未保存'), scene.result.message)
  assert.ok(scene.result.message.includes('slHandoff 服务不可用'), scene.result.message)
  assert.match(readFileSync(testLog, 'utf8'), /未找到 slHandoff 服务\(dsh-host-sl 未装载\?\),跳过重启前的交接保存,照常重启/)
})

test('服务形态不符(saveAll 不是函数 / 读 saveAll 就抛)⇒ 重启照常', async () => {
  // 旧版 dsh-host-sl(v0.3.0 只有 save)也走这条:本插件只认 saveAll,不退回"只存当前会话"
  const wrongShape = await callTool(
    { agents: { roots: () => [topAgent('session-self', 'running')] }, [HANDOFF_SERVICE]: { save: () => ({ ok: true }) } },
  )
  assertAllowPath(wrongShape)
  assert.equal(wrongShape.result.handoff.ok, false)
  assert.ok(wrongShape.result.message.includes('不是函数'), wrongShape.result.message)
  assert.ok(wrongShape.result.message.includes('v0.4.0+'), '文案要说清"需要哪个版本的服务"')
  assert.match(readFileSync(testLog, 'utf8'), /slHandoff 服务没有 saveAll\(\)\(接口形态不符,dsh-host-sl 需要 v0\.4\.0\+\),跳过重启前的交接保存,照常重启/)

  // 取 saveAll 属性本身就抛(代理/getter):同样只该记一行日志
  const throwingGetter = {}
  Object.defineProperty(throwingGetter, 'saveAll', { get() { throw new Error('桩:saveAll 读取炸了') } })
  const getterScene = await callTool(
    { agents: { roots: () => [topAgent('session-self', 'running')] }, [HANDOFF_SERVICE]: throwingGetter },
  )
  assertAllowPath(getterScene)
  assert.equal(getterScene.result.handoff.ok, false)
  assert.ok(getterScene.result.message.includes('saveAll 读取炸了'), getterScene.result.message)
})

test('重启失败(通道全挂)时交接结果也如实写进文案:交接可能已经存下来了', async () => {
  const handoff = makeHandoff()
  const stub = makeLauncherStub({ fail: true })
  const scene = await callTool(
    { agents: { roots: () => [topAgent('session-self', 'running')] }, [HANDOFF_SERVICE]: handoff.service },
    { stub },
  )
  assert.equal(scene.result.ok, false)
  assert.equal(handoff.calls.length, 1, '交接排在启动之前,所以这时它已经存过了')
  assert.equal(scene.result.handoff.ok, true)
  assert.ok(scene.result.message.includes('重启前已保存会话交接记录'), scene.result.message)
  assert.ok(scene.result.message.includes('C:\\stub\\sl-handoff\\handoff-1.md'), '失败路径也要给出记录文件路径')
})

test('其它会话在飞 + 交接服务缺席 ⇒ 重启照常,文案如实说"没存下来",不谎称已保存', async () => {
  const scene = await callTool({
    agents: { roots: () => [topAgent('session-self', 'running'), topAgent('session-other', 'running')] },
  })
  assertAllowPath(scene)
  const { message } = scene.result
  assert.ok(message.includes('本次重启会打断 1 个其它会话(`session-other`(会话在跑))'), message)
  assert.ok(message.includes('这些会话的交接记录这次没存下来(slHandoff 服务不可用(dsh-host-sl 未装载?))'), message)
  assert.ok(message.includes('新进程里没人会把它们唤回'), message)
  assert.ok(!message.includes('重启前已保存会话交接记录'), '没保存成功就不许出现"已保存"')
  assert.ok(!message.includes('逐条注入'), '没保存成功就不许承诺"会被注入回去"')
})

test('saveHandoffBeforeRestart 单测:ctx.get 抛错 / 服务缺席 / 服务返回 undefined 都 fail-soft', async () => {
  const lines = []
  const log = (message) => lines.push(message)

  const throwing = { get: () => { throw new Error('registry disposed') } }
  const first = await saveHandoffBeforeRestart(throwing, { id: 's' }, log)
  assert.equal(first.ok, false)
  assert.match(first.text, /读取 slHandoff 服务抛错/)
  assert.equal(lines.length, 1, '只记一行日志')

  lines.length = 0
  const second = await saveHandoffBeforeRestart({ get: () => undefined }, { id: 's' }, log)
  assert.equal(second.ok, false)
  assert.match(second.text, /服务不可用/)
  assert.equal(lines.length, 1)

  lines.length = 0
  const third = await saveHandoffBeforeRestart({ get: () => ({ saveAll: () => undefined }) }, { id: 's' }, log)
  assert.equal(third.ok, false, '服务返回 undefined(形态漂移)也算失败,不许当成成功')
  assert.match(third.text, /ok:false\(无说明\)/)
  assert.equal(lines.length, 1)

  lines.length = 0
  const noGet = await saveHandoffBeforeRestart({}, { id: 's' }, log)
  assert.equal(noGet.ok, false)
  assert.equal(lines.length, 1)
})

// ── 原有边界(2026-09-28 后只剩这两条会拒绝)─────────────────────────────────

test('拿不到归属会话 / 子代理发起 ⇒ 仍在检测与交接保存之前就拒绝(原有边界不变)', async () => {
  const orphanHandoff = makeHandoff()
  const orphan = await callTool(
    {
      agents: { roots: () => [topAgent('session-self', 'running'), topAgent('session-other', 'running')] },
      [HANDOFF_SERVICE]: orphanHandoff.service,
    },
    { execArgs: { agent: {} } },
  )
  assert.equal(orphan.result.ok, false)
  assert.match(orphan.result.message, /没有归属会话/)
  assert.equal(orphanHandoff.calls.length, 0, '拒绝路径不该存交接(语义是"什么都没发生")')
  assertNothingHappened(orphan)

  const subHandoff = makeHandoff()
  const sub = await callTool(
    {
      agents: { roots: () => [topAgent('session-self', 'running'), topAgent('session-other', 'running')] },
      [HANDOFF_SERVICE]: subHandoff.service,
    },
    { execArgs: { agent: { session: { id: 'session-self', header: { origin: 'subagent' } } } } },
  )
  assert.equal(sub.result.ok, false)
  assert.match(sub.result.message, /子代理会话不支持重启续跑/)
  assert.equal(subHandoff.calls.length, 0, '拒绝路径不该存交接')
  assertNothingHappened(sub)
})

// ── 交接服务的探测时机(v0.4.1:首次工具调用时探一次,不再在 apply 时)─────────────
//
// 背景:apply 那一刻同进程的 dsh-host-sl 还没把服务 provide 出来 ⇒ 旧版每次都写
// "服务不在场(dsh-host-sl 未装载?)",而稍后的工具调用又看得到它(21:38、23:05 两次 saveAll
// 都真的存了盘)。那是假阴性,README §5 还把它当排障线索 ⇒ 现在改成首次工具调用时探测。

test('交接服务探测:首次工具调用时写一次"在场",同一插件实例里再调用不再重复写(探测只读,不影响保存)', async () => {
  const handoff = makeHandoff()
  const registered = []
  const { ctx, dispose } = makeCtx({
    agents: { roots: () => [topAgent('session-self', 'running')] },
    [HANDOFF_SERVICE]: handoff.service,
    tools: makeTools(registered),
  })
  // 同一个插件实例(一次 apply)里调两次工具 —— 探测位是 apply 内的闭包变量,只该写一次
  apply(ctx, {
    logFile: testLog,
    pendingDir: mkdtempSync(join(scratch, 'pending-')),
    restartScript: FAKE_SCRIPT,
    psExe: FAKE_PS_EXE,
    wmiExec: makeLauncherStub().wmiExec,
  })
  const before = countIn(readFileSync(testLog, 'utf8'), '服务在场(首次工具调用时探测)')
  // "不一致"那行的计数也要取差值:同一个日志文件里,别的用例(服务在场 + 保存失败)会写它
  const beforeMismatch = countIn(readFileSync(testLog, 'utf8'), '但真实调用没成功')
  const execArgs = { agent: { session: { id: 'session-self', header: { origin: 'main' } } } }
  const first = await registered[0].execute({}, execArgs)
  const second = await registered[0].execute({}, execArgs)
  dispose()
  assert.equal(first.ok, true, first.message)
  assert.equal(second.ok, true, second.message)
  const log = readFileSync(testLog, 'utf8')
  assert.equal(countIn(log, '服务在场(首次工具调用时探测)') - before, 1, '只探测一次(第二次调用不再写)')
  assert.equal(handoff.calls.length, 2, '探测是只读的:两次工具调用各真实保存一次')
  assert.equal(countIn(log, '但真实调用没成功') - beforeMismatch, 0, '探测与真实结果一致时不该写"不一致"那行')
})

test('交接服务探测:服务不在场时也写一次(如实说"未装载"),重启照常', async () => {
  const before = countIn(readFileSync(testLog, 'utf8'), '服务不在场(dsh-host-sl 未装载?)')
  const scene = await callTool({ agents: { roots: () => [topAgent('session-self', 'running')] } })
  assertAllowPath(scene)
  assert.equal(scene.result.handoff.ok, false, '服务不在场 ⇒ 交接没存下(工具照常)')
  const log = readFileSync(testLog, 'utf8')
  assert.equal(countIn(log, '服务不在场(dsh-host-sl 未装载?)') - before, 1)
  assert.ok(log.includes('(首次工具调用时探测)'), '两种结论都要标明这是"首次工具调用时探测"的')
})

test('交接服务探测:"在场但没有 saveAll()"(旧版 dsh-host-sl)与"没装"分开写', async () => {
  const before = countIn(readFileSync(testLog, 'utf8'), '服务在场但没有 saveAll()')
  const scene = await callTool({
    agents: { roots: () => [topAgent('session-self', 'running')] },
    [HANDOFF_SERVICE]: { save: () => ({ ok: true }) },
  })
  assertAllowPath(scene)
  assert.equal(scene.result.handoff.ok, false)
  assert.equal(countIn(readFileSync(testLog, 'utf8'), '服务在场但没有 saveAll()') - before, 1)
  assert.ok(!readFileSync(testLog, 'utf8').includes('服务不在场(dsh-host-sl 未装载?) 服务在场但没有'),
    '两种结论是互斥的,不许同时出现')
})

test('探测结论与真实调用结果不一致时如实区分(以真实调用为准)', () => {
  // 探测说在场、真实调用失败 ⇒ 写一行,带上真实失败原因
  assert.match(describeHandoffProbeMismatch('present', { ok: false, files: [], text: '读会话历史失败(桩)' }),
    /探测说"在场",但真实调用没成功 —— 以真实调用为准:读会话历史失败\(桩\)/)
  // 探测说不在场/形态不符、真实调用却成功 ⇒ 写一行,说明探测那一刻的结论不可信
  assert.match(describeHandoffProbeMismatch('absent', { ok: true, files: ['a.md', 'b.md'], text: 'a.md' }),
    /探测说"不在场",但真实调用成功了 —— 探测那一刻的结论不可信,以真实调用为准\(本次已保存 2 份\)/)
  assert.match(describeHandoffProbeMismatch('shape', { ok: true, files: [], text: '' }), /接口形态不符/)
  assert.match(describeHandoffProbeMismatch('error', { ok: true, files: [], text: '' }), /读取抛错/)
  // 一致时一个字都不写(日志里不该出现自相矛盾的两行)
  assert.equal(describeHandoffProbeMismatch('present', { ok: true, files: ['a.md'], text: 'a.md' }), '')
  assert.equal(describeHandoffProbeMismatch('absent', { ok: false, files: [], text: 'x' }), '')
  assert.equal(describeHandoffProbeMismatch('shape', { ok: false, files: [], text: 'x' }), '')
  assert.equal(describeHandoffProbeMismatch('unprobed', { ok: true, files: [], text: '' }), '')
})

test('工具路径:探测说"在场"但保存失败 ⇒ 日志里明说以真实调用为准', async () => {
  const handoff = makeHandoff({ result: { ok: false, message: '桩:读会话历史失败', items: [] } })
  const before = countIn(readFileSync(testLog, 'utf8'), '但真实调用没成功')
  const scene = await callTool({
    agents: { roots: () => [topAgent('session-self', 'running')] },
    [HANDOFF_SERVICE]: handoff.service,
  })
  assertAllowPath(scene)
  assert.equal(scene.result.handoff.ok, false)
  assert.equal(countIn(readFileSync(testLog, 'utf8'), '但真实调用没成功') - before, 1)
})
