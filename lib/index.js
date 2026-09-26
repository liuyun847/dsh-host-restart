/**
 * dsh-host-restart v0.1.0
 *
 * 给 DSH web 宿主加一个"重启自己并把会话续上"的模型工具 restart_dsh:
 *
 *   1) 模型调用工具 → 本插件把「重启后要注入的文本 + 调用方会话 id」写进标记文件,
 *      再用 WMI(Win32_Process.Create)启动一个**完全脱离 dsh 进程树**的 pwsh 驱动脚本,
 *      随即返回(要求模型立刻结束本轮);
 *   2) 驱动脚本(C:\run\tools\dsh-restart.ps1)等本轮输出落盘 → 杀掉当前 dsh →
 *      等常驻看门狗回门户监听 → 触发看门狗拉起新 dsh → 轮询直到新进程就绪;
 *   3) 新 dsh 启动时本插件读标记 → 用官方 API 恢复该会话(resume + 按其记录的
 *      agentPreset 重新挂载)→ 注入一条「已重启」用户消息 → 会话在新进程里继续跑。
 *
 * 为什么必须用 WMI 启动驱动脚本(dsh-host-restart 的存活前提):
 *   dsh 的 pwsh 工具走 dsh-subprocess-local,Windows 上 detached:false 且带 taskkill
 *   树级清理 ⇒ 普通子进程/孙子进程无法保证在 dsh 被杀后继续运行。Win32_Process.Create
 *   创建的进程父级是 WmiPrvSE.exe,与 dsh 进程树无关。
 *
 * 启动通道(均在本机实测,判据 = "WMI Create 后子进程能否写出文件"):
 *   · conhost.exe --headless "pwsh.exe" …  ✅ 0.4s 起效、无窗口 —— 首选通道;
 *   · "pwsh.exe" -WindowStyle Hidden …      ✅ 4.5s 起效、无窗口 —— 回退通道(不依赖 conhost);
 *   · wscript / mshta / cscript 中转        ❌ 不执行 —— WMI 创建的进程没有可用的交互式
 *     window station,GUI 子系统宿主起不来(看门狗那套 wscript 拉 node 只在登录会话里成立);
 *   · Start-Process / 普通 spawn            ❌ 仍在 dsh 进程树内,会被一起清理。
 *   另注:-WindowStyle Hidden 只是**冷启动慢**(约 4.5s),不是失败 —— 确认窗口短于 5s 会误判。
 *
 * 依赖的宿主 API(均已在运行中的 web profile 上确认存在):
 *   - ctx.tools.register(defineTool({...})) 注册工具;execute(args, exec) 的 exec.agent
 *     携带调用方会话(exec.agent.session.id / .header.origin)。
 *   - ctx.get('sessionController').resolveAgent(sessionId):恢复(必要时 resume)一个普通
 *     会话,内部会读持久化 projection 里的 agentPreset 并重新挂载;返回 {agent} 或 {error}。
 *   - agent.followup(createUserMessage({content, source})):把一条用户消息排进新一轮。
 *
 * 边界:只对主会话开放(子代理会话 origin==='subagent' 直接拒绝);另有**顶层会话正在运行**
 *   时也拒绝(硬杀进程会连带灭掉它们的当前轮,且新进程只复活发起者那一个会话);
 *   标记文件成功注入即删,陈旧/损坏/失败一律改名归档为 pending.<原因>-<时间>.json,绝不无限重试。
 *
 * ⚠ 改动须知(2026-09-17 事故后补,踩过就别再踩):
 *   · profile 的 file: 依赖在 pnpm 下是**实体拷贝**,不是 junction —— 真正被加载的是
 *     node_modules\dsh-host-restart\lib\index.js,改 plugins\ 下的源码**不会生效**。
 *     改完必须重装同步,再重启 dsh(loader 按 URL 缓存已 import 的模块):
 *       node <工作区>\dsh-plugin-manager\dshpm.mjs add \
 *         file:C:\Users\MLTZ\.dsh\profiles\web\plugins\dsh-host-restart --profile web
 *     两份已经漂移过一次:5:54 只补了 node_modules 那份的 timer 声明,plugins 那份没有,
 *     于是工具注册持续失败而没人发现。
 *   · 访问未在 inject 里声明的服务属性会抛错,而 apply 抛错 = **整个 dsh 起不来**。
 *     test/inject-coverage.test.mjs 会静态扫描本文件的 ctx.<service> 访问并断言已声明。
 *   · **放行路径会真的起进程**(WMI Create → 真驱动脚本 → 杀掉 dsh 与其它会话)。测试/验证脚本
 *     必须把启动原语换掉(2026-09-21 事故:session-gate 测试没覆盖 restartScript/psExe,
 *     五个"应当放行"的用例真的跑通了整条链路,6~7 秒后掐掉宿主和另外两个会话):
 *       a) apply 的 config 传 `wmiExec` 桩 —— 它是唯一会 spawn 的那一步(见 realExecFile);
 *       b) restartScript / psExe 指向不存在的临时路径 —— 桩被摘掉时只剩 ENOENT;
 *       c) 测试进程设 `DSH_RESTART_NO_LAUNCH=1` —— 结构性熔断,真实 execFile 被直接拒绝。
 *     另外:断言必须落在"启动原语被调用了几次/命令行是什么",不能只看结果文案或自备日志文件 ——
 *     当时的假阴性正是"断言等的是测试自己的 logFile,而真驱动写的是 C:\run\tools\dsh-restart.log"。
 *   · **杀谁**(2026-09-21 试跑发现的地雷):profile 名是 dsh 的**位置参数**(`dsh web …` 等价
 *     `dsh --profile web`,见 dsh 的 lib/bin.js),而旧的杀进程判据是"命令行含 dsh\lib\bin\.js
 *     且含 ' web '" ⇒ 跨实例:从 teamlab 实例(`bin.js teamlab --port 3090`)发起重启会杀掉
 *     web 实例(3080),把自己留在原地。现在身份 = 插件宿主自己的 pid + profile + 端口
 *     (`resolveInstanceIdentity`,三者都取自本进程 argv),随启动命令行传给驱动脚本
 *     (`-DshPid/-ProfileName/-Port`),脚本正向校验后只杀命中的进程,确定不了就 fail closed。
 *     判据的 JS 镜像与用例见 test/instance-identity.test.mjs(正则必须与 ps1 逐条一致)。
 */
