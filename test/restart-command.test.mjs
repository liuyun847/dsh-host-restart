/**
 * `/restart` 人工指令测试(v0.7.0,2026-10-03)。
 *
 * 背景:此前重启只有模型工具一个入口 —— 人想重启得先说服模型去调它。现在多了一条人能直接敲的
 * 指令(`ctx.commands.register`,契约见 dsh-commands 的 CommandDefinition),**与工具共用同一个
 * 执行体 performRestart**,差别只有"失败文案前缀"与"成功文案说给谁听"。
 *
 * 本文件钉住的四件事:
 *   1) 注册形态:`name` 必须是 `restart`(dsh-commands 的命令名规则 `^[a-z][a-z0-9_-]*$`)、
 *      description 非空、handler 是函数;commands 服务缺席时只降级、工具照常注册;
 *   2) 执行链路与工具**完全同源**:同一条 performRestart ⇒ 同一份标记内容、同样恰好一次启动桩、
 *      同样的拒绝边界(无归属会话 / 子代理发起时一个字节都不写);
 *   3) 返回形态符合 CommandResult 契约:success/error 的 text 都必须是非空字符串
 *      (dsh-commands 的 normalizeResult 会抛);且指令文案里**不含**工具那句"请立刻结束本轮回复";
 *   4) 清理:命令 disposer 与工具 disposer 由**同一处** ctx.effect 回收(不给它单独再挂 effect)。
 *
 * ⚠ 与 session-gate 同款的三道防线(2026-09-21 事故的教训,放行路径会真的起进程):
 *   ① apply 的 config 传 `wmiExec` 桩(唯一会 spawn 的那一步);② restartScript / psExe 指向
 *   不存在的假路径;③ 进程级熔断 DSH_RESTART_NO_LAUNCH=1。副作用只在 scratch 临时目录。
 *
 * 跑法:node --test "test/*.test.mjs"(或 npm test)
 */
import { strict as assert } from 'node:assert'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  COMMAND_NAME,
  DEFAULT_INJECT_TEXT,
  TOOL_NAME,
  VERSION,
  WAIT_SECONDS,
  apply,
  inject,
} from '../lib/index.js'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-restart-cmd-'))
const testLog = join(scratch, 'restart.log')

// 防线 ③:进程级熔断(必须在任何 handler 执行之前设好)
process.env.DSH_RESTART_NO_LAUNCH = '1'
process.env.DSH_RESTART_LOG_FILE = testLog
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* 忽略 */ } })

// 防线 ②:假脚本 / 假解释器路径(都不存在)
const FAKE_SCRIPT = join(scratch, 'no-such-driver-dir', 'definitely-missing.ps1')
const FAKE_PS_EXE = join(scratch, 'no-such-pwsh-dir', 'also-missing.exe')
assert.equal(existsSync(FAKE_SCRIPT), false, '假驱动脚本路径必须不存在')
assert.equal(existsSync(FAKE_PS_EXE), false, '假解释器路径必须不存在')

/** 桩回显的 WMI 侧 pid。 */
const STUB_PID = 51515

/** 造一个够用的 cordis ctx 桩(与 session-gate 同款:effect 登记清理函数,get 读服务表)。 */
function makeCtx(services = {}) {
  const effects = []
  const base = {
    get: (name) => services[name],
    on: () => () => {},
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
  return { ctx: base, effects, dispose: () => { for (const cleanup of effects.splice(0)) cleanup() } }
}

/** tools 服务桩:拿住 defineTool 的定义,并记录 disposer 是否被调用。 */
function makeTools(sink, disposers) {
  return {
    register: (definition) => {
      sink.push(definition)
      return () => disposers.push('tool')
    },
  }
}

/** commands 服务桩:拿住 CommandDefinition,并记录 disposer 是否被调用。 */
function makeCommands(sink, disposers) {
  return {
    register: (definition) => {
      sink.push(definition)
      return () => disposers.push('command')
    },
  }
}

/** ── 防线 ①:WMI 启动桩(替掉源里唯一会 spawn 的 realExecFile)── */
function makeLauncherStub(options = {}) {
  const calls = []
  const wmiExec = async (file, args, execOptions) => {
    calls.push({ file, args, options: execOptions })
    if (options.fail === true) throw new Error(`桩:${file} 起不来(模拟通道失败)`)
    const command = typeof args?.[3] === 'string' ? args[3] : ''
    const sessionId = /-SessionId "([^"]+)"/.exec(command)?.[1]
    if (options.confirm !== false && typeof sessionId === 'string') {
      appendFileSync(testLog, `${new Date().toISOString()}  [driver] ===== 重启驱动启动 SessionId=${sessionId}\n`)
    }
    return { stdout: `${STUB_PID}\n`, stderr: '' }
  }
  return { calls, wmiExec }
}

