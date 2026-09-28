/**
 * v0.4.2:**把「已重启」与 dsh-host-sl 的【sl 交接续跑】合并成一次注入、一轮**。
 *
 * 背景(用户要求):旧版一次重启注入两条消息、跑两轮 —— 本插件的「已重启」路径更短(约 4s)
 * 必然先跑,dsh-host-sl 多一步 `list()` 判定(约 6s)排进 next-turn ⇒ **第一轮拿不到交接记录**。
 *
 * 本文件钉住四组事:
 *   A. 取数顺序(fail-soft):`slHandoff.pendingSummary()` 优先 → 退回读
 *      `<DSH_HOME>\storages\sl-handoff\pending.json` → 都拿不到按"没人接手"处理;
 *   B. 让位判据:`sessionId` 相等且 `done !== true`(含 `active:false` 的空闲条目 —— 它同样
 *      意味着"有人接手"),命中 ⇒ **不注入**、删掉本插件标记、排一个 10s 复查;
 *      不命中 / 读不到 / 形态坏 ⇒ **照旧自己注入**;
 *   C. 兜底:复查时标记里仍有本会话条目**且**会话 `status !== 'running'` ⇒ 补注入一次;
 *      标记里已无本会话条目 / 会话已在 running / 插件已卸载 ⇒ 什么都不做;
 *   D. 复查定时器由 `ctx.effect` 登记、插件卸载时回收(**不用 `ctx.on('dispose')`**:
 *      本机 cordis 卸载时发的是 `internal/plugin`,没有 dispose 事件)。
 *
 * 副作用边界:一切落盘都在临时目录里;启动原语照旧不碰(本文件只跑"启动时注入"那条路,
 * 根本不经过 writePendingFile/launchDriver),仍设 `DSH_RESTART_NO_LAUNCH=1` 作为进程级熔断。
 * 跑法:`node --test "test/*.test.mjs"`(或 npm test)
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  DEFAULT_DEFER_RECHECK_MS,
  HANDOFF_PENDING_FILENAME,
  HANDOFF_SERVICE,
  HANDOFF_STORAGE_DIRNAME,
  apply,
  buildInjectText,
  findUnhandledHandoffItem,
  readHandoffPendingSummary,
  resolveConfig,
  runHandoffFallback,
  summarizeHandoffItems,
} from '../lib/index.js'

const SESSION_ID = 'session-11111111-2222-3333-4444-555555555555'
const OTHER_ID = 'session-99999999-8888-7777-6666-555555555555'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-restart-boot-'))
// 熔断:本文件不会走到启动层,但"测试进程不可能真实启动驱动脚本"要是文件属性而不是承诺
process.env.DSH_RESTART_NO_LAUNCH = '1'
process.env.DSH_RESTART_LOG_FILE = join(scratch, 'fallback.log')
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* 忽略 */ } })

// ── 桩 ──────────────────────────────────────────────────────────────────────

/**
 * 假 ctx:定时器**可手动触发**(本文件的时序断言全靠它)。
 *   · `timeout(fn, ms)` 只登记,返回的 disposer 把这条标记成 canceled;
 *   · `effect(callback)` 按 cordis 语义把返回的清理函数收起来,`dispose()` 时执行。
 */
function makeCtx(services = {}) {
  const timers = []
  const cleanups = []
  const base = {
    get: (name) => services[name],
    on: () => () => {},
    effect: (callback) => {
      const disposer = callback()
      if (typeof disposer === 'function') cleanups.push(disposer)
      return () => {}
    },
    timeout: (fn, ms) => {
      const entry = { fn, ms, canceled: false }
      timers.push(entry)
      return () => { entry.canceled = true }
    },
  }
  return {
    ctx: base,
    timers,
    /** 跑第 index 个定时任务(0 = 启动注入,1 = 兜底复查);返回它的 promise 便于 await。 */
    async runTimer(index = 0) {
      const entry = timers[index]
      assert.ok(entry, `第 ${index} 个定时任务不存在(已登记 ${timers.length} 个)`)
      if (entry.canceled) return undefined
      return await entry.fn()
    },
    /** 模拟 cordis 的 fiber 卸载:跑 ctx.effect 登记的清理函数。 */
    dispose() { for (const cleanup of cleanups.splice(0)) cleanup() },
  }
}