import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'restart-dsh'

/**
 * 依赖服务。
 *
 * ⚠ `timer` 必须声明:`ctx.timeout` 是 timer 服务的 mixin,而 cordis 对**未声明注入的服务属性
 *   访问一律抛错**。2026-09-17 事故:漏声明 ⇒ apply 抛错 ⇒ 插件树加载失败 ⇒ 新 dsh 在打印
 *   带 token 的启动行之前就退出,看门狗反复拉起反复崩,浏览器一直卡"启动中"。
 *
 * sessionController 故意不声明:它只是注入时机的可选依赖,用 ctx.get() 探测即可
 * (属性访问会抛错,ctx.get() 是安全的可选读取)。
 */
export const inject = ['tools', 'timer']

export const TOOL_NAME = 'restart_dsh'

/**
 * 会话检测:重启前要拦住的「其它正在运行的顶层会话」最多列几个 id(超出用"等 N 个"收尾)。
 * 3 个足够让人认出来是谁,再长就只是噪音。
 */
export const MAX_LISTED_SESSIONS = 3

/** 驱动脚本与日志:与看门狗同目录(用户既有的 C:\run\tools 归置)。 */
export const DEFAULT_RESTART_SCRIPT = 'C:\\run\\tools\\dsh-restart.ps1'
export const DEFAULT_LOG_FILE = 'C:\\run\\tools\\dsh-restart.log'

/**
 * 兜底日志路径。apply 抛错时 config 可能还没解析成功,只能用环境变量或默认值 ——
 * DSH_RESTART_LOG_FILE 主要给测试隔离用(生产不必设)。
 */
export function fallbackLogFile() {
  const fromEnv = process.env.DSH_RESTART_LOG_FILE
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : DEFAULT_LOG_FILE
}

export const DEFAULT_WAIT_SECONDS = 6
export const MIN_WAIT_SECONDS = 2
export const MAX_WAIT_SECONDS = 60

/** 新 dsh 起来后等多久再注入:避开宿主启动风暴,等 session 持久化/查询栈就位。 */
export const DEFAULT_BOOT_DELAY_MS = 4000
/** 超过这个年龄的标记视为陈旧(例如上次重启失败后遗留),归档不注入。 */
export const DEFAULT_STALE_MS = 10 * 60 * 1000
/** 等 sessionController 出现的上限。 */
export const DEFAULT_CONTROLLER_WAIT_MS = 30000
/** 启动驱动脚本的单次 pwsh 调用上限(WMI Create 本身瞬时返回)。 */
export const LAUNCH_TIMEOUT_MS = 15000
/** 启动通道优先级:conhost --headless 最快,失败才回退 -WindowStyle Hidden。 */
export const LAUNCH_MODES = ['headless', 'hidden']
/** 启动确认窗口:驱动脚本首行日志(含本次 SessionId)出现即算真的跑起来了。 */
export const LAUNCH_CONFIRM_MS = 9000

/**
 * 注入到会话的默认正文。模型重启后需要知道"为什么上下文还在、接下来该干什么",
 * 只发两个字容易得到一句空确认,故带一句续跑引导。
 */
export const DEFAULT_INJECT_TEXT = [
  '已重启。',
  'dsh 后端已按你的调用重启完成(旧进程已终止,新进程已就绪),本会话历史完整保留。',
  '请继续重启前未完成的工作;若当时没有未完成的任务,向用户简述重启结果即可。',
].join('')

/** dsh 入口脚本 token:`node <...>\dsh\lib\bin.js <profile> …`(argv 层面按 token 精确匹配)。 */
const DSH_ENTRY_TOKEN = /dsh[\\/]lib[\\/]bin\.js$/i

/**
 * 命令行层面的"这是一条 dsh 宿主进程"判据:node 可执行文件**后面紧跟** dsh 入口脚本。
 *
 * 为什么不能只写"命令行里出现 dsh\lib\bin\.js":dsh 的子进程(dsh-subprocess-local 的
 * runner.js)会把整条 PowerShell 命令文本带进自己的命令行,只要那段文本提到过入口路径,
 * 就会被误判成 dsh 宿主(2026-09-18 看门狗那侧已实测踩过,这里用同一条写法规避)。
 * 驱动脚本 Test-DshInstanceCommandLine 里的正则与本常量逐字对应。
 */
