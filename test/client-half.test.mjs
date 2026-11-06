/**
 * v0.10.0 浏览器半身测试:空会话 /restart 的空结果命令卡必须被摘掉,其它卡不动。
 *
 * 客户端文件是浏览器 bundle(window.__ModuleLoader__.load + factory),不是 ESM。
 * 这里用 node:vm + 最小 DOM 桩把它跑起来,只验证纯判定与摘卡动作;真实 React/CSS
 * 结构由 dsh-client-ui-chat 决定,静态用例钉住选择器与包声明。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')
const hostPath = join(here, '..', 'lib', 'index.js')
const pkgPath = join(here, '..', 'package.json')

const clientCode = readFileSync(clientPath, 'utf8')
const hostCode = readFileSync(hostPath, 'utf8')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

/** 一张 dsh-client-ui-chat 通用命令卡的 DOM 读面。 */
function card(state, text) {
  return {
    getAttribute: (name) => (name === 'data-state' ? state : null),
    textContent: text,
  }
}

/** 一个聊天流节点(flow item)的 DOM 读面。 */
function row(commandCard, kind = 'command') {
  const attrs = { 'data-chat-flow-kind': kind }
  return {
    hidden: false,
    getAttribute: (name) => attrs[name] ?? null,
    setAttribute: (name, value) => { attrs[name] = value },
    querySelector: (selector) => (selector === '[data-variant="others"]' ? commandCard : null),
  }
}

/** 跑一次浏览器 bundle,返回它的导出与假 DOM 现场。 */
function loadClient(rows) {
  const loaded = []
  const observed = []
  let effect = null
  const styleEl = {
    id: '',
    textContent: '',
    isConnected: false,
    remove() { this.isConnected = false },
  }
  const document = {
    head: { appendChild(el) { el.isConnected = true } },
    body: {},
    documentElement: {},
    getElementById: () => null,
    createElement: () => styleEl,
    querySelectorAll: () => rows,
  }
  class FakeObserver {
    constructor(callback) { this.callback = callback }
    observe(target, options) { observed.push({ target, options, observer: this }) }
    disconnect() { this.disconnected = true }
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => loaded.push(entry) } },
    document,
    MutationObserver: FakeObserver,
    requestAnimationFrame: (flush) => flush(),
    setTimeout,
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(clientCode, sandbox)
  assert.equal(loaded.length, 1, 'bundle 必须注册且只注册一个模块')
  const entry = loaded[0]
  const exported = entry.factory(() => { throw new Error('bundle 不应同步 require 其它模块') })
  const ctx = {
    effect: (callback, label) => {
      assert.equal(label, 'restart: hide silent command card')
      effect = callback()
    },
  }
  return { exported, ctx, rows, observed, get effect() { return effect }, styleEl, document }
}

test('包声明:双半身入口 + web 客户端清单', () => {
  assert.equal(pkg.version, '0.10.0')
  assert.equal(pkg.exports['./client'].default, './lib/client.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual(pkg.dsh.client.inject, [])
  assert.ok(pkg.files.includes('lib'), 'files 要覆盖 lib/client.js')
})

test('哨兵:宿主与浏览器半身使用同一个零宽空格', () => {
  assert.ok(hostCode.includes("export const SILENT_COMMAND_TEXT = '\\u200B'"))
  assert.ok(clientCode.includes('var SILENT_MARK = "\\u200B"'))
  assert.ok(clientCode.includes('id: "dsh-host-restart"'))
  assert.ok(clientCode.includes('data-chat-flow-kind="command"'))
  assert.ok(clientCode.includes('data-variant="others"'))
})

test('判定:只有已结算且正文含哨兵的命令卡才算空结果', () => {
  const { exported } = loadClient([])
  const isSilent = exported.__test.isSilentRestartCard
  assert.equal(isSilent(card('ok', 'restart\u200B')), true)
  assert.equal(isSilent(card('ok', '指令\u200B')), true, '分页只加载 command/done 时标题会退化,仍要命中')
  assert.equal(isSilent(card('ok', 'restart重启已发起:驱动脚本…')), false, '非空会话的卡要保留')
  assert.equal(isSilent(card('ok', 'feedback\u200B')), false, '别的命令卡即使带零宽字符也不碰')
  assert.equal(isSilent(card('running', 'restart执行中…')), false, '运行中不摘')
  assert.equal(isSilent(card('error', 'restart失败\u200B')), false, '失败卡要保留')
  assert.equal(isSilent(null), false)
  assert.equal(isSilent({ textContent: 'restart\u200B' }), false, '没有 data-state 的节点不碰')
})

test('摘卡:只隐藏带哨兵的命令流节点,并观察后续增量', () => {
  const silent = row(card('ok', 'restart\u200B'))
  const spoken = row(card('ok', 'restart重启已发起:驱动脚本…'))
  const failed = row(card('error', 'restart失败'))
  const otherKind = row(card('ok', 'restart\u200B'), 'manual-compaction')
  const scene = loadClient([silent, spoken, failed, otherKind])
  assert.equal(typeof scene.exported.apply, 'function')
  assert.equal(scene.exported.inject.length, 0)
  scene.exported.apply(scene.ctx)

  assert.equal(silent.getAttribute('data-dsh-restart-silent'), '')
  assert.equal(silent.hidden, true)
  assert.equal(spoken.hidden, false)
  assert.equal(failed.hidden, false)
  assert.equal(otherKind.hidden, false, '只动 command 流节点')
  assert.equal(scene.observed.length, 1)
  assert.equal(scene.observed[0].options.subtree, true)
  assert.ok(scene.styleEl.textContent.includes('display:none'))

  assert.equal(typeof scene.effect, 'function', '卸载清理必须登记')
  scene.effect()
  assert.equal(scene.observed[0].observer.disconnected, true, '卸载时必须断开观察器')
})