/** dsh-host-sl 的 v2 列表标记(条目字段可任意给)。 */
function handoffMarker(items, overrides = {}) {
  return {
    version: 2,
    createdAt: Date.now() - 1000,
    items: items.map((item) => ({ file: 'C:\\stub\\sl-handoff\\handoff-x.md', ...item })),
    ...overrides,
  }
}

/** 假 slHandoff 服务:只实现 pendingSummary()(形状按 dsh-host-sl v0.6.0 的契约)。 */
function makeHandoffService(options = {}) {
  const calls = []
  return {
    calls,
    service: {
      pendingSummary: () => {
        calls.push(Date.now())
        if (options.throws === true) throw new Error('桩:pendingSummary 炸了')
        return options.summary
      },
    },
  }
}

/**
 * 造一次"新进程启动"现场:写本插件的重启标记 + (可选)交接标记 → apply → 跑启动注入。
 * @param options.handoff 交接标记内容(对象 = JSON 写盘;字符串 = 原样写盘;undefined = 不写文件)
 * @param options.summary 假 slHandoff 服务要返回的摘要(不给就不挂服务)
 * @param options.status  resolveAgent 拿回来的 agent 的 status
 */
async function bootScene(options = {}) {
  const dir = mkdtempSync(join(scratch, 'case-'))
  const logFile = join(dir, 'restart.log')
  const pendingDir = join(dir, 'dsh-restart')
  const pendingFile = join(pendingDir, 'pending.json')
  const handoffPendingFile = options.handoffPendingFile ?? join(dir, HANDOFF_STORAGE_DIRNAME, HANDOFF_PENDING_FILENAME)
  const text = buildInjectText(options.note)

  if (options.marker !== false) {
    mkdirSync(pendingDir, { recursive: true })
    writeFileSync(pendingFile, `${JSON.stringify({
      version: 1,
      sessionId: options.sessionId ?? SESSION_ID,
      text,
      createdAt: Date.now(),
      waitSeconds: 2,
      pidBefore: process.pid,
    }, null, 2)}\n`, 'utf8')
  }
  if (options.handoff !== undefined) {
    mkdirSync(dirname(handoffPendingFile), { recursive: true })
    const body = typeof options.handoff === 'string' ? options.handoff : `${JSON.stringify(options.handoff, null, 2)}\n`
    writeFileSync(handoffPendingFile, body, 'utf8')
  }

  const followups = []
  const agent = {
    status: options.status ?? 'idle',
    followup: (message) => {
      if (options.followupThrows === true) throw new Error('桩:followup 炸了')
      followups.push(message)
    },
  }
  const controller = {
    resolveAgent: async () => (options.resolveFails === true
      ? { error: new Error('桩:恢复失败') }
      : { agent }),
  }
  const services = { sessionController: controller }
  if (options.summary !== undefined || options.summaryThrows === true) {
    services[HANDOFF_SERVICE] = makeHandoffService({ summary: options.summary, throws: options.summaryThrows }).service
  }
  const fake = makeCtx(services)
  apply(fake.ctx, {
    logFile,
    pendingDir,
    handoffPendingFile,
    restartScript: join(dir, 'missing.ps1'),
    psExe: join(dir, 'missing.exe'),
    bootDelayMs: 0,
    controllerWaitMs: 0,
    ...options.config,
  })
  await fake.runTimer(0)
  return {
    dir,
    logFile,
    pendingFile,
    handoffPendingFile,
    followups,
    agent,
    text,
    ...fake,
    log: () => { try { return readFileSync(logFile, 'utf8') } catch { return '' } },
    /** 注入进会话的那条消息的正文。 */
    injected: () => followups.map((message) => message.content.map((block) => block.text).join('')).join('\n---\n'),
  }
}