/** 造一次指令调用现场:apply → 取出 CommandDefinition → 跑 handler。 */
async function callCommand(services = {}, options = {}) {
  const {
    invocation = {
      commandId: 'cmd-test-0001',
      agent: { session: { id: 'session-self', header: { origin: 'main' } } },
      rawInput: '',
      attachments: [],
      signal: new AbortController().signal,
    },
    stub = makeLauncherStub(),
    pendingDir = mkdtempSync(join(scratch, 'pending-')),
    config = {},
  } = options
  const registeredTools = []
  const registeredCommands = []
  const disposers = []
  const { ctx, effects, dispose } = makeCtx({
    ...services,
    tools: makeTools(registeredTools, disposers),
    commands: makeCommands(registeredCommands, disposers),
  })
  apply(ctx, {
    logFile: testLog,
    pendingDir,
    restartScript: FAKE_SCRIPT,
    psExe: FAKE_PS_EXE,
    wmiExec: stub.wmiExec,
    ...config,
  })
  assert.equal(registeredCommands.length, 1, 'commands.register 应当被调用一次')
  assert.equal(registeredCommands[0].name, COMMAND_NAME)
  const result = await registeredCommands[0].handler(invocation)
  // 撤掉 apply 排的启动注入定时器(走 ctx.effect 登记的清理,与真宿主卸载同一条路)
  dispose()
  return {
    result,
    stub,
    pendingDir,
    pendingFile: join(pendingDir, 'pending.json'),
    definition: registeredCommands[0],
    toolDefinition: registeredTools[0],
    disposers,
    effects,
  }
}

// ── 注册形态 ────────────────────────────────────────────────────────────────

test(`/restart 指令名符合 dsh-commands 的命令名规则(^[a-z][a-z0-9_-]*$),且与工具名不同`, () => {
  assert.equal(COMMAND_NAME, 'restart')
  assert.match(COMMAND_NAME, /^[a-z][a-z0-9_-]*$/u, '命令名不合法的话 commands.register 会直接抛')
  assert.notEqual(COMMAND_NAME, TOOL_NAME, '指令名与工具名是两个入口,不该混用同一个标识')
})

test('apply 注册 /restart:描述非空、无 input(本指令没有参数)、handler 是函数', async () => {
  const scene = await callCommand()
  assert.equal(scene.definition.name, 'restart')
  assert.equal(typeof scene.definition.description, 'string')
  assert.ok(scene.definition.description.trim().length > 0, '描述为空会被 commands 拒掉')
  assert.equal(scene.definition.input, undefined, '不声明 input:本指令不接受参数')
  assert.equal(typeof scene.definition.handler, 'function')
  assert.ok(readFileSync(testLog, 'utf8').includes(`/${COMMAND_NAME} 指令已注册`), '注册成功要留一行日志')
})

test('commands 服务缺席时只降级:工具照常注册、一个字节都不抛(与 slHandoff 同款 fail-soft)', () => {
  const registeredTools = []
  const disposers = []
  const { ctx, dispose } = makeCtx({ tools: makeTools(registeredTools, disposers) }) // 没有 commands
  assert.doesNotThrow(() => apply(ctx, { logFile: testLog, pendingDir: join(scratch, 'pending-nocmd') }))
  assert.equal(registeredTools.length, 1, 'commands 缺席不该连 restart_dsh 工具一起废掉')
  assert.equal(registeredTools[0].name, TOOL_NAME)
  assert.ok(readFileSync(testLog, 'utf8').includes(`commands 服务不可用,/${COMMAND_NAME} 指令未注册`))
  dispose()
})

test('commands 形态不符(没有 register 函数)⇒ 同样只降级', () => {
  const registeredTools = []
  const disposers = []
  const { ctx, dispose } = makeCtx({ tools: makeTools(registeredTools, disposers), commands: { somethingElse: () => {} } })
  assert.doesNotThrow(() => apply(ctx, { logFile: testLog, pendingDir: join(scratch, 'pending-shape') }))
  assert.equal(registeredTools.length, 1)
  dispose()
})

test('commands.register 抛错 ⇒ 只留日志、绝不抛回 loader(apply 抛错 = 整个 dsh 起不来)', () => {
  const registeredTools = []
  const disposers = []
  const commands = { register: () => { throw new Error('桩:commands 炸了') } }
  const { ctx, dispose } = makeCtx({ tools: makeTools(registeredTools, disposers), commands })
  assert.doesNotThrow(() => apply(ctx, { logFile: testLog, pendingDir: join(scratch, 'pending-throw') }))
  assert.equal(registeredTools.length, 1, '指令注册失败不该连工具一起废掉')
  assert.match(readFileSync(testLog, 'utf8'), new RegExp(`/${COMMAND_NAME} 指令注册失败`))
  dispose()
})