export const DSH_HOST_COMMAND_LINE = /node(\.exe)?"?\s+"?[^"\s]*dsh[\\/]lib[\\/]bin\.js/

/** 带值的 dsh 选项:解析位置参数时要把它们的值一起跳过,否则 --patch 的路径会被当成 profile。 */
const VALUE_OPTIONS = new Set(['--profile', '--patch', '--from-default-profile', '--port'])

/** profile 名必须是安全的目录名:既挡注入,也保证能原样塞进命令行与正则。 */
const SAFE_PROFILE_NAME = /^[A-Za-z0-9._-]{1,64}$/

/** 取 `--name value` / `--name=value` 的值;没给返回 undefined。 */
function readOptionValue(args, name) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === name) return args[index + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

/** 位置参数形态的 profile:`dsh web …`(bin.js 把首个非选项 token 展开成 --profile <name>)。 */
function readPositionalProfile(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg.startsWith('-')) {
      // 带值选项连它的值一起跳过(--patch ./x.yml 的路径不是 profile)
      if (!arg.includes('=') && VALUE_OPTIONS.has(arg)) index += 1
      continue
    }
    return arg === 'plugin' ? undefined : arg // `dsh plugin …` 不是 boot,没有 profile
  }
  return undefined
}

/**
 * 本实例身份:宿主进程 pid + profile 名 + 端口 —— 重启只允许杀命中这三者的 dsh 进程。
 *
 * 为什么是这三样:都能**唯一区分多 profile/多实例**,而且都取自本进程自己的 argv ⇒
 * 目标进程的命令行里必然带同样的 token,驱动脚本正向校验不会假阴性。
 *   · pid = process.pid(2026-09-21 实测:插件日志的 dshPid 与驱动脚本观测到的 dsh pid 相同);
 *   · profile = `dsh web …` 的位置参数或显式 `--profile web`(位置参数优先);
 *   · port = `--port 3080` / `--port=3080`。
 * 认不出来的一律返回 undefined(不猜):脚本侧对"身份不全"是 fail closed。
 */
export function resolveInstanceIdentity(argv = process.argv, pid = process.pid) {
  const args = Array.isArray(argv) ? argv.map((value) => String(value)) : []
  // 只认 dsh 入口脚本之后的 token:node 可执行文件与入口路径本身不是 dsh 的参数
  const entryIndex = args.findIndex((value) => DSH_ENTRY_TOKEN.test(value))
  const tail = entryIndex >= 0 ? args.slice(entryIndex + 1) : args
  const profile = readOptionValue(tail, '--profile') ?? readPositionalProfile(tail)
  const portRaw = readOptionValue(tail, '--port')
  const port = typeof portRaw === 'string' && /^\d{1,5}$/.test(portRaw) ? Number.parseInt(portRaw, 10) : undefined
  return {
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : undefined,
    profile: typeof profile === 'string' && SAFE_PROFILE_NAME.test(profile) ? profile : undefined,
    port: port !== undefined && port >= 1 && port <= 65535 ? port : undefined,
  }
}