// ── A. 取数顺序(fail-soft)──────────────────────────────────────────────────

test('readHandoffPendingSummary:服务缺席 + 文件不存在 ⇒ exists:false / source:none(不抛)', () => {
  const { ctx } = makeCtx({})
  const resolved = resolveConfig({ handoffPendingFile: join(scratch, 'nope', 'pending.json') })
  const logs = []
  const summary = readHandoffPendingSummary(ctx, resolved, logs.push.bind(logs))
  assert.equal(summary.exists, false)
  assert.equal(summary.source, 'none')
  assert.deepEqual(summary.items, [])
  assert.match(summary.reason, /没有可用的待续标记/)
  assert.ok(logs.some((line) => line.includes('服务不在场')), `要写清为什么退到读文件:${logs.join('|')}`)
})

test('readHandoffPendingSummary:服务缺席时退回读文件(v2 列表 / v1 单会话都读得进)', () => {
  const dir = mkdtempSync(join(scratch, 'file-'))
  const file = join(dir, 'pending.json')
  const { ctx } = makeCtx({})

  writeFileSync(file, `${JSON.stringify(handoffMarker([{ sessionId: SESSION_ID, active: false }, { sessionId: OTHER_ID, done: true }]))}\n`, 'utf8')
  const v2 = readHandoffPendingSummary(ctx, resolveConfig({ handoffPendingFile: file }), () => {})
  assert.equal(v2.exists, true)
  assert.equal(v2.source, 'file')
  assert.deepEqual(v2.items, [
    { sessionId: SESSION_ID, kind: 'root', done: false, active: false, wake: false },
    { sessionId: OTHER_ID, kind: 'root', done: true, active: undefined, wake: false },
  ])

  // v1 单会话标记(0.2.x 写的):按 1 条读,不能因为没 items 就当成"读不到"
  writeFileSync(file, `${JSON.stringify({ version: 1, sessionId: SESSION_ID, file: 'C:\\x\\a.md', createdAt: Date.now() })}\n`, 'utf8')
  const v1 = readHandoffPendingSummary(ctx, resolveConfig({ handoffPendingFile: file }), () => {})
  assert.equal(v1.exists, true)
  assert.deepEqual(v1.items.map((item) => item.sessionId), [SESSION_ID])
})

test('readHandoffPendingSummary:形态坏(非对象 / 空对象 / 条目缺 sessionId / JSON 损坏)⇒ exists:false,不抛', () => {
  const dir = mkdtempSync(join(scratch, 'bad-'))
  const file = join(dir, 'pending.json')
  const { ctx } = makeCtx({})
  const resolved = resolveConfig({ handoffPendingFile: file })
  const cases = [
    ['[]', '数组不是标记'],
    ['{}', '没有 items 也没有 sessionId'],
    ['null', 'null'],
    ['{ not json', 'JSON 损坏'],
    [`${JSON.stringify({ version: 2, createdAt: Date.now(), items: [{ file: 'C:\\x\\a.md' }] })}`, '条目缺 sessionId'],
    [`${JSON.stringify({ version: 2, createdAt: Date.now(), items: ['x'] })}`, '条目不是对象'],
  ]
  for (const [body, why] of cases) {
    writeFileSync(file, body, 'utf8')
    let summary
    assert.doesNotThrow(() => { summary = readHandoffPendingSummary(ctx, resolved, () => {}) }, why)
    assert.equal(summary.exists, false, why)
    assert.deepEqual(summary.items, [], why)
  }
})

