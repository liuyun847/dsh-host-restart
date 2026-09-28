/**
 * 事故回归测试(2026-09-17):插件 apply 抛错 = **整个 dsh 起不来**。
 *
 * 当天的两个真实故障各有对应断言:
 *   1. `ctx.timeout` 未在 inject 中声明 ⇒ cordis 访问未注入服务属性抛错 ⇒ 插件树加载失败
 *      ⇒ 新 dsh 在打印 token URL 前退出,看门狗反复拉起反复崩(浏览器卡"启动中");
 *   2. `parameters` 里写 `required: false` ⇒ defineTool 抛错 ⇒ 工具静默注册失败(重启功能形同虚设)。
 *
 * 只在临时目录里留痕,不碰真实 profile / 标记 / 日志。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { apply, HANDOFF_SERVICE, inject, TOOL_NAME, VERSION } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')

const scratch = mkdtempSync(join(tmpdir(), 'dsh-restart-test-'))
const testLog = join(scratch, 'restart.log')
// 本文件只 apply、不 execute,本来就到不了启动层;仍显式设熔断,让"测试进程不可能真实启动驱动脚本"
// 成为文件属性而不是承诺(放行路径会真的起进程,见 session-gate 文件头的 2026-09-21 事故记录)。
process.env.DSH_RESTART_NO_LAUNCH = '1'
process.env.DSH_RESTART_LOG_FILE = testLog
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* 忽略 */ } })

/** cordis Context 自身提供、不需要 inject 声明的成员。 */
const CONTEXT_BUILTINS = new Set([
  'get', 'set', 'provide', 'effect', 'on', 'off', 'emit', 'parallel', 'waterfall', 'bail', 'serial',
  'start', 'stop', 'scope', 'root', 'fiber', 'logger', 'inject', 'mixin', 'reflect', 'registry',
  'isolate', 'extend', 'plugin', 'accept',
])

/** ctx 上由服务 mixin 提供的属性 → 该属性要求声明的服务名(timer 服务的 mixin)。 */
const SERVICE_MIXINS = {
  timeout: 'timer',
  interval: 'timer',
  throttle: 'timer',
  debounce: 'timer',
}

/** 去掉注释后的代码正文:避免注释里提到的 `required:false` 之类被当真。 */
function codeOnly(text) {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
    })
    .join('\n')
}

/**
 * 造一个带 cordis 语义的假 ctx:未在 inject 声明的"服务属性"访问会抛错,ctx.get() 才是安全读取。
 * @param services 可解析的服务表(缺谁就等于该服务不可用)。
 * @param options.noTimeout 为 true 时连 ctx.timeout 也不提供 —— 用来复现事故路径。
 */
function makeCtx(services, options = {}) {
  const handlers = new Map()
  const effects = []
  const base = {
    get: (name) => services[name],
    on: (event, handler) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    // cordis 的清理机制:回调的返回值(清理函数)登记进当前 fiber,卸载时由 cordis 执行
    // (真实现见 cordis/lib/index.js 的 _execute → runner.collect)。
    effect: (callback) => {
      const disposer = callback()
      if (typeof disposer === 'function') effects.push(disposer)
      return () => {}
    },
  }
  if (options.noTimeout !== true) {
    base.timeout = (fn, ms) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    }
  }
  const ctx = new Proxy(base, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver)
      if (typeof prop === 'string' && prop in services) {
        throw new Error(`cannot access ctx.${prop} without an inject declaration`)
      }
      return undefined
    },
  })
  return {
    ctx,
    /** ctx.effect 登记到的清理函数(卸载时该被执行的那些)。 */
    effects,
    fire: (event) => { for (const handler of handlers.get(event) ?? []) handler() },
    /** 模拟 cordis 的 fiber 卸载:跑 ctx.effect 登记的清理函数(真宿主由 cordis 自己跑)。 */
    dispose: () => { for (const cleanup of effects.splice(0)) cleanup() },
  }
}

