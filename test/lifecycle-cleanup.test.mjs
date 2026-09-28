/**
 * 卸载清理的回归测试(2026-09-29 新增)。
 *
 * 背景(本包的一处真实缺陷,已修):v0.4.2 的清理挂在 `ctx.on('dispose', …)` 上,而本机 cordis
 * 卸载插件时发的是 `internal/plugin` —— **根本没有 `dispose` 事件** ⇒ 那段回调从来没触发过:
 * `tools.register` 返回的 disposer 没被调用、"启动注入"的定时器没被取消。
 * 现在唯一登记处是 `ctx.effect(() => 返回清理函数)`:返回值被登记进当前 fiber,卸载时真的会执行
 * (cordis `lib/index.js` 的 `_execute` → `runner.collect`;同 profile 的 dsh-host-sl 也这么写)。
 *
 * 本文件用假 ctx 驱动**真实的** `lib/index.js`,钉住四件事:
 *   A. 装载后 `ctx.effect` **恰好**登记一处清理函数(合并后不留重复登记),且没有登记任何 dispose 处理器;
 *   B. 执行它 ⇒ `tools.register` 返回的 disposer 被调用、"启动注入"定时器被取消(到期后不再有注入动作);
 *   C. 执行它 ⇒ `disposed` 置位(兜底复查即便被硬触发也直接跳过)、"兜底复查"定时器被取消;
 *   D. 清理可重复调用:不抛错、不重复调用 disposer;disposer 抛错 / 取消失败都不许把异常抛回 cordis。
 * 另有一条反向对照:不执行清理时,同一个定时器到期**确实**会注入 —— 证明 B 的断言不是空转。
 *
 * 副作用边界:一切落盘都在临时目录里;`DSH_RESTART_NO_LAUNCH=1` 进程级熔断;
 * restartScript / psExe 指向不存在的路径。本文件只跑"启动时注入"那条路,不经过 launchDriver,
 * 但"测试进程不可能真实启动驱动脚本"仍要是文件属性而不是承诺(2026-09-21 事故的教训)。
 * 跑法:`node --test "test/*.test.mjs"`(或 npm test)
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { apply, buildInjectText } from '../lib/index.js'

const SESSION_ID = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-restart-lifecycle-'))
// 熔断:本文件到不了启动层,但"测试进程不可能真实启动驱动脚本"要是文件属性而不是承诺
process.env.DSH_RESTART_NO_LAUNCH = '1'
process.env.DSH_RESTART_LOG_FILE = join(scratch, 'fallback.log')
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* 忽略 */ } })

/**
 * 假 ctx:cordis 语义的两处最小实现。
 *   · `effect(callback)` —— 回调的返回值(清理函数)登记起来,`effects` 就是"卸载时会跑的那些";
 *   · `timeout(fn, ms)` —— 只登记不真跑,返回的取消函数把这条标记成 canceled(可选的抛错桩)。
 * `on()` 也照实记下来,好让"有没有人还挂在 dispose 事件上"可断言。
 */
function makeCtx(services = {}, options = {}) {
  const timers = []
  const effects = []
  const events = new Map()
  const base = {
    get: (name) => services[name],
    on: (event, handler) => {
      const list = events.get(event) ?? []
      list.push(handler)
      events.set(event, list)
      return () => {}
    },
    effect: (callback) => {
      const disposer = callback()
      if (typeof disposer === 'function') effects.push(disposer)
      return () => {}
    },
    timeout: (fn, ms) => {
      const entry = { fn, ms, canceled: false }
      timers.push(entry)
      return () => {
        entry.canceled = true
        if (options.cancelThrows === true) throw new Error('桩:定时器取消失败')
      }
    },
  }
  return {
    ctx: base,
    timers,
    effects,
    events,
    /** 跑第 index 个定时任务(0 = 启动注入,1 = 兜底复查);已取消的按"不会跑"处理。 */
    async runTimer(index) {
      const entry = timers[index]
      assert.ok(entry, `第 ${index} 个定时任务不存在(已登记 ${timers.length} 个)`)
      if (entry.canceled) return undefined
      return await entry.fn()
    },
  }
}

/**
 * 造一次"新进程启动"现场:写重启标记 + apply。
 * @param options.handoff true ⇒ 再写一份"交接待续标记"(里面含本会话未处理条目),
 *   启动注入会让位并排一个兜底复查定时器(timers[1])。
 * @param options.toolDisposerThrows / options.cancelThrows ⇒ 复现"清理途中抛错"。
 */