/** 命令行里是否含某个 token(按词边界,避免 dsh-web-app 这类路径被 profile=web 命中)。 */
function hasToken(commandLine, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_.-])`).test(commandLine)
}

/**
 * 「这条命令行是不是本实例的 dsh」—— 驱动脚本里 Test-DshInstanceCommandLine 的 JS 镜像,
 * 两边规则必须一致(本函数的用例就是那边判据的行为锁)。
 * 只校验**给到的**字段:profile/port 为 undefined 时它们不作为判据(身份不全时不假装认识)。
 */
export function matchesInstanceCommandLine(commandLine, identity = {}) {
  const line = typeof commandLine === 'string' ? commandLine : ''
  if (!DSH_HOST_COMMAND_LINE.test(line)) return false
  if (identity.profile !== undefined && !hasToken(line, identity.profile)) return false
  if (identity.port !== undefined && !new RegExp(`--port[\\s=]+${identity.port}(?!\\d)`).test(line)) return false
  return true
}

/** 校验并规范化配置;非法配置直接抛错(fail loud,与同 profile 的 compliance-check 一致)。 */
export function resolveConfig(config) {
  const cfg = config ?? {}
  const home = typeof cfg.home === 'string' && cfg.home.length > 0
    ? cfg.home
    : (process.env.DSH_HOME || join(homedir(), '.dsh'))
  const pendingDir = typeof cfg.pendingDir === 'string' && cfg.pendingDir.length > 0
    ? cfg.pendingDir
    : join(home, 'storages', 'dsh-restart')
  const restartScript = typeof cfg.restartScript === 'string' && cfg.restartScript.length > 0
    ? cfg.restartScript
    : DEFAULT_RESTART_SCRIPT
  const logFile = typeof cfg.logFile === 'string' && cfg.logFile.length > 0
    ? cfg.logFile
    : fallbackLogFile()
  const psExe = typeof cfg.psExe === 'string' && cfg.psExe.length > 0 ? cfg.psExe : 'pwsh'
  // 测试注入点:替换掉唯一会 spawn 进程的启动原语(见 realExecFile)。生产配置永远不设它,
  // 于是 resolveConfig({}).wmiExec === undefined ⇒ 走真实 execFile。
  const wmiExec = cfg.wmiExec
  if (wmiExec !== undefined && typeof wmiExec !== 'function') {
    throw new TypeError(`restart-dsh: wmiExec 必须是函数(仅供测试注入启动原语),收到 ${typeof wmiExec}`)
  }
  return {
    home,
    pendingDir,
    pendingFile: join(pendingDir, 'pending.json'),
    restartScript,
    logFile,
    psExe,
    wmiExec,
    waitSeconds: assertIntegerInRange('waitSeconds', cfg.waitSeconds ?? DEFAULT_WAIT_SECONDS, MIN_WAIT_SECONDS, MAX_WAIT_SECONDS),
    bootDelayMs: assertIntegerInRange('bootDelayMs', cfg.bootDelayMs ?? DEFAULT_BOOT_DELAY_MS, 0, 10 * 60 * 1000),
    staleMs: assertIntegerInRange('staleMs', cfg.staleMs ?? DEFAULT_STALE_MS, 1000, 24 * 60 * 60 * 1000),
    controllerWaitMs: assertIntegerInRange('controllerWaitMs', cfg.controllerWaitMs ?? DEFAULT_CONTROLLER_WAIT_MS, 0, 5 * 60 * 1000),
  }
}

/** 整数范围校验:非整数/越界都抛,避免把坏配置带进重启流程。 */
function assertIntegerInRange(field, value, min, max) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`restart-dsh: ${field} 必须是 ${min}~${max} 的整数,收到 ${JSON.stringify(value)}`)
  }
  return value
}

/** 组装注入正文:默认文案 + 可选补充说明。 */
export function buildInjectText(note) {
  const extra = typeof note === 'string' ? note.trim() : ''
  if (extra.length === 0) return DEFAULT_INJECT_TEXT
  return `${DEFAULT_INJECT_TEXT}\n\n补充说明:${extra}`
}

/** 工具参数 wait_seconds 的规范化(越界夹紧而不是报错,工具层要 fail soft)。 */
export function resolveWaitSeconds(value) {
  if (value === undefined || value === null) return DEFAULT_WAIT_SECONDS
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return DEFAULT_WAIT_SECONDS
  return Math.min(MAX_WAIT_SECONDS, Math.max(MIN_WAIT_SECONDS, Math.round(parsed)))
}

/**
 * 判定一个重启标记该不该被消费。
 * @returns 'fresh' 可注入;'stale' 太旧;'invalid' 结构损坏或时间戳在未来。
 */
export function classifyPending(pending, now, staleMs) {
  if (pending === null || typeof pending !== 'object' || Array.isArray(pending)) return 'invalid'
  if (typeof pending.sessionId !== 'string' || pending.sessionId.length === 0) return 'invalid'
  if (typeof pending.text !== 'string' || pending.text.length === 0) return 'invalid'
  if (typeof pending.createdAt !== 'number' || !Number.isFinite(pending.createdAt)) return 'invalid'
  if (pending.createdAt - now > 60 * 1000) return 'invalid'
  if (now - pending.createdAt > staleMs) return 'stale'
  return 'fresh'
}

/**
 * WMI Create 用的完整命令行。程序路径可能含空格(如 C:\Program Files\PowerShell\7\pwsh.exe),
 * 必须整体加引号 —— CreateProcess 按第一个 token 解析可执行文件。
 * @param options.mode 'headless' = 用 conhost --headless 包裹(首选,无窗口且启动快);
 *   'hidden' = 直接带 -WindowStyle Hidden(回退,冷启动约 4.5s,同样无窗口)。
 * @param options.identity 本实例身份(见 resolveInstanceIdentity);缺字段就不传对应参数,
 *   脚本侧对"身份不全"会把判据收到剩下的字段上,全缺则 fail closed。
 */
export function buildLauncherCommandLine(options) {
  const psExe = options.psExe ?? 'pwsh'
  const identity = options.identity ?? {}
  let tail = `-ExecutionPolicy Bypass -File "${options.scriptPath}"`
    + ` -SessionId "${options.sessionId}" -WaitSeconds ${options.waitSeconds}`
  // 实例身份:驱动脚本据此确定"要杀哪一个 dsh"。缺了它脚本只能靠宽松匹配,会误杀别的 profile
  // (2026-09-21 试跑实测)。profile 名先过 SAFE_PROFILE_NAME 白名单,避免拼进命令行时被注入。
  if (Number.isSafeInteger(identity.pid) && identity.pid > 0) tail += ` -DshPid ${identity.pid}`
  if (typeof identity.profile === 'string' && SAFE_PROFILE_NAME.test(identity.profile)) {
    tail += ` -ProfileName "${identity.profile}"`
  }
  if (Number.isSafeInteger(identity.port) && identity.port >= 1 && identity.port <= 65535) {
    tail += ` -Port ${identity.port}`
  }
  // 重启标记路径:旧版插件(不传 -DshPid)启动脚本时,脚本靠它里面的 pidBefore 兜底认出宿主
  if (typeof options.pendingFile === 'string' && options.pendingFile.length > 0 && !options.pendingFile.includes('"')) {
    tail += ` -PendingFile "${options.pendingFile}"`
  }
  if (options.mode === 'hidden') {
    return `"${psExe}" -NoProfile -NonInteractive -WindowStyle Hidden ${tail}`
  }
  return `conhost.exe --headless "${psExe}" -NoProfile -NonInteractive ${tail}`
}

/**
 * 让 pwsh 通过 WMI 创建脱离进程树的驱动脚本,并回显新进程 pid。
 * 单引号字面量转义:PowerShell 里 '' 表示一个 '。
 */
export function buildWmiCreateCommand(commandLine) {
  const literal = `'${String(commandLine).replace(/'/g, "''")}'`
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$cmd = ${literal}`,
    `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }`,
    `if ($result.ReturnValue -ne 0) { throw ('Win32_Process.Create 失败,ReturnValue=' + $result.ReturnValue) }`,
    `$result.ProcessId`,
  ].join('\n')
}

/** ISO 时间戳 + 来源标签,追加一行日志;任何失败都静默(日志不能影响重启流程)。 */
function appendLog(logFile, source, message) {
  try {
    appendFileSync(logFile, `${new Date().toISOString()}  [${source}] ${message}\n`)
  } catch { /* 日志不可写时忽略 */ }
}

/** 原子性够用的标记写入:同目录先写临时文件再改名,避免新进程读到半个 JSON。 */
function writePendingFile(file, record) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/** 读标记;不存在或不是合法 JSON 都返回 undefined。 */
function readPendingFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 归档文件名:同目录 `pending.<原因>-<yyyyMMddHHmmss>.json`。
 * 时间戳去掉全部分隔符 —— 早期版本按 slice(0,15) 截 ISO 串会留下尾部的点,
 * 生成 `pending.stale-20260916215514..json` 这种双点名字(2026-09-17 实测踩到)。
 */
export function archiveFileName(file, reason, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:T.]/g, '').slice(0, 14)
  return join(dirname(file), `pending.${reason}-${stamp}.json`)
}

/** 把标记改名归档(消费失败/陈旧时留证据),改名失败则退化为删除。 */
function archivePendingFile(file, reason) {
  try {
    renameSync(file, archiveFileName(file, reason))
  } catch {
    try { unlinkSync(file) } catch { /* 已不存在 */ }
  }
}

/** 错误文本:RemoteError 也只是一条 message。 */
function errText(error) {
  if (error === undefined || error === null) return '未知错误'
  if (typeof error === 'string') return error
  const message = error.message ?? String(error)
  const stderr = typeof error.stderr === 'string' && error.stderr.trim().length > 0 ? ` stderr=${error.stderr.trim()}` : ''
  return `${message}${stderr}`
}

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stderr = typeof stderr === 'string' ? stderr : ''
        reject(error)
        return
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/** 日志文件当前大小(不存在算 0)。 */
function logFileSize(file) {
  try { return statSync(file).size } catch { return 0 }
}

/** 读日志自某偏移起的内容;偏移失效(轮转截断)时退化为读全文。 */
function readLogSince(file, offset) {
  try {
    const data = readFileSync(file)
    const from = offset > 0 && offset < data.length ? offset : 0
    return data.subarray(from).toString('utf8')
  } catch {
    return ''
  }
}

/**
 * 等驱动脚本写下首行日志(含本次 SessionId)——这才是"脚本真的跑起来了"的证据。
 * WMI Create 返回 0 只说明进程被创建,脚本解析/启动失败在 CreateProcess 层看不到。
 */
async function waitForLauncherConfirmation(logFile, offsetBefore, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const needle = `SessionId=${sessionId}`
  for (;;) {
    if (readLogSince(logFile, offsetBefore).includes(needle)) return true
    if (Date.now() >= deadline) return false
    await delay(250)
  }
}

/**
 * **唯一会创建进程的地方**:用 pwsh 执行一段 PowerShell 去 Invoke-CimMethod Win32_Process Create。
 *
 * 两道测试护栏都挂在这里(2026-09-21 事故的教训:测试意外跑通了真实启动链路,杀掉宿主):
 *   · `DSH_RESTART_NO_LAUNCH=1` ⇒ 直接拒绝,连 execFile 都不调用 —— 测试/验证进程一律设它;
 *   · `resolved.wmiExec`(测试注入的桩)⇒ 整段替换本函数,进程根本不会被创建。
 * 两者之外没有任何 spawn:测试只要命中任意一条,就不可能触到真实世界。
 */
function realExecFile(file, args, options) {
  if (process.env.DSH_RESTART_NO_LAUNCH === '1') {
    return Promise.reject(new Error('DSH_RESTART_NO_LAUNCH=1:本进程禁止真实启动驱动脚本(测试熔断)'))
  }
  return execFileAsync(file, args, options)
}

/**
 * 启动驱动脚本:按 LAUNCH_MODES 逐通道、每个通道先 pwsh 后 powershell.exe 尝试,
 * 每次都用"日志首行出现本次 SessionId"做启动确认。
 * @param instance 本实例身份(pid/profile/port),随命令行传给脚本决定"杀哪一个 dsh"。
 * @returns { pid, mode } 已确认启动的 WMI 侧 pid 与所用通道。
 */
async function launchDriver(resolved, sessionId, waitSeconds, log, instance) {
  const interpreters = resolved.psExe === 'powershell.exe' ? ['powershell.exe'] : [resolved.psExe, 'powershell.exe']
  // 启动原语:测试注入的桩优先(桩必须打在这一层 —— 这一层之下就是真实的 WMI Create)
  const execFileImpl = resolved.wmiExec ?? realExecFile
  const failures = []
  for (const mode of LAUNCH_MODES) {
    for (const psExe of interpreters) {
      const commandLine = buildLauncherCommandLine({
        psExe,
        mode,
        scriptPath: resolved.restartScript,
        sessionId,
        waitSeconds,
        identity: instance,
        pendingFile: resolved.pendingFile,
      })
      const offsetBefore = logFileSize(resolved.logFile)
      let pid
      try {
        const { stdout } = await execFileImpl(
          psExe,
          ['-NoProfile', '-NonInteractive', '-Command', buildWmiCreateCommand(commandLine)],
          { timeout: LAUNCH_TIMEOUT_MS, windowsHide: true },
        )
        const parsed = Number.parseInt(stdout.trim().split(/\r?\n/).pop() ?? '', 10)
        if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`未解析到驱动脚本 pid,stdout=${JSON.stringify(stdout)}`)
        pid = parsed
      } catch (error) {
        failures.push(`${mode}/${psExe}: ${errText(error)}`)
        log(`以 ${mode} 通道(经 ${psExe})创建驱动进程失败:${errText(error)}`)
        continue
      }
      if (await waitForLauncherConfirmation(resolved.logFile, offsetBefore, sessionId, LAUNCH_CONFIRM_MS)) {
        log(`驱动脚本已确认启动:mode=${mode} ps=${psExe} 创建侧pid=${pid}`)
        return { pid, mode }
      }
      failures.push(`${mode}/${psExe}: ${LAUNCH_CONFIRM_MS}ms 内未见脚本启动确认`)
      log(`以 ${mode} 通道(经 ${psExe})启动后 ${LAUNCH_CONFIRM_MS}ms 内未见脚本启动确认,换下一通道`)
    }
  }
  throw new Error(failures.join('; ') || '没有可用的启动通道')
}

/** 轮询等待某个可选服务出现(启动早期它可能还没挂载)。 */
async function waitForService(ctx, serviceName, timeoutMs, isDisposed) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (isDisposed()) return undefined
    const service = typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined
    if (service !== undefined) return service
    if (Date.now() >= deadline) return undefined
    await delay(500)
  }
}

/**
 * 找出「除发起者以外、正在运行的顶层会话」—— restart_dsh 的准入依据。
 *
 * 为什么只看顶层(roots)而不按 list() 逐个判断:
 *   子代理也是会话,但它属于发起者自己 —— 子代理和本会话同进程共命,硬杀进程时它本来就跟着没,
 *   把它算成"其它会话"会让**本会话一旦派过后台子代理就永远无法重启**(子代理常在本轮内运行)。
 *   本会话自己在 roots() 里同样会出现,按 sessionId 排除即可。
 *
 * 为什么 fail-soft:
 *   这条守护一旦抛错,重启工具就变成"永远不可用"—— 比不做保护更糟。
 *   所以取不到 agents 服务(服务未挂载/热卸载竞态)、接口形态不符(roots/list 都不是函数)、
 *   条目结构不认识(没有可识别的 session.id)时一律返回可读原因,由调用方只打一行 warn 后照常重启。
 *   status 不是 'running' 的条目(含 status 缺失)都不算"正在运行",放行。
 *
 * @returns {{ available: true, total: number, running: number, others: string[] }
 *   | { available: false, reason: string }}
 */
export function detectRunningSessions(ctx, sessionId) {
  let agents
  try {
    agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  } catch (error) {
    // cordis 的 ctx.get 对"服务未注册"返回 undefined;真抛错时同样不能阻断重启
    return { available: false, reason: `读取 agents 服务抛错(${errText(error)})` }
  }
  if (agents === undefined || agents === null || typeof agents !== 'object') {
    return { available: false, reason: 'agents 服务不可用' }
  }
  // roots() 是顶层会话的权威入口;缺失时退回 list()(本 profile 下每张标签页各一个顶层 agent)
  const enumerate = typeof agents.roots === 'function' ? agents.roots : agents.list
  if (typeof enumerate !== 'function') {
    return { available: false, reason: 'agents 服务没有 roots()/list() 函数' }
  }
  let entries
  try {
    entries = enumerate.call(agents)
  } catch (error) {
    return { available: false, reason: `枚举会话抛错(${errText(error)})` }
  }
  if (!Array.isArray(entries)) {
    return { available: false, reason: `枚举会话的返回值不是数组(${typeof entries})` }
  }
  let running = 0
  const others = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const entryId = entry.session?.id
    if (entryId === undefined || entryId === null) continue
    if (entry.status === 'running') {
      running += 1
      // 只按可识别的字符串 id 排除发起者:形态不符的条目既不计数也不算"其它会话"
      if (typeof entryId === 'string' && entryId.length > 0 && entryId !== sessionId) others.push(entryId)
    }
  }
  return { available: true, total: entries.length, running, others }
}

/**
 * 「另一行代码都不许跑」的拒绝文案:说清有几个、都是谁,并给出两条出路。
 * id 最多列 MAX_LISTED_SESSIONS 个,超出用"等 N 个"收尾。
 */
export function formatOtherSessionsMessage(others) {
  const shown = others.slice(0, MAX_LISTED_SESSIONS).map((id) => `\`${id}\``).join('、')
  const suffix = others.length > MAX_LISTED_SESSIONS ? ` 等 ${others.length} 个` : ''
  return `restart_dsh 未执行:检测到 ${others.length} 个其它会话正在运行(${shown}${suffix})。`
    + '重启会硬杀共用同一个 dsh 宿主,它们的当前轮会直接消失且新进程只恢复本会话;'
    + '请等它们跑完再重启,或先让它们结束。'
}