/** 造一个能记录注册与回收的 tools 服务。 */
function makeTools(registered, disposers) {
  return {
    register: (definition) => {
      registered.push(definition)
      return () => disposers.push('tool')
    },
  }
}

const baseConfig = () => ({ logFile: testLog, pendingDir: join(scratch, 'pending') })

test('inject 覆盖代码里访问的每个 ctx.<service>(漏一个就是宿主起不来)', () => {
  const accessed = [...new Set([...source.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))]
  assert.ok(accessed.length > 0, '没扫到任何 ctx.* 访问,说明正则或源码结构变了,请检查本测试')
  const missing = accessed.filter((name) => {
    if (CONTEXT_BUILTINS.has(name)) return false
    return !inject.includes(SERVICE_MIXINS[name] ?? name)
  })
  assert.deepEqual(missing, [], `ctx.${missing.join(', ctx.')} 被访问但未在 inject 中声明`)
  assert.ok(inject.includes('timer'), 'ctx.timeout 依赖 timer 服务,必须声明')
})

test('parameters 不再出现 required: false(value-schema DSL 只接受 required: true)', () => {
  assert.ok(
    !/required\s*:\s*false/.test(codeOnly(source)),
    'required:false 会让 defineTool 抛错,工具静默注册失败',
  )
})

test('等待不可被调用方放大:代码里不再有 wait_seconds 参数与 resolveWaitSeconds', () => {
  // 2026-09-27:等待固定成 WAIT_SECONDS —— 准入判据是"调用瞬间"的快照,
  // 只要模型还能把等待调大,这段窗口里开始的活就没人再检查一遍。
  const code = codeOnly(source)
  assert.ok(!/wait_seconds/.test(code), 'wait_seconds 参数不许回来')
  assert.ok(!/resolveWaitSeconds/.test(code), 'resolveWaitSeconds 已删除')
  assert.ok(/export const WAIT_SECONDS = 2\b/.test(code), '等待必须是写死的常量 2')
})

test('apply 正常路径:注册 restart_dsh;卸载时经 ctx.effect 回收工具注册(不是 ctx.on("dispose"))', () => {
  const registered = []
  const disposers = []
  const handle = makeCtx({ tools: makeTools(registered, disposers), timer: {} })
  assert.doesNotThrow(() => apply(handle.ctx, baseConfig()))
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, TOOL_NAME)
  // 2026-09-29:清理**只**登记在 ctx.effect 上(合并后不留第二处重复登记)。
  // 旧版挂在 ctx.on('dispose', …) 上,而本机 cordis 卸载时发的是 internal/plugin
  // ⇒ 那段回调从来没触发过(工具 disposer 没被调用、启动注入定时器没被取消)。
  assert.equal(handle.effects.length, 1, 'ctx.effect 必须恰好登记一处清理')
  assert.equal(typeof handle.effects[0], 'function', '登记的是清理函数')
  assert.doesNotThrow(() => handle.dispose())
  assert.deepEqual(disposers, ['tool'])
})

test(`版本行回显 v${VERSION}(排障时用它确认"新版本已生效")`, () => {
  const registered = []
  const disposers = []
  const { ctx } = makeCtx({ tools: makeTools(registered, disposers), timer: {} })
  apply(ctx, baseConfig())
  const log = readFileSync(testLog, 'utf8')
  assert.ok(log.includes(`apply: v${VERSION}`), `日志里要有 apply: v${VERSION} 这一行`)
  assert.ok(log.includes(`${HANDOFF_SERVICE}(可选,不进 inject)`), '启动时要回显交接服务的口径')
})

test('slHandoff 服务不进 inject(可选读取:服务缺席时本插件仍要 apply)', () => {
  // 这条是硬约束:inject 是"全有才 apply"的硬门 —— 写进去就等于"dsh-host-sl 没装时
  // 连 restart_dsh 工具都不注册"。必须走 ctx.get() 可选读取 + fail-soft。
  assert.ok(!inject.includes(HANDOFF_SERVICE), '交接服务名不许进 inject')
  assert.equal(HANDOFF_SERVICE, 'slHandoff')
  assert.match(codeOnly(source), /ctx\.get\(HANDOFF_SERVICE\)/, '必须用 ctx.get() 可选读取')
})