function scene(options = {}) {
  const dir = mkdtempSync(join(scratch, 'case-'))
  const logFile = join(dir, 'restart.log')
  const pendingDir = join(dir, 'dsh-restart')
  const pendingFile = join(pendingDir, 'pending.json')
  const handoffPendingFile = join(dir, 'sl-handoff', 'pending.json')

  mkdirSync(pendingDir, { recursive: true })
  writeFileSync(pendingFile, `${JSON.stringify({
    version: 1,
    sessionId: SESSION_ID,
    text: buildInjectText(),
    createdAt: Date.now(),
    waitSeconds: 2,
    pidBefore: process.pid,
  }, null, 2)}\n`, 'utf8')
  if (options.handoff === true) {
    mkdirSync(dirname(handoffPendingFile), { recursive: true })
    writeFileSync(handoffPendingFile, `${JSON.stringify({
      version: 2,
      items: [{ sessionId: SESSION_ID, kind: 'root' }],
    }, null, 2)}\n`, 'utf8')
  }

  const followups = []
  const agent = { status: 'idle', followup: (message) => followups.push(message) }
  const registered = []
  const toolDisposals = []
  const handle = makeCtx({
    sessionController: { resolveAgent: async () => ({ agent }) },
    tools: {
      register: (definition) => {
        registered.push(definition)
        return () => {
          toolDisposals.push('tool')
          if (options.toolDisposerThrows === true) throw new Error('桩:工具 disposer 抛错')
        }
      },
    },
  }, options)
  apply(handle.ctx, {
    logFile,
    pendingDir,
    handoffPendingFile,
    restartScript: join(dir, 'missing-driver.ps1'),
    psExe: join(dir, 'missing-pwsh.exe'),
    bootDelayMs: 0,
    controllerWaitMs: 0,
  })
  return {
    handle,
    dir,
    logFile,
    pendingFile,
    handoffPendingFile,
    followups,
    registered,
    toolDisposals,
    log: () => { try { return readFileSync(logFile, 'utf8') } catch { return '' } },
  }
}

test('A. 装载后 ctx.effect 恰好登记一处清理函数,且没有登记任何 dispose 处理器', () => {
  const s = scene()
  assert.equal(s.registered.length, 1, 'restart_dsh 已注册(下面的清理才有东西可回收)')
  assert.equal(s.handle.effects.length, 1, 'ctx.effect 只许有一处登记(不留重复登记)')
  assert.equal(typeof s.handle.effects[0], 'function', '登记的是清理函数')
  assert.equal(s.handle.events.has('dispose'), false,
    '不许再用 ctx.on("dispose") —— 本机 cordis 卸载时发的是 internal/plugin,没有 dispose 事件')
  assert.equal(s.handle.timers.length, 1, '只排了「启动注入」一个定时器')
})

test('B. 执行清理 ⇒ 工具 disposer 被调用、启动注入定时器被取消(到期后不再有注入动作)', async () => {
  const s = scene()
  assert.equal(s.handle.timers[0].canceled, false, '清理前定时器是活的')
  s.handle.effects[0]() // 模拟 cordis 卸载:执行 effect 登记的清理
  assert.deepEqual(s.toolDisposals, ['tool'], 'tools.register 返回的 disposer 必须被调用')
  assert.equal(s.handle.timers[0].canceled, true, '启动注入定时器必须被取消')
  await s.handle.runTimer(0)
  assert.equal(s.followups.length, 0, '已取消的定时器不该再注入「已重启」')
  assert.ok(existsSync(s.pendingFile), '标记原样留着(没人消费它)')
  assert.match(s.log(), /dispose:已回收/)
})

test('B 的反向对照:不执行清理时,同一个定时器到期确实会注入(证明 B 的断言不是空转)', async () => {
  const s = scene()
  await s.handle.runTimer(0)
  assert.equal(s.followups.length, 1, '定时器到期 ⇒ 注入一次「已重启」')
  assert.ok(!existsSync(s.pendingFile), '标记被消费掉')
})

test('C. 执行清理 ⇒ disposed 置位 + 兜底复查定时器被取消(硬触发复查也直接跳过)', async () => {
  const s = scene({ handoff: true })
  assert.equal(s.handle.timers.length, 1, 'apply 只排启动注入')
  await s.handle.runTimer(0)
  assert.equal(s.handle.timers.length, 2, '让位给交接记录 ⇒ 启动注入之外还排了兜底复查')
  assert.equal(s.followups.length, 0, '让位时本插件不自己注入')
  assert.equal(s.handle.timers[1].canceled, false, '清理前复查定时器是活的')

  s.handle.effects[0]()
  assert.equal(s.handle.timers[1].canceled, true, '兜底复查定时器必须被取消')

  // 硬触发(绕过 canceled):验证 disposed 真的置位了 —— 复查进来第一件事就是看它
  await s.handle.timers[1].fn()
  assert.equal(s.followups.length, 0, '已卸载 ⇒ 兜底注入必须跳过')
  assert.match(s.log(), /插件已卸载,兜底注入跳过/)
})

test('D. 清理可重复调用:不抛错,也不重复调用 disposer', () => {
  const s = scene()
  const cleanup = s.handle.effects[0]
  cleanup()
  assert.deepEqual(s.toolDisposals, ['tool'])
  assert.doesNotThrow(() => { cleanup(); cleanup() })
  assert.deepEqual(s.toolDisposals, ['tool'], '重复清理不重复调用 disposer(第一次之后已置 null)')
  assert.equal(s.handle.timers[0].canceled, true)
})

test('D2. disposer 抛错 / 定时器取消失败都不许把异常抛回 cordis', async () => {
  const s = scene({ handoff: true, toolDisposerThrows: true, cancelThrows: true })
  await s.handle.runTimer(0) // 排上兜底复查定时器,让两处取消都真的被走到
  assert.equal(s.handle.timers.length, 2, '启动注入 + 兜底复查')
  assert.doesNotThrow(() => s.handle.effects[0](), '清理里的每一处都各自兜了 try/catch')
  assert.equal(s.handle.timers[0].canceled, true, '取消失败也要先如实标记(桩先置位再抛)')
  assert.equal(s.handle.timers[1].canceled, true, '第二处取消同样不许把异常抛出去')
  assert.deepEqual(s.toolDisposals, ['tool'], 'disposer 被调用过:它自己抛错不该中断清理')
  assert.match(s.log(), /dispose:已回收/)
})