/**
 * 启动时的注入流程:读标记 → 判定 → 等 sessionController → 恢复会话 → 注入 followup。
 * 全程 fail soft:任何失败只归档标记 + 写日志,不抛回宿主(不能影响 dsh 正常服务)。
 */
async function runInjection(ctx, resolved, log, isDisposed) {
  const pending = readPendingFile(resolved.pendingFile)
  if (pending === undefined) return
  const verdict = classifyPending(pending, Date.now(), resolved.staleMs)
  if (verdict !== 'fresh') {
    archivePendingFile(resolved.pendingFile, verdict)
    log(`启动时发现重启标记,但判定为 ${verdict},已归档不注入`)
    return
  }
  log(`启动时发现重启标记:session=${pending.sessionId},等待 sessionController...`)
  const controller = await waitForService(ctx, 'sessionController', resolved.controllerWaitMs, isDisposed)
  if (controller === undefined || typeof controller.resolveAgent !== 'function') {
    archivePendingFile(resolved.pendingFile, 'failed')
    log(`sessionController 在 ${resolved.controllerWaitMs}ms 内不可用,标记已归档为 pending.failed-*.json,本次不注入`)
    return
  }
  if (isDisposed()) return
  let found
  try {
    found = await controller.resolveAgent(pending.sessionId)
  } catch (error) {
    archivePendingFile(resolved.pendingFile, 'failed')
    log(`恢复会话 ${pending.sessionId} 抛错:${errText(error)};标记已归档,本次不注入`)
    return
  }
  if (found === undefined || found.agent === undefined || found.error !== undefined) {
    archivePendingFile(resolved.pendingFile, 'failed')
    log(`恢复会话 ${pending.sessionId} 失败:${errText(found?.error)};标记已归档,本次不注入`)
    return
  }
  try {
    found.agent.followup(createUserMessage({
      content: [{ type: 'text', text: pending.text }],
      source: { kind: 'user' },
    }))
  } catch (error) {
    archivePendingFile(resolved.pendingFile, 'failed')
    log(`向会话 ${pending.sessionId} 注入消息失败:${errText(error)};标记已归档`)
    return
  }
  try { unlinkSync(resolved.pendingFile) } catch { /* 已被消费 */ }
  log(`已向会话 ${pending.sessionId} 注入「已重启」(followup 已入队,新一轮由新进程驱动)`)
}