test('apply 阶段不再探测交接服务(v0.4.1:那一刻必是假阴性,探测挪到首次工具调用)', () => {
  // 2026-09-28 实测:apply 时同进程的 dsh-host-sl 还没 provide 服务 ⇒ 旧版每次都写
  // "重启前的交接保存:slHandoff 服务不在场(dsh-host-sl 未装载?),工具照常可用",
  // 而稍后的工具调用又看得到它(21:38、23:05 两次 saveAll 都真的存了盘)。README §5 曾把这行
  // 当"对端插件没装"的排障线索 ⇒ 必须消失。这里连"服务在场"的情形也钉住:apply 一个探测行都不许有。
  const logFile = join(scratch, 'apply-probe.log')
  const registered = []
  const disposers = []
  const { ctx } = makeCtx({
    tools: makeTools(registered, disposers),
    timer: {},
    [HANDOFF_SERVICE]: { saveAll: () => ({ ok: true, items: [] }) },
  })
  assert.doesNotThrow(() => apply(ctx, { ...baseConfig(), logFile }))
  const log = readFileSync(logFile, 'utf8')
  assert.ok(!log.includes('重启前的交接保存:'), `apply 阶段不许再探测交接服务,实际日志:\n${log}`)
  assert.ok(!log.includes('服务不在场'), '那行假阴性必须消失')
  assert.ok(log.includes(`handoff=${HANDOFF_SERVICE}(可选,不进 inject)`), 'apply 行里的口径回显保留')
})

test('交接保存的调用点在启动驱动脚本之前(顺序:保存 → 写标记 → 起脚本)', () => {
  // 保存若排在启动之后,它就会吃掉驱动脚本那 2 秒静默窗口(工具结果落盘用的);
  // 排在前面只让"发起重启"整体晚一点点。这条顺序是硬要求,用静态位置钉住。
  const code = codeOnly(source)
  const saveAt = code.indexOf('await saveHandoffBeforeRestart(ctx, session')
  const writeAt = code.indexOf('writePendingFile(resolved.pendingFile, record)')
  const launchAt = code.indexOf('await launchDriver(resolved, sessionId')
  assert.ok(saveAt > 0 && writeAt > 0 && launchAt > 0, '三处调用都要在源码里找得到')
  assert.ok(saveAt < writeAt, '保存必须在 writePendingFile 之前')
  assert.ok(writeAt < launchAt, '写标记必须在启动驱动脚本之前')
  assert.match(code, /const handoff = await saveHandoffBeforeRestart\(/, '必须 await 到保存完成才往下走(顺序是硬要求)')
})

test('timer 服务缺失时回退 setTimeout,而不是把异常抛回 loader', () => {
  const registered = []
  const disposers = []
  const handle = makeCtx({ tools: makeTools(registered, disposers) }, { noTimeout: true })
  assert.doesNotThrow(() => apply(handle.ctx, baseConfig()))
  assert.equal(registered.length, 1, '定时器拿不到不该连工具注册一起废掉')
  // 回退出来的全局 setTimeout 也由同一处 ctx.effect 清理负责取消(测试不留悬挂定时器)
  assert.doesNotThrow(() => handle.dispose())
})

test('配置非法时只降级并留日志,绝不抛回 loader', () => {
  const registered = []
  const disposers = []
  const { ctx } = makeCtx({ tools: makeTools(registered, disposers), timer: {} })
  assert.doesNotThrow(() => apply(ctx, { ...baseConfig(), bootDelayMs: -1 }))
  assert.equal(registered.length, 0, '降级路径下不注册工具')
  assert.match(readFileSync(testLog, 'utf8'), /apply 抛错,插件已降级/)
})