test('readHandoffPendingSummary:pendingSummary() 优先于读文件(两条来源不一致时以服务为准)', () => {
  const dir = mkdtempSync(join(scratch, 'prio-'))
  const file = join(dir, 'pending.json')
  // 文件里明明有本会话的条目,但服务说"没有待续标记" ⇒ 以服务为准(它就是权威读源)
  writeFileSync(file, `${JSON.stringify(handoffMarker([{ sessionId: SESSION_ID }]))}\n`, 'utf8')
  const { service } = makeHandoffService({ summary: { exists: false, reason: '没有待续标记（不存在或读不出）', items: [] } })
  const { ctx } = makeCtx({ [HANDOFF_SERVICE]: service })
  const summary = readHandoffPendingSummary(ctx, resolveConfig({ handoffPendingFile: file }), () => {})
  assert.equal(summary.source, 'service', '服务在场且方法可用时必须走服务')
  assert.equal(summary.exists, false)
  assert.match(summary.reason, /没有待续标记/)
})

test('readHandoffPendingSummary:旧版服务没有 pendingSummary() ⇒ 退回读文件', () => {
  const dir = mkdtempSync(join(scratch, 'old-'))
  const file = join(dir, 'pending.json')
  writeFileSync(file, `${JSON.stringify(handoffMarker([{ sessionId: SESSION_ID }]))}\n`, 'utf8')
  const { ctx } = makeCtx({ [HANDOFF_SERVICE]: { saveAll: () => ({ ok: true, items: [] }) } })
  const logs = []
  const summary = readHandoffPendingSummary(ctx, resolveConfig({ handoffPendingFile: file }), logs.push.bind(logs))
  assert.equal(summary.source, 'file')
  assert.equal(summary.exists, true)
  assert.ok(logs.some((line) => line.includes('没有 pendingSummary()')), logs.join('|'))
})

test('readHandoffPendingSummary:pendingSummary() 抛错 / 返回值形态不符 ⇒ 退回读文件(不抛)', () => {
  const dir = mkdtempSync(join(scratch, 'throw-'))
  const file = join(dir, 'pending.json')
  writeFileSync(file, `${JSON.stringify(handoffMarker([{ sessionId: SESSION_ID }]))}\n`, 'utf8')
  const resolved = resolveConfig({ handoffPendingFile: file })

  const throwing = makeHandoffService({ throws: true })
  const logsA = []
  const fromThrow = readHandoffPendingSummary(makeCtx({ [HANDOFF_SERVICE]: throwing.service }).ctx, resolved, logsA.push.bind(logsA))
  assert.equal(fromThrow.source, 'file', '服务抛错也要退回文件')
  assert.equal(fromThrow.exists, true)
  assert.ok(logsA.some((line) => line.includes('pendingSummary() 抛错')), logsA.join('|'))

  for (const shape of [null, 'x', 42, { exists: true, items: 'nope' }]) {
    const { ctx } = makeCtx({ [HANDOFF_SERVICE]: makeHandoffService({ summary: shape }).service })
    const summary = readHandoffPendingSummary(ctx, resolved, () => {})
    assert.equal(summary.source, 'file', `返回值 ${JSON.stringify(shape)} 形态不符 ⇒ 退回文件`)
  }
})

test('summarizeHandoffItems / findUnhandledHandoffItem:摘要形状与"本会话未处理"判据', () => {
  const items = summarizeHandoffItems(handoffMarker([
    { sessionId: SESSION_ID, kind: 'subagent', parentSessionId: OTHER_ID, active: true, activeWhy: ['session'] },
    { sessionId: OTHER_ID, done: true },
  ]))
  assert.deepEqual(items[0], { sessionId: SESSION_ID, kind: 'subagent', done: false, active: true, wake: true })
  assert.equal(items[1].wake, false, 'done 的条目不会被唤醒')

  const summary = { exists: true, reason: '', items, source: 'file' }
  assert.equal(findUnhandledHandoffItem(summary, SESSION_ID).sessionId, SESSION_ID)
  assert.equal(findUnhandledHandoffItem(summary, OTHER_ID), undefined, 'done:true 不算"未处理"')
  assert.equal(findUnhandledHandoffItem(summary, 'session-none'), undefined)
  assert.equal(findUnhandledHandoffItem({ exists: false, items }, SESSION_ID), undefined, '标记不存在 ⇒ 没人接手')
  assert.equal(findUnhandledHandoffItem(undefined, SESSION_ID), undefined)
  // 空闲条目(active:false)照样算"有人接手" —— 它同样会被 dsh-host-sl 处理掉并归档
  const idle = { exists: true, items: summarizeHandoffItems(handoffMarker([{ sessionId: SESSION_ID, active: false }])) }
  assert.equal(findUnhandledHandoffItem(idle, SESSION_ID).active, false)
  assert.equal(idle.items[0].wake, false, '空闲条目不会被唤醒(但接手判据不看这个)')
})

