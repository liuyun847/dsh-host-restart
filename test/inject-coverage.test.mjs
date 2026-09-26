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
import { apply, inject, TOOL_NAME } from '../lib/index.js'

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
  const base = {
    get: (name) => services[name],
    on: (event, handler) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
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
    fire: (event) => { for (const handler of handlers.get(event) ?? []) handler() },
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

test('apply 正常路径:注册 restart_dsh,dispose 时回收且不留悬挂定时器', () => {
  const registered = []
  const disposers = []
  const { ctx, fire } = makeCtx({ tools: makeTools(registered, disposers), timer: {} })
  assert.doesNotThrow(() => apply(ctx, baseConfig()))
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, TOOL_NAME)
  assert.doesNotThrow(() => fire('dispose'))
  assert.deepEqual(disposers, ['tool'])
})

test('timer 服务缺失时回退 setTimeout,而不是把异常抛回 loader', () => {
  const registered = []
  const disposers = []
  const { ctx, fire } = makeCtx({ tools: makeTools(registered, disposers) }, { noTimeout: true })
  assert.doesNotThrow(() => apply(ctx, baseConfig()))
  assert.equal(registered.length, 1, '定时器拿不到不该连工具注册一起废掉')
  assert.doesNotThrow(() => fire('dispose'))
})

test('配置非法时只降级并留日志,绝不抛回 loader', () => {
  const registered = []
  const disposers = []
  const { ctx } = makeCtx({ tools: makeTools(registered, disposers), timer: {} })
  assert.doesNotThrow(() => apply(ctx, { ...baseConfig(), waitSeconds: 0 }))
  assert.equal(registered.length, 0, '降级路径下不注册工具')
  assert.match(readFileSync(testLog, 'utf8'), /apply 抛错,插件已降级/)
})
