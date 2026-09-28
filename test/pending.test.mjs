/**
 * dsh-host-restart 纯函数单测:钉住"标记判定 / 注入文案 / 启动命令行 / 配置校验"的预期。
 * 不碰真实 profile、不启动任何进程、不写真实标记(只用临时目录之外的纯计算)。
 *
 * 跑法:node --test "test/*.test.mjs"(或 npm test)
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  DEFAULT_INJECT_TEXT,
  WAIT_SECONDS,
  archiveFileName,
  buildInjectText,
  buildLauncherCommandLine,
  buildWmiCreateCommand,
  classifyPending,
  resolveConfig,
} from '../lib/index.js'

const NOW = 1_800_000_000_000

test('archiveFileName:时间戳不带分隔符,不会出现 "..json" 这类名字', () => {
  const name = archiveFileName('C:\\x\\pending.json', 'stale', new Date('2026-09-16T21:55:14.293Z'))
  assert.equal(name, 'C:\\x\\pending.stale-20260916215514.json')
  assert.ok(!name.includes('..'), '归档名里不该出现连续的点')
  assert.equal(
    archiveFileName('C:\\tmp\\pending.json', 'failed', new Date('2026-01-02T03:04:05.000Z')),
    'C:\\tmp\\pending.failed-20260102030405.json',
  )
})

test('classifyPending:fresh / stale / invalid 三分支', () => {
  const fresh = { sessionId: 'session-abc', text: '已重启。', createdAt: NOW - 5_000 }
  assert.equal(classifyPending(fresh, NOW, 600_000), 'fresh')
  assert.equal(classifyPending({ ...fresh, createdAt: NOW - 600_001 }, NOW, 600_000), 'stale')
  // 结构损坏
  assert.equal(classifyPending(undefined, NOW, 600_000), 'invalid')
  assert.equal(classifyPending(null, NOW, 600_000), 'invalid')
  assert.equal(classifyPending([], NOW, 600_000), 'invalid')
  assert.equal(classifyPending({ ...fresh, sessionId: '' }, NOW, 600_000), 'invalid')
  assert.equal(classifyPending({ ...fresh, text: '' }, NOW, 600_000), 'invalid')
  assert.equal(classifyPending({ ...fresh, createdAt: 'x' }, NOW, 600_000), 'invalid')
  // 时间戳明显在未来(时钟异常)也算损坏,不能拿它当"永不过期"
  assert.equal(classifyPending({ ...fresh, createdAt: NOW + 120_000 }, NOW, 600_000), 'invalid')
  // 轻微超前(同机时钟抖动)仍视为新鲜
  assert.equal(classifyPending({ ...fresh, createdAt: NOW + 30_000 }, NOW, 600_000), 'fresh')
})

test('buildInjectText:默认文案带续跑引导,note 追加在末尾', () => {
  assert.equal(buildInjectText(undefined), DEFAULT_INJECT_TEXT)
  assert.equal(buildInjectText('   '), DEFAULT_INJECT_TEXT)
  assert.ok(DEFAULT_INJECT_TEXT.startsWith('已重启。'))
  assert.ok(DEFAULT_INJECT_TEXT.includes('请继续重启前未完成的工作'))

  const withNote = buildInjectText('  顺便确认新插件已加载  ')
  assert.ok(withNote.startsWith(DEFAULT_INJECT_TEXT))
  assert.ok(withNote.endsWith('补充说明:顺便确认新插件已加载'))
})

test('WAIT_SECONDS:等待是常量,配置项 waitSeconds 已失效(配了也按常量走)', () => {
  assert.equal(WAIT_SECONDS, 2, '等待固定 2s —— 准入判据是调用瞬间的快照,等待越久窗口越宽')
  assert.equal(resolveConfig(undefined).waitSeconds, WAIT_SECONDS)
  assert.equal(resolveConfig({ waitSeconds: 60 }).waitSeconds, WAIT_SECONDS, '配置里写大值不再生效')
  assert.doesNotThrow(() => resolveConfig({ waitSeconds: 0 }), '它已不是配置项,不该再因它抛错')
})

test('resolveConfig:默认落点与非法配置 fail loud', () => {
  const resolved = resolveConfig(undefined)
  assert.ok(resolved.pendingFile.endsWith('storages\\dsh-restart\\pending.json') || resolved.pendingFile.endsWith('storages/dsh-restart/pending.json'))
  assert.equal(resolved.restartScript, 'C:\\run\\tools\\dsh-restart.ps1')
  assert.equal(resolved.logFile, 'C:\\run\\tools\\dsh-restart.log')
  assert.equal(resolved.psExe, 'pwsh')
  // 启动原语默认必须是"真实那个":桩只能由测试显式传入,resolveConfig 绝不提供默认桩
  // (2026-09-21 事故:restartScript/psExe/启动层都没被覆盖,放行用例真的去起了进程)
  assert.equal(resolved.wmiExec, undefined)

  const custom = resolveConfig({ home: 'D:\\dsh-home', psExe: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' })
  assert.equal(custom.pendingFile, 'D:\\dsh-home\\storages\\dsh-restart\\pending.json')

  assert.throws(() => resolveConfig({ staleMs: 0 }), /staleMs/)
  assert.throws(() => resolveConfig({ bootDelayMs: -1 }), /bootDelayMs/)
  assert.throws(() => resolveConfig({ controllerWaitMs: 3.5 }), /controllerWaitMs/)
  assert.throws(() => resolveConfig({ wmiExec: 'not-a-function' }), /wmiExec/)
})

test('buildLauncherCommandLine:headless 首选通道用 conhost --headless 包裹', () => {
  const line = buildLauncherCommandLine({
    psExe: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    mode: 'headless',
    scriptPath: 'C:\\run\\tools\\dsh-restart.ps1',
    sessionId: 'session-11111111-2222-3333-4444-555555555555',
    waitSeconds: WAIT_SECONDS,
  })
  assert.ok(line.startsWith('conhost.exe --headless "C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -NonInteractive'))
  assert.ok(line.includes('-ExecutionPolicy Bypass -File "C:\\run\\tools\\dsh-restart.ps1"'))
  assert.ok(line.includes('-SessionId "session-11111111-2222-3333-4444-555555555555"'))
  assert.ok(line.endsWith(`-WaitSeconds ${WAIT_SECONDS}`))
})

test('buildLauncherCommandLine:hidden 回退通道不依赖 conhost', () => {
  const line = buildLauncherCommandLine({
    psExe: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    mode: 'hidden',
    scriptPath: 'C:\\run\\tools\\dsh-restart.ps1',
    sessionId: 'session-11111111-2222-3333-4444-555555555555',
    waitSeconds: WAIT_SECONDS,
  })
  assert.ok(line.startsWith('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass'))
  assert.ok(line.endsWith(`-WaitSeconds ${WAIT_SECONDS}`))
  assert.ok(!line.includes('conhost'))
})

test('buildWmiCreateCommand:命令行作为单引号字面量,内部单引号被翻倍', () => {
  const command = buildWmiCreateCommand('pwsh -File "C:\\run\\tools\\o\'brien.ps1" -SessionId "s-1"')
  assert.ok(command.includes("$ErrorActionPreference = 'Stop'"))
  assert.ok(command.includes("o''brien.ps1"))
  assert.ok(command.includes('Win32_Process'))
  assert.ok(command.includes('$result.ProcessId'))
  // 未转义的单引号会提前闭合字面量 ⇒ 断言所有单引号都成对
  const literals = command.match(/'[^']*'/g) ?? []
  assert.ok(literals.length >= 3)
})