/** 组装工具结果文本(模型看到的就是这段)。 */
function successMessage(launched, waitSeconds, resolved, instance = {}) {
  // 把身份写进结果:用户与模型都能立刻看到"杀的是哪一个实例",不必翻日志
  const who = [
    instance.pid !== undefined ? `pid=${instance.pid}` : undefined,
    instance.profile !== undefined ? `profile=${instance.profile}` : undefined,
    instance.port !== undefined ? `port=${instance.port}` : undefined,
  ].filter((part) => part !== undefined).join(', ')
  return [
    `重启已发起:驱动脚本(pid=${launched.pid},${launched.mode} 通道)将在约 ${waitSeconds} 秒后终止本实例的 dsh 后端(${who.length > 0 ? who : `pid=${process.pid}`}),`,
    '常驻看门狗随即拉起新进程;新进程就绪后会自动向本会话注入「已重启」并继续对话,整轮约 20~40 秒。',
    '请立刻结束本轮回复,不要再调用其它工具 —— 进程被终止后本轮输出会截断,只有已落盘的内容会保留。',
    `(标记 ${resolved.pendingFile};流程日志 ${resolved.logFile})`,
  ].join('')
}

export function apply(ctx, config) {
  // 绝不能把异常抛回 loader:插件加载失败会让**整个 dsh 起不来**(2026-09-17 事故的教训 ——
  // 当时是新 dsh 每次都在打印 token URL 前崩掉,表现为浏览器卡"启动中")。
  // 任何意外都只降级(工具可能未注册、注入可能不执行)并留一行日志。
  try {
    applyInner(ctx, config)
  } catch (error) {
    appendLog(fallbackLogFile(), 'plugin', `apply 抛错,插件已降级(工具可能未注册):${errText(error)}`)
  }
}