test('commands 不进 inject:只走 ctx.get() 可选读取,源码里不许有 ctx.commands 属性访问', () => {
  assert.ok(!inject.includes('commands'), 'commands 写进 inject 就等于"它缺席时连工具都不注册"')
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  // 与 inject-coverage 同款的"去注释"口径:只看代码行
  const code = source.split('\n').filter((line) => {
    const trimmed = line.trim()
    return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
  }).join('\n')
  assert.match(code, /ctx\.get\('commands'\)/, '必须用 ctx.get() 可选读取')
  assert.ok(!/\bctx\.commands\b/.test(code), 'cordis 对未注入的服务属性访问会抛错 —— 不许直接读 ctx.commands')
})

// ── 执行链路(与工具同源)────────────────────────────────────────────────────

test('指令成功路径:写标记 + 恰好一次启动桩 + 返回 success(文案是人向的)', async () => {
  const scene = await callCommand()
  const { result } = scene
  assert.equal(result.kind, 'success')
  assert.equal(typeof result.text, 'string')
  assert.ok(result.text.trim().length > 0, 'success 的 text 允许省略,但我们一律给')

  // 与工具同一条链路:桩被调用恰好一次,命令行里是假脚本 + 本次会话 id + 固定等待
  assert.equal(scene.stub.calls.length, 1, '放行路径必须且只能调用一次启动桩')
  const [call] = scene.stub.calls
  assert.equal(call.file, FAKE_PS_EXE)
  const wmiScript = call.args[3]
  assert.ok(wmiScript.includes('Win32_Process'))
  assert.ok(wmiScript.includes(FAKE_SCRIPT))
  assert.ok(!wmiScript.includes('dsh-restart.ps1'), '命令行里绝不能出现真实驱动脚本')
  assert.ok(wmiScript.includes('-SessionId "session-self"'))
  assert.ok(wmiScript.includes(`-WaitSeconds ${WAIT_SECONDS}`), '等待是固定值,指令也改不了')

  // 标记内容与工具路径完全一致(同一个 performRestart 写出来的)
  const pending = JSON.parse(readFileSync(scene.pendingFile, 'utf8'))
  assert.equal(pending.version, 1)
  assert.equal(pending.sessionId, 'session-self')
  assert.equal(pending.waitSeconds, WAIT_SECONDS)
  assert.equal(pending.text, DEFAULT_INJECT_TEXT, '注入文案仍是固定那句(v0.5.0 口径不变)')
  assert.equal(pending.pidBefore, process.pid)
})

test('指令文案是给人看的:不含工具那句"请立刻结束本轮回复",但保留公共前段', async () => {
  const scene = await callCommand()
  const { text } = scene.result
  assert.ok(!text.includes('请立刻结束本轮回复'), '那句是给模型的行为约束,对人没有意义')
  assert.ok(text.includes('重启已发起:驱动脚本'), text)
  assert.ok(text.includes(`/${COMMAND_NAME} 指令发起`), '要说清这次是谁发起的')
  assert.ok(text.includes('新进程起来后本会话自动续上'), text)
  assert.ok(text.includes(scene.pendingFile), '标记路径要写出来(排障用)')
})

test('指令与工具共用同一个执行体:两条入口写出的标记逐字节相同', async () => {
  const cmdScene = await callCommand()
  const cmdPending = readFileSync(cmdScene.pendingFile, 'utf8')

  // 工具路径:同一份 apply 逻辑,走 tools.register 拿到的定义
  const toolPendingDir = mkdtempSync(join(scratch, 'pending-tool-'))
  const stub = makeLauncherStub()
  const registeredTools = []
  const registeredCommands = []
  const disposers = []
  const { ctx, dispose } = makeCtx({
    tools: makeTools(registeredTools, disposers),
    commands: makeCommands(registeredCommands, disposers),
  })
  apply(ctx, { logFile: testLog, pendingDir: toolPendingDir, restartScript: FAKE_SCRIPT, psExe: FAKE_PS_EXE, wmiExec: stub.wmiExec })
  const toolResult = await registeredTools[0].execute({}, { agent: { session: { id: 'session-self', header: { origin: 'main' } } } })
  dispose()
  assert.equal(toolResult.ok, true, toolResult.message)

  const toolPending = readFileSync(join(toolPendingDir, 'pending.json'), 'utf8')
  // createdAt 是时间戳,必然不同 —— 去掉它之后其余字段必须逐字节相同
  const strip = (raw) => raw.replace(/"createdAt":\s*\d+/, '"createdAt": 0')
  assert.equal(strip(cmdPending), strip(toolPending), '两条入口必须写出同一份标记(共用 performRestart)')
})