// ── B. 让位判据(启动注入)───────────────────────────────────────────────────

test('启动注入:交接标记里有本会话的未处理条目 ⇒ 不注入 + 日志 + 排 10s 复查', async () => {
  const scene = await bootScene({
    note: '重启后先看 TODO',
    handoff: handoffMarker([{ sessionId: SESSION_ID, active: true, activeWhy: ['session'] }]),
  })
  assert.equal(scene.followups.length, 0, '有人接手时本插件一个字节都不许注入')
  assert.match(scene.log(), /交接记录将接手注入，本次不再单独注入「已重启」/)
  assert.match(scene.log(), new RegExp(`来源=file`))
  assert.equal(existsSync(scene.pendingFile), false, '决定已做出 ⇒ 本插件的重启标记算消费掉')
  assert.equal(scene.timers.length, 2, '启动注入 + 兜底复查各一个定时器')
  assert.equal(scene.timers[1].ms, DEFAULT_DEFER_RECHECK_MS, '复查延迟是常量 10s')
  assert.equal(DEFAULT_DEFER_RECHECK_MS, 10 * 1000)
})

test('启动注入:空闲条目(active:false)同样算"有人接手" ⇒ 不注入', async () => {
  const scene = await bootScene({ handoff: handoffMarker([{ sessionId: SESSION_ID, active: false, activeWhy: [] }]) })
  assert.equal(scene.followups.length, 0, '空闲条目也会被 dsh-host-sl 处理掉并归档 ⇒ 不该再插一条')
  assert.match(scene.log(), /交接记录将接手注入/)
})

test('启动注入:标记里只有别的会话 / 只有 done:true 的本会话条目 ⇒ 照旧自己注入', async () => {
  const other = await bootScene({ handoff: handoffMarker([{ sessionId: OTHER_ID }]) })
  assert.equal(other.followups.length, 1)
  assert.ok(other.injected().startsWith('已重启。'), other.injected())
  assert.match(other.log(), /交接记录不会接手本次注入/)
  assert.match(other.log(), new RegExp(`待续标记里没有本会话 ${SESSION_ID} 的未处理条目`))

  const done = await bootScene({ handoff: handoffMarker([{ sessionId: SESSION_ID, done: true }]) })
  assert.equal(done.followups.length, 1, 'done:true = 已经注入过 ⇒ 不算"未处理"')
  assert.match(done.log(), /交接记录不会接手本次注入/)
})