function applyInner(ctx, config) {
  const resolved = resolveConfig(config)
  const log = (message) => appendLog(resolved.logFile, 'plugin', message)
  log(`apply: v0.1.0 pendingFile=${resolved.pendingFile} script=${resolved.restartScript} wait=${resolved.waitSeconds}s`)

  // 本实例身份:重启只允许杀命中它的 dsh 进程。三件套都取自本进程 argv,所以目标进程的
  // 命令行里必然带同样的 token ⇒ 脚本侧正向校验不会假阴性(见启动命令行里的 -DshPid 等)。
  const instance = resolveInstanceIdentity()
  log(`实例身份: pid=${instance.pid ?? '?'} profile=${instance.profile ?? '(未识别)'} port=${instance.port ?? '(未识别)'}`)
  if (instance.profile === undefined && instance.port === undefined) {
    log('警告:argv 里既没有 profile 也没有 --port,身份判据只剩 pid;跨 profile 场景请人工确认。')
  }

  let disposed = false
  const isDisposed = () => disposed

  // ── 1) 注册模型工具 ─────────────────────────────────────────────────────
  let disposeTool = null
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  if (tools === undefined || typeof tools.register !== 'function') {
    log('tools 服务不可用,restart_dsh 工具未注册(注入逻辑仍会运行)')
  } else {
    try {
      disposeTool = tools.register(defineTool({
        name: TOOL_NAME,
        description: [
          'Restart the dsh backend process that serves this Web GUI, then continue this session in the new process.',
          'Calling it writes a restart marker, launches a driver script detached from the dsh process tree, and returns',
          'immediately: the driver waits a few seconds (so this turn\'s output reaches disk), kills the current dsh, lets',
          'the resident watchdog start a fresh one, and once the new process boots this plugin resumes THIS session and',
          'injects a "已重启" user message, so the conversation continues automatically without user action.',
          'The current turn ends when the process dies, so finish your reply right after calling this tool and do not call',
          'further tools; already-persisted output is kept, anything still streaming is lost. Expect roughly 20-40 seconds',
          'before the injected message appears. All tabs/windows of this Web GUI share ONE host process, while only the',
          'calling session is resumed in the new process: when this detects other top-level sessions that are currently',
          'running, the call is REFUSED with their session ids and nothing is written or launched - wait for them to finish',
          '(or end them) and then call again. Use it only when the user explicitly asks to restart dsh, for example after',
          'changing host-plugin code or a cordis patch that only takes effect on a process restart. It terminates only THIS',
          'dsh instance (the process serving this session), identified by its pid/profile/port - other profiles\' instances',
          'running on the same machine are left untouched.',
        ].join(' '),
        parameters: {
          // 注意:value-schema DSL 的 required 只接受 true —— 可选参数必须**省略**该字段;
          // 写 required:false 会让 defineTool 直接抛
          // "unsupported JSON schema: parameters.<name>.required must be true when present"(0.1.0 实测)。
          note: {
            type: 'string',
            description: 'Optional extra sentence appended to the injected message, e.g. what to verify after the restart.',
          },
          wait_seconds: {
            type: 'integer',
            description: `Seconds to wait before killing dsh (${MIN_WAIT_SECONDS}-${MAX_WAIT_SECONDS}, default ${DEFAULT_WAIT_SECONDS}). `
              + 'Larger values give this turn more time to finish writing; smaller values restart sooner.',
          },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{
            type: 'text',
            text: typeof value?.message === 'string' ? value.message : JSON.stringify(value ?? {}, null, 2),
          }],
        },
        presentCall: () => ({
          card: 'generic',
          title: 'Restart dsh',
          kind: 'other',
          rawInput: {},
        }),
        async execute(args, exec) {
          const session = exec?.agent?.session
          const sessionId = session?.id
          if (typeof sessionId !== 'string' || sessionId.length === 0) {
            return { ok: false, message: 'restart_dsh 未执行:本次调用没有归属会话,无法确定重启后要续哪个会话。' }
          }
          if (session?.header?.origin === 'subagent') {
            return { ok: false, message: 'restart_dsh 未执行:子代理会话不支持重启续跑(只有主会话能在新进程里恢复),请让主会话发起。' }
          }
          // ── 准入:还有别的顶层会话在跑就拒绝 ────────────────────────────────
          // 必须在 writePendingFile **之前**返回:拒绝路径一个字节都不写盘、不启动驱动脚本。
          // 检测本身也兜一层 try:守护再怎样都不该让重启工具变成"调用即报错"。
          let detected
          try {
            detected = detectRunningSessions(ctx, sessionId)
          } catch (error) {
            detected = { available: false, reason: `会话检测异常(${errText(error)})` }
          }
          if (detected.available) {
            log(`会话检测: 顶层会话 ${detected.total} 个(运行中 ${detected.running} 个), 其它运行中 ${detected.others.length} 个`)
            if (detected.others.length > 0) {
              return { ok: false, message: formatOtherSessionsMessage(detected.others) }
            }
          } else {
            // fail-soft:守护不能把重启工具变成"永远不可用"
            log(`无法检测其它会话(${detected.reason}),按无其它会话处理,照常重启`)
          }
          const waitSeconds = resolveWaitSeconds(args?.wait_seconds)
          const record = {
            version: 1,
            sessionId,
            text: buildInjectText(args?.note),
            createdAt: Date.now(),
            waitSeconds,
            pidBefore: process.pid,
            cwd: session?.header?.cwd,
          }
          try {
            writePendingFile(resolved.pendingFile, record)
          } catch (error) {
            log(`写重启标记失败:${errText(error)}`)
            return { ok: false, message: `restart_dsh 未执行:写重启标记失败 —— ${errText(error)}` }
          }
          let launched
          try {
            launched = await launchDriver(resolved, sessionId, waitSeconds, log, instance)
          } catch (error) {
            try { unlinkSync(resolved.pendingFile) } catch { /* 不存在 */ }
            log(`启动驱动脚本失败,已撤销重启标记:${errText(error)}`)
            return { ok: false, message: `restart_dsh 未执行:驱动脚本启动失败(${errText(error)}),本次没有重启;标记已撤销。` }
          }
          log(`工具调用:session=${sessionId} wait=${waitSeconds}s launcherPid=${launched.pid} mode=${launched.mode} dshPid=${process.pid}`)
          return {
            ok: true,
            sessionId,
            launcherPid: launched.pid,
            launcherMode: launched.mode,
            waitSeconds,
            pendingFile: resolved.pendingFile,
            logFile: resolved.logFile,
            message: successMessage(launched, waitSeconds, resolved, instance),
          }
        },
      }))
      log(`restart_dsh 工具已注册(tools.register 返回 disposer=${typeof disposeTool === 'function'})`)
    } catch (error) {
      log(`restart_dsh 工具注册失败(注入逻辑不受影响):${errText(error)}`)
    }
  }

  // ── 2) 启动时消费上一次重启留下的标记 ────────────────────────────────────
  // 延迟 bootDelayMs 再动手:避开宿主启动风暴,等 session 持久化/查询与 preset 注册表就位。
  const runInject = () => {
    runInjection(ctx, resolved, log, isDisposed).catch((error) => {
      log(`注入流程异常:${errText(error)}`)
    })
  }
  let cancelBoot
  try {
    // timer 已在 inject 中声明;这里仍兜一层 —— 定时器拿不到不该拖垮宿主。
    cancelBoot = ctx.timeout(runInject, resolved.bootDelayMs)
  } catch (error) {
    log(`ctx.timeout 不可用(${errText(error)}),回退全局 setTimeout`)
    const timer = setTimeout(runInject, resolved.bootDelayMs)
    cancelBoot = () => clearTimeout(timer)
  }

  // ── 3) 生命周期:插件卸载/热重载时撤销全部副作用 ──────────────────────────
  ctx.on('dispose', () => {
    disposed = true
    try { cancelBoot?.() } catch { /* 已触发 */ }
    if (typeof disposeTool === 'function') {
      try { disposeTool() } catch { /* 已回收 */ }
      disposeTool = null
    }
    log('dispose:已回收工具注册与启动注入任务')
  })
}