// ── 拒绝边界(与工具一致:一个字节都不写)────────────────────────────────────

test('指令:拿不到归属会话 ⇒ error,不写标记、不碰启动桩', async () => {
  const scene = await callCommand({}, { invocation: { commandId: 'cmd-x', agent: {}, rawInput: '', attachments: [], signal: new AbortController().signal } })
  assert.equal(scene.result.kind, 'error')
  assert.match(scene.result.text, /^\/restart 未执行:本次调用没有归属会话/)
  assert.equal(scene.stub.calls.length, 0)
  assert.equal(existsSync(scene.pendingFile), false)
  assert.deepEqual(existsSync(scene.pendingDir) ? readdirSync(scene.pendingDir) : [], [])
})

test('指令:子代理会话发起 ⇒ error(只有主会话能在新进程里恢复),同样一个字节不写', async () => {
  const scene = await callCommand({}, {
    invocation: {
      commandId: 'cmd-x',
      agent: { session: { id: 'session-sub', header: { origin: 'subagent' } } },
      rawInput: '',
      attachments: [],
      signal: new AbortController().signal,
    },
  })
  assert.equal(scene.result.kind, 'error')
  assert.match(scene.result.text, /^\/restart 未执行:子代理会话不支持重启续跑/)
  assert.equal(scene.stub.calls.length, 0)
  assert.equal(existsSync(scene.pendingFile), false)
})

test('指令带参数 ⇒ 报用法错,连执行体都不进(不写标记、不碰桩)', async () => {
  const scene = await callCommand({}, {
    invocation: {
      commandId: 'cmd-x',
      agent: { session: { id: 'session-self', header: { origin: 'main' } } },
      rawInput: ' now',
      attachments: [],
      signal: new AbortController().signal,
    },
  })
  assert.equal(scene.result.kind, 'error')
  assert.equal(scene.result.text, '用法:/restart(不带参数)')
  assert.equal(scene.stub.calls.length, 0, '参数校验必须在执行体之前')
  assert.equal(existsSync(scene.pendingFile), false)
})

test('指令:启动通道全失败 ⇒ error 文案与工具同源(前缀换成指令名),标记被撤销', async () => {
  const stub = makeLauncherStub({ fail: true })
  const scene = await callCommand({}, { stub })
  assert.equal(scene.result.kind, 'error')
  assert.match(scene.result.text, /^\/restart 未执行:驱动脚本启动失败/)
  assert.equal(scene.stub.calls.length, 4, '两个通道 × 两个解释器都要被试过')
  assert.equal(existsSync(scene.pendingFile), false, '全通道失败必须撤销标记')
})

// ── 返回形态契约(dsh-commands 的 normalizeResult 会校验)────────────────────

test('返回形态始终是合法的 CommandResult:kind 合法、error 的 text 非空', async () => {
  const scenes = [
    await callCommand(),
    await callCommand({}, { invocation: { commandId: 'c', agent: {}, rawInput: '', attachments: [], signal: new AbortController().signal } }),
    await callCommand({}, { invocation: { commandId: 'c', agent: { session: { id: 's', header: {} } }, rawInput: ' x', attachments: [], signal: new AbortController().signal } }),
  ]
  for (const scene of scenes) {
    assert.ok(['success', 'error'].includes(scene.result.kind), `kind 非法:${scene.result.kind}`)
    if (scene.result.kind === 'error') {
      assert.equal(typeof scene.result.text, 'string')
      assert.ok(scene.result.text.trim().length > 0, 'error 的 text 为空会被 commands 抛错')
    }
  }
})

// ── 生命周期 ────────────────────────────────────────────────────────────────

test('卸载时命令 disposer 与工具 disposer 一起被回收(清理只登记一处 ctx.effect)', () => {
  const registeredTools = []
  const registeredCommands = []
  const disposers = []
  const { ctx, effects, dispose } = makeCtx({
    tools: makeTools(registeredTools, disposers),
    commands: makeCommands(registeredCommands, disposers),
  })
  apply(ctx, { logFile: testLog, pendingDir: join(scratch, 'pending-lifecycle') })
  assert.equal(effects.length, 1, 'ctx.effect 必须恰好登记一处清理(不许给 commands 单独再挂一处)')
  dispose()
  assert.deepEqual(disposers, ['tool', 'command'], '两个注册的 disposer 都要被调用')
  assert.match(readFileSync(testLog, 'utf8'), /dispose:已回收工具注册、指令注册/)
})

test(`版本行回显 v${VERSION}(排障时用它确认"新版本已生效")`, () => {
  assert.equal(VERSION, '0.7.0')
})