test('启动注入:标记读不到(服务缺席 + 文件不存在)⇒ 照旧注入,日志写清原因', async () => {
  const scene = await bootScene({})
  assert.equal(scene.followups.length, 1)
  assert.match(scene.log(), /交接记录不会接手本次注入\(没有可用的待续标记/)
  assert.equal(scene.timers.length, 1, '没人接手时不排复查定时器')
})

test('启动注入:标记形态坏 / JSON 损坏 ⇒ 照旧注入(不抛)', async () => {
  for (const body of ['{ not json', '[]', `${JSON.stringify({ version: 2, createdAt: Date.now(), items: [{ file: 'x' }] })}`]) {
    const scene = await bootScene({ handoff: body })
    assert.equal(scene.followups.length, 1, `形态坏(${body})必须照旧注入`)
    assert.match(scene.log(), /交接记录不会接手本次注入/)
  }
})

test('启动注入:pendingSummary() 在场时优先于读文件(服务说没有 ⇒ 照旧注入)', async () => {
  const scene = await bootScene({
    handoff: handoffMarker([{ sessionId: SESSION_ID }]), // 文件里"有"
    summary: { exists: false, reason: '没有待续标记（不存在或读不出）', items: [] }, // 服务说"没有"
  })
  assert.equal(scene.followups.length, 1, '以服务为准:它说没有待续标记 ⇒ 照旧自己注入')
  assert.match(scene.log(), /没有待续标记/)
})

test('启动注入:服务在场且摘要含本会话 ⇒ 让位(来源=service)', async () => {
  const scene = await bootScene({
    summary: {
      exists: true,
      reason: '',
      items: [{ sessionId: SESSION_ID, kind: 'root', done: false, active: true, wake: true }],
    },
  })
  assert.equal(scene.followups.length, 0)
  assert.match(scene.log(), /来源=service/)
})

test('启动注入:恢复会话失败 ⇒ 照旧归档标记、不排复查(与 v0.4.1 同一条路径)', async () => {
  const scene = await bootScene({ resolveFails: true, handoff: handoffMarker([{ sessionId: SESSION_ID }]) })
  assert.equal(scene.followups.length, 0)
  assert.equal(scene.timers.length, 1, 'resolveAgent 失败时不排复查')
  assert.match(scene.log(), /标记已归档,本次不注入/)
})

// ── C. 兜底(复查)──────────────────────────────────────────────────────────

test('兜底:复查时标记里仍有本会话条目且会话非 running ⇒ 补注入一次(buildInjectText 那条消息)', async () => {
  const scene = await bootScene({
    note: '重启后先看 TODO',
    handoff: handoffMarker([{ sessionId: SESSION_ID, active: true }]),
    status: 'idle',
  })
  assert.equal(scene.followups.length, 0, '第一轮让位')
  await scene.runTimer(1)
  assert.equal(scene.followups.length, 1, '交接记录没接手 ⇒ 自己补一条')
  assert.equal(scene.injected(), buildInjectText('重启后先看 TODO'), '补注入的正文与"照旧注入"逐字相同')
  assert.match(scene.log(), /交接记录没接手\(复查时标记里仍有本会话的未处理条目,且 status=idle 不是 running\),自己兜底注入「已重启」/)
})

test('兜底:复查时标记里已没有本会话条目(dsh-host-sl 接手了)⇒ 什么都不做', async () => {
  const scene = await bootScene({ handoff: handoffMarker([{ sessionId: SESSION_ID }]) })
  // 模拟 dsh-host-sl 处理完:条目被移除(或整份归档)
  writeFileSync(scene.handoffPendingFile, `${JSON.stringify(handoffMarker([{ sessionId: OTHER_ID }]))}\n`, 'utf8')
  await scene.runTimer(1)
  assert.equal(scene.followups.length, 0)
  assert.match(scene.log(), /待续标记里已没有本会话 .* 的未处理条目\(dsh-host-sl 已接手\),兜底注入跳过/)
})

test('兜底:复查时会话已在 running ⇒ 不补注入(别插话)', async () => {
  const scene = await bootScene({ handoff: handoffMarker([{ sessionId: SESSION_ID }]), status: 'running' })
  await scene.runTimer(1)
  assert.equal(scene.followups.length, 0)
  assert.match(scene.log(), /但本会话已在 running ⇒ 兜底注入跳过/)
})

test('兜底:复查时标记整个没了 / 形态坏 ⇒ 不补注入(按"对方已处理"处理,不抛)', async () => {
  for (const body of [undefined, '{ not json']) {
    const scene = await bootScene({ handoff: handoffMarker([{ sessionId: SESSION_ID }]) })
    if (body === undefined) rmSync(scene.handoffPendingFile)
    else writeFileSync(scene.handoffPendingFile, body, 'utf8')
    await scene.runTimer(1)
    assert.equal(scene.followups.length, 0)
  }
})

test('兜底:followup 抛错只写日志,绝不抛(注入失败不拖垮宿主)', async () => {
  const scene = await bootScene({ handoff: handoffMarker([{ sessionId: SESSION_ID }]), followupThrows: true })
  await assert.doesNotReject(() => scene.runTimer(1))
  assert.equal(scene.followups.length, 0)
  assert.match(scene.log(), /自己兜底注入失败/)
})

test('兜底:插件已卸载 ⇒ 复查直接跳过(不注入、不留副作用)', async () => {
  const scene = await bootScene({ handoff: handoffMarker([{ sessionId: SESSION_ID }]) })
  scene.dispose() // 模拟 cordis 的 fiber 卸载:跑 ctx.effect 登记的清理
  const result = await runHandoffFallback(scene.ctx, resolveConfig({ handoffPendingFile: scene.handoffPendingFile }), () => {}, () => true, SESSION_ID, scene.text, scene.agent)
  assert.equal(result.injected, false)
  assert.match(result.reason, /插件已卸载/)
  assert.equal(scene.followups.length, 0)
})

// ── D. 复查定时器的卸载回收 ────────────────────────────────────────────────

test('兜底定时器由 ctx.effect 登记:插件卸载时被回收,之后到期也不会注入', async () => {
  const scene = await bootScene({ handoff: handoffMarker([{ sessionId: SESSION_ID }]) })
  assert.equal(scene.timers.length, 2)
  assert.equal(scene.timers[1].canceled, false, '排出来的复查定时器一开始是活的')
  scene.dispose()
  assert.equal(scene.timers[1].canceled, true, '卸载清理必须真的取消复查定时器(ctx.effect,不是 ctx.on("dispose"))')
  await scene.runTimer(1)
  assert.equal(scene.followups.length, 0, '已回收的定时器不该再注入')
})

test('代码里不再用 ctx.on("dispose") 登记清理(2026-09-29 起是硬事实,不是"只对新代码"的约定)', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'lib', 'index.js'), 'utf8')
  assert.match(source, /ctx\.effect\(\(\) => \(\) => \{/, '清理必须走 ctx.effect')
  // 去掉注释后的正文:文件头与 apply 里的注释都在解释"为什么不用 ctx.on('dispose')",别把它们数进来
  const code = source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
    })
    .join('\n')
  // v0.4.2 那处历史写法已修:它挂在**不存在的事件**上,从来没触发过 ⇒ 正文里一处都不许再有
  const occurrences = code.split("ctx.on('dispose'").length - 1
  assert.equal(occurrences, 0, `ctx.on('dispose') 一处都不许有(本机 cordis 没有 dispose 事件),实际 ${occurrences} 处`)
  // 清理只许有一处登记:原先"只处理 disposed/cancelRecheck"的那段 effect 必须已经合并进来
  assert.equal(code.split('ctx.effect(').length - 1, 1, 'ctx.effect 只许有一处登记(不留重复登记)')
})

// ── 配置 ───────────────────────────────────────────────────────────────────

test('resolveConfig:handoffPendingFile 默认与 dsh-host-sl 的落点一致,deferRecheckMs 默认 10s', () => {
  const resolved = resolveConfig(undefined)
  assert.ok(resolved.handoffPendingFile.endsWith(join('storages', HANDOFF_STORAGE_DIRNAME, HANDOFF_PENDING_FILENAME)), resolved.handoffPendingFile)
  assert.equal(resolved.deferRecheckMs, DEFAULT_DEFER_RECHECK_MS)
  assert.equal(resolveConfig({ home: 'D:\\dsh-home' }).handoffPendingFile, join('D:\\dsh-home', 'storages', 'sl-handoff', 'pending.json'))
  assert.equal(resolveConfig({ deferRecheckMs: 0 }).deferRecheckMs, 0)
  assert.throws(() => resolveConfig({ deferRecheckMs: -1 }), /deferRecheckMs/)
  assert.throws(() => resolveConfig({ deferRecheckMs: 1.5 }), /deferRecheckMs/)
})
