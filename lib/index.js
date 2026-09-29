/**
 * dsh-host-restart v0.5.0
 *
 * 给 DSH web 宿主加一个"重启自己并把会话续上"的模型工具 restart_dsh:
 *
 *   1) 模型调用工具 → 本插件先**顺手保存一份会话交接记录**（可选服务 `slHandoff`，
 *      由同 profile 的 dsh-host-sl 提供；服务缺席/抛错都只记一行日志，绝不阻断重启）→
 *      再把「重启后要注入的文本 + 调用方会话 id」写进标记文件,
 *      然后用 WMI(Win32_Process.Create)启动一个**完全脱离 dsh 进程树**的 pwsh 驱动脚本,
 *      随即返回(要求模型立刻结束本轮);
 *   2) 驱动脚本(C:\run\tools\dsh-restart.ps1)等本轮输出落盘 → 杀掉当前 dsh →
 *      等常驻看门狗回门户监听 → 触发看门狗拉起新 dsh → 轮询直到新进程就绪;
 *   3) 新 dsh 启动时本插件读标记 → 用官方 API 恢复该会话(resume + 按其记录的
 *      agentPreset 重新挂载)→ 注入一条「已重启」用户消息 → 会话在新进程里继续跑。
 *      （同一次启动里 dsh-host-sl 还会把第 1 步存下的交接记录也注入回这个会话。）
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
 *   - ctx.get('slHandoff') —— **可选**服务(dsh-host-sl 提供),见 saveHandoffBeforeRestart。
 *
 * 边界:只对主会话开放 —— 拿不到归属会话、或发起者是子代理会话(origin==='subagent')时**直接拒绝**,
 *   一个字节都不写盘(只有主会话能在新进程里恢复)。
 *   **其它会话还有活在跑时不再拒绝**(2026-09-28 用户明确要求:重启不该被拒绝)—— 检测照旧跑
 *   (口径三条,2026-09-27 扩:自己在本轮运行 / 名下还有正在跑的子代理 / 名下还有未结算的后台作业),
 *   但只把"本次会打断谁"如实写进日志与工具返回文案,然后照常重启;代价与理由见 README §4。
 *   标记文件成功注入即删,陈旧/损坏/失败一律改名归档为 pending.<原因>-<时间>.json,绝不无限重试。
 *
 * ⚠ 为什么等待仍固定成 2s(2026-09-27 定,2026-09-28 保留):判定与杀之间隔着这段等待,
 *   窗口里随时可能有别的会话开始跑(用户在另一个标签页发消息、子代理结束唤醒父会话),而那时
 *   没有任何机制复查。旧版把等待交给模型(wait_seconds 2~60s,默认 6)只会让被打断的活更多;
 *   现在只留"本次工具结果落盘"必需的 2s,工具参数 wait_seconds 与配置项 waitSeconds 一并删除。
 *   另注(2026-09-28):重启前的交接保存是**同步做完再启动驱动脚本**的 —— 它只会让"发起重启"
 *   整体晚一点点,不会挤占这 2s(那个窗口由驱动脚本从自己启动那一刻开始计时),见
 *   saveHandoffBeforeRestart 与 README §1/§4。
 *
 * ⚠ v0.4.1(2026-09-28):apply 阶段那行「重启前的交接保存:slHandoff 服务不在场(dsh-host-sl 未装载?)」
 *   是**假阴性**,已经删掉。apply 那一刻同进程的 dsh-host-sl 还没把服务挂上(服务由它自己的 fiber
 *   provide,时机在 apply 之后),所以 `ctx.get(HANDOFF_SERVICE)` 必然读不到;而同一个进程里稍后的
 *   工具调用又看得到它(2026-09-28 21:38 与 23:05 两次重启前的 saveAll 都真的存了盘)。
 *   这行假阴性还被 README §5 当成"对端插件没装"的排障线索,会把人带偏 ⇒ 现在改成**首次
 *   `restart_dsh` 工具被调用时探测一次**(那时服务一定可见,结论才可信),探测结论与真实调用结果
 *   不一致时如实区分(以真实调用为准)。见 probeHandoffOnce / describeHandoffProbeMismatch。
 *
 * ⚠ v0.4.2(2026-09-29):**把两条注入合并成一次、一轮**(用户要求)。旧版一次重启注入两条消息、
 *   跑两轮:本插件的「已重启」路径更短(约 4s)必然先跑,`dsh-host-sl` 的【sl 交接续跑】多一步
 *   `list()` 判定(约 6s)排进 next-turn ⇒ **第一轮拿不到交接记录**,只能空转或乱做。
 *   现在:新进程读到自己的重启标记、准备注入之前,**先判断这次有没有 `dsh-host-sl` 的待续标记、
 *   且其中含"本会话尚未处理的条目"**(判据:`sessionId` 相等且 `done !== true`;`active` 是什么
 *   不影响这条判断 —— 空闲条目同样会被对方处理掉并归档,所以它一样意味着"有人接手"):
 *     · 有 ⇒ **不自己注入**,交给对方的【sl 交接续跑】承担 —— 让位之后注入的是**对方那条**,
 *       本插件不再往里面塞任何说明(见 §4「重启前的交接保存」);
 *     · 否(服务缺席 / 没有标记 / 本会话不在标记里 / 读不到 / 形态不符)⇒ **照旧自己注入**,
 *       并在日志里写清是哪种原因。
 *   **兜底(必须有)**:决定让位之后延迟约 10s(`deferRecheckMs`)复查一次 —— 若标记里**仍有**本会话的
 *   未处理条目(= 对方让位或失败了)**且**本会话 `status !== 'running'` ⇒ 自己补注入一次
 *   (`buildInjectText()` 的固定文案,与照旧注入那条逐字同一条消息);复查时标记里已没有本会话条目(对方
 *   接手了)或本会话已在 running ⇒ 什么都不做。定时器用 `ctx.effect` 登记清理 —— **不许用
 *   `ctx.on('dispose', …)`**:本机 cordis 卸载时发的是 `internal/plugin`,根本没有 dispose 事件
 *   (2026-09-29 已修:全包只剩 `ctx.effect` 这一处登记 —— 工具 disposer 与「启动注入」「兜底复查」
 *   两个定时器都在卸载时真的回收;此前那处 `ctx.on('dispose', …)` 从来没触发过,是死代码)。
 *   取数顺序与为什么这样排序见 readHandoffPendingSummary。
 *
 * ⚠ v0.5.0(2026-09-29,用户决定):**工具参数清零、注入文案固定**(删参数属破坏性变更,故升 minor)。
 *   · `restart_dsh` **不再有 `note` 参数**(v0.4.2 及以前是"可选说明,追加到注入文案末尾"),
 *     工具描述里关于 note 的表述一并删掉;`buildInjectText()` 保留为导出函数但**忽略参数、恒返回
 *     固定文案**(调用点与测试不必大改),函数注释写明"note 已随工具参数一并删除";
 *   · `saveHandoffBeforeRestart` 调 `saveAll` 时**不再传 `note`** —— 本插件调它只是为了把
 *     dsh-host-sl 的活跃工作表刷到最新,"续跑消息由谁注入"仍按 pendingSummary 让位,但注入内容里
 *     **没有**本插件的说明(`noteSessionId` 与 `session` 两个形参保留:v0.7.0 的 dsh-host-sl
 *     不读它们,保留只为兼容);
 *   · **让位逻辑一个字没动**:仍然只让 dsh-host-sl 说话,本插件仅在对方缺席/没接管时兜底,
 *     而兜底那条现在就是固定文案,不再拼任何别的内容。
 *
 * ⚠ 改动须知(2026-09-17 事故后补,踩过就别再踩):
 *   · 本包 4/4 共享文件实测为**独立拷贝**,不是 junction —— 真正被加载的是
 *     node_modules\dsh-host-restart\lib\index.js,改 plugins\ 下的源码**不会生效**。
 *     改完必须重装同步,再重启 dsh(loader 按 URL 缓存已 import 的模块):
 *       node <工作区>\dsh-plugin-manager\dshpm.mjs add \
 *         file:C:\Users\MLTZ\.dsh\profiles\web\plugins\dsh-host-restart --profile web
 *     两份已经漂移过一次:5:54 只补了 node_modules 那份的 timer 声明,plugins 那份没有,
 *     于是工具注册持续失败而没人发现。
 *   · 访问未在 inject 里声明的服务属性会抛错,而 apply 抛错 = **整个 dsh 起不来**。
 *     test/inject-coverage.test.mjs 会静态扫描本文件的 ctx.<service> 访问并断言已声明。
 *     ⚠ `slHandoff` **故意不进 inject**:它必须可选(dsh-host-sl 没装时本插件仍要 apply),
 *     用 ctx.get() 读,见 saveHandoffBeforeRestart。
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

/** 版本号(与 package.json 的 version 保持一致;日志里回显,便于确认"新版本已生效")。 */
export const VERSION = '0.5.0'

/**
 * 重启前顺手保存交接记录用的 cordis 服务名 —— 由同 profile 的 `dsh-host-sl` 提供。
 *
 * ⚠ **不进 inject**:inject 是"全有才 apply"的硬门,写进去就等于"dsh-host-sl 没装时本插件
 *   连工具都不注册"。这里用 `ctx.get()` 可选读取 + 完全 fail-soft(见 saveHandoffBeforeRestart)。
 */
export const HANDOFF_SERVICE = 'slHandoff'

/**
 * `dsh-host-sl` 的落盘目录名与待续标记文件名(v0.4.2)——
 * "这次会不会有人接手注入"读文件那条退路要用它:`<DSH_HOME>\storages\sl-handoff\pending.json`。
 * 位置由对方决定(见 dsh-host-sl 的 README「落盘位置与文件格式」),这里只是**只读**地跟着读。
 */
export const HANDOFF_STORAGE_DIRNAME = 'sl-handoff'
export const HANDOFF_PENDING_FILENAME = 'pending.json'

/**
 * 「让位给交接记录」之后多久复查一次兜底(v0.4.2)。
 *
 * 取值理由:对方的启动路径是 apply 后 4s 醒来 → 等 sessionController → 一次 `list()` 判定 → 注入,
 * 实测比本插件晚 2 秒上下(README §1 的两轮时序);10s 留足余量,又远短于"用户以为卡住了"的尺度。
 * 复查只做两件事:再读一次标记 + 看本会话 status;两者都不满足就什么都不做(见 runHandoffFallback)。
 */
export const DEFAULT_DEFER_RECHECK_MS = 10 * 1000

/**
 * 会话检测:工具返回文案里最多列几个「会被本次重启打断」的会话 id(超出用"等 N 个"收尾)。
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

/**
 * 杀进程前的固定静默:只够"本次工具结果落盘"那一下,不再给模型可调空间。
 * 取值理由与"为什么不能更长"见文件头(判定到杀之间那段窗口里开始的活没人复查,等待越久打断得越多)。
 * 改这个常量等于改"会打断多少活"的尺度,别顺手加大。
 */
export const WAIT_SECONDS = 2

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
 * 注入到会话的固定正文(v0.5.0 起)。
 *
 * 2026-09-29 用户拍板:不再由调用方追加说明,重启后注入的就是这一句固定文案。
 * 固定文案 = 只叫醒会话("继续"),不带任何本插件的解释 —— 解释交给 dsh-host-sl 的
 * 【sl 交接续跑】(它接手时本插件根本不注入),兜底那条也用它。
 */
export const DEFAULT_INJECT_TEXT = 'dsh已重启,继续'

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
  // v0.4.2:交接记录那条退路读的文件 —— 默认与 dsh-host-sl 的默认落点一致(只读)。
  // 独立成配置项是为了让测试把它指到临时目录(绝不去读真实的 sl-handoff 标记)。
  const handoffPendingFile = typeof cfg.handoffPendingFile === 'string' && cfg.handoffPendingFile.length > 0
    ? cfg.handoffPendingFile
    : join(home, 'storages', HANDOFF_STORAGE_DIRNAME, HANDOFF_PENDING_FILENAME)
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
    handoffPendingFile,
    restartScript,
    logFile,
    psExe,
    wmiExec,
    // 等待不再是配置项:固定 WAIT_SECONDS(2026-09-27)。配了 waitSeconds 也会被忽略 ——
    // 它一旦能被调大,"判定到杀"之间那段无人复查的窗口就跟着变宽,被打断的活更多。
    waitSeconds: WAIT_SECONDS,
    bootDelayMs: assertIntegerInRange('bootDelayMs', cfg.bootDelayMs ?? DEFAULT_BOOT_DELAY_MS, 0, 10 * 60 * 1000),
    staleMs: assertIntegerInRange('staleMs', cfg.staleMs ?? DEFAULT_STALE_MS, 1000, 24 * 60 * 60 * 1000),
    controllerWaitMs: assertIntegerInRange('controllerWaitMs', cfg.controllerWaitMs ?? DEFAULT_CONTROLLER_WAIT_MS, 0, 5 * 60 * 1000),
    // v0.4.2:让位给交接记录之后的复查延迟(兜底)。测试靠它把 10s 变成 0 或按需取值。
    deferRecheckMs: assertIntegerInRange('deferRecheckMs', cfg.deferRecheckMs ?? DEFAULT_DEFER_RECHECK_MS, 0, 10 * 60 * 1000),
  }
}

/** 整数范围校验:非整数/越界都抛,避免把坏配置带进重启流程。 */
function assertIntegerInRange(field, value, min, max) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`restart-dsh: ${field} 必须是 ${min}~${max} 的整数,收到 ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * 组装注入正文:**恒为固定文案**(v0.5.0)。
 *
 * `note` 已随工具参数一并删除(见文件头 ⚠ v0.5.0):函数**保留**是为了让现有调用点与测试
 * 不必大改,但它**忽略参数**、恒返回 DEFAULT_INJECT_TEXT —— 任何传进来的说明都不会被拼进去。
 * 想改注入内容就改 DEFAULT_INJECT_TEXT 这一个常量。
 */
export function buildInjectText() {
  return DEFAULT_INJECT_TEXT
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

/** 其它会话"在飞"的种类 → 告知文案里的说法。顺序固定,保证同一状态下文案稳定。 */
export const ACTIVITY_ORDER = ['session', 'subagent', 'job']
const ACTIVITY_TEXT = { session: '会话在跑', subagent: '子代理在跑', job: '后台作业在跑' }

/** 取 agent 的会话 id;拿不到(形态不符)返回 undefined,不猜。 */
function agentId(agent) {
  const id = agent?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * 沿**持久血缘**(session.header.parentSession)上溯到顶,返回最高层的会话 id。
 * 链上出现 ownerId 时返回 ownerId 本身 —— 调用方据此判断"这是它的后代"。
 * 父会话已不在 live 表里时用持久 id 收尾(宁拦不放过);血缘损坏成环则用已知最高层收尾,不无限走。
 */
function lineageTopId(agent, byId, ownerId) {
  const visited = new Set()
  let current = agent
  let top = agentId(agent)
  while (top !== undefined && top !== ownerId) {
    const parentId = current?.session?.header?.parentSession
    if (typeof parentId !== 'string' || parentId.length === 0) return top
    if (visited.has(parentId)) return top
    visited.add(parentId)
    top = parentId
    current = byId.get(parentId)
  }
  return top
}

/** live agent 全表:只有 list() 含子代理;拿不到就退回 roots()(② 随之退化,与旧版等价)。 */
function liveAgents(agents, roots) {
  if (typeof agents.list !== 'function') return roots
  try {
    const all = agents.list()
    return Array.isArray(all) ? all : roots
  } catch {
    return roots
  }
}

/**
 * 该 owner 会话名下未结算的后台作业数(running/stopping)。
 * fail-soft:服务缺失、形态不符、枚举抛错一律当作 0(这条检测不该让工具变成永远不可用)。
 */
function runningJobCount(ctx, ownerId) {
  let jobs
  try {
    jobs = typeof ctx.get === 'function' ? ctx.get('jobs') : undefined
  } catch {
    return 0
  }
  if (jobs === undefined || jobs === null || typeof jobs.list !== 'function') return 0
  let views
  try {
    views = jobs.list(ownerId)
  } catch {
    return 0
  }
  if (!Array.isArray(views)) return 0
  // owner 必须精确等于该会话:list() 会把"无主作业"一并返回,不筛就会张冠李戴
  return views.filter((job) => job?.owner === ownerId && (job.status === 'running' || job.status === 'stopping')).length
}

/**
 * 找出「除发起者以外、还有活在跑的会话」—— 重启前**如实告知**的依据(2026-09-27 扩口径,
 * 2026-09-28 起**不再据此拒绝重启**)。返回值只进日志与工具返回文案,不参与任何放行判定。
 *
 * 三条口径:
 *   ① 自己在本轮运行(agent.status === 'running');
 *   ② 名下还有正在跑的子代理:顶层会话派完后**台**子代理就结束本轮 ⇒ 父会话是 idle、子代理还在跑
 *      (它只在结束时才 followup 唤醒父会话)。roots() 按 owner===undefined 过滤,子代理天然不在里面,
 *      所以必须用 list() 并按持久血缘自己上溯到它的根;
 *   ③ 名下还有未结算的后台作业(running/stopping):作业归 owner 会话所有,结果靠 followup 送回 owner,
 *      进程被硬杀即永久丢失(记录是纯内存态,重启后 job_list 里什么都没有)。
 * 为什么正是这三条:DSH 自己的"这个会话还有活动"口径(归档准入)就是这三样 ——
 *   dsh-agent 的 turn 家族 + dsh-subagent 的 runningDescendants + dsh-jobs 的 runningJobs。
 *
 * 发起者自己名下的 ②③ 不进 `others`(它们与本会话同进程共命,不是"别的会话"),但**单独计进 `own`** ——
 * 它们同样会被硬杀,文案里要一并告知("本会话自己名下还有 N 个子代理在跑")。
 *
 * 为什么 fail-soft:检测一旦抛错,重启工具就会连"会打断谁"都说不出来。
 *   取不到 agents 服务(未挂载/热卸载竞态)、接口形态不符、条目结构不认识时一律返回可读原因或跳过该项,
 *   由调用方只打一行 warn 后照常重启。status 不是 'running' 的条目(含 status 缺失)都不算"在跑"。
 *
 * @returns {{ available: true, total: number, running: number, own: { subagents: number, jobs: number },
 *     others: Array<{ id: string, reasons: string[] }> }
 *   | { available: false, reason: string }}
 *   others[].reasons 取值见 ACTIVITY_ORDER:'session' / 'subagent' / 'job';
 *   own.subagents / own.jobs = 发起者自己名下在跑的子代理数 / 未结算作业数。
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
  let roots
  try {
    roots = enumerate.call(agents)
  } catch (error) {
    return { available: false, reason: `枚举会话抛错(${errText(error)})` }
  }
  if (!Array.isArray(roots)) {
    return { available: false, reason: `枚举会话的返回值不是数组(${typeof roots})` }
  }
  const rootIds = new Set(roots.map(agentId).filter((id) => id !== undefined))
  /** id → 命中的种类集合;发起者自己的 id 与不可识别的条目都不进表。 */
  const activity = new Map()
  const mark = (id, kind) => {
    if (id === undefined || id === sessionId) return
    const kinds = activity.get(id) ?? new Set()
    kinds.add(kind)
    activity.set(id, kinds)
  }

  // ① 顶层会话自己在本轮运行
  let running = 0
  for (const agent of roots) {
    if (agent?.status !== 'running') continue
    running += 1
    mark(agentId(agent), 'session')
  }

  // ② 子代理在跑:roots 之外的 live agent 才算,归到它血缘上的根;发起者自己名下的单独计数
  const live = liveAgents(agents, roots)
  const byId = new Map()
  for (const agent of live) {
    const id = agentId(agent)
    if (id !== undefined) byId.set(id, agent)
  }
  let ownSubagents = 0
  for (const agent of live) {
    if (agent?.status !== 'running') continue
    const id = agentId(agent)
    if (id === undefined || rootIds.has(id)) continue // 顶层已在 ① 里算过,不重复归因
    const top = lineageTopId(agent, byId, sessionId)
    if (top === sessionId) {
      ownSubagents += 1 // 自己的子代理:不进 others,但要如实告知(它照样被硬杀)
      continue
    }
    mark(top, 'subagent')
  }

  // ③ 后台作业未结算:作业按 owner 隔离,只能逐个顶层会话去问(自己的单独计数)
  const ownJobs = runningJobCount(ctx, sessionId)
  for (const id of rootIds) {
    if (id === sessionId) continue
    if (runningJobCount(ctx, id) > 0) mark(id, 'job')
  }

  const others = [...activity.entries()].map(([id, kinds]) => ({
    id,
    reasons: ACTIVITY_ORDER.filter((kind) => kinds.has(kind)),
  }))
  return { available: true, total: roots.length, running, own: { subagents: ownSubagents, jobs: ownJobs }, others }
}

/**
 * 交接记录能不能把被打断的会话接回来 —— 成功/失败两种说法,告知文案末尾那一段。
 * ⚠ 不许写成谎话:服务缺席/抛错/返回 ok:false 时一律走失败分支,只报原因,不报"已存"。
 * @param handoff saveHandoffBeforeRestart 的结果({ok, files, text})。
 */
function recoveryClause(handoff = { ok: false, files: [], text: '' }) {
  if (handoff.ok !== true) {
    const reason = oneLine(handoff.text)
    return `这些会话的交接记录这次没存下来(${reason.length > 0 ? reason : '原因未知'}),`
      + '新进程里没人会把它们唤回 —— 那些会话的上下文需要你重新交代。'
  }
  const count = Array.isArray(handoff.files) ? handoff.files.length : 0
  return `这些会话的交接记录已随本次重启存下(${count > 0 ? `本次共 ${count} 份,含本会话` : '服务未回传记录路径'}),`
    + '新进程启动时会由 dsh-host-sl 逐条注入、各自重起一轮接着跑。'
}

/**
 * 「本次重启会打断谁」的告知文案(2026-09-28 起是**信息**,不是闸门:不再拒绝重启)。
 * 说清有几个其它会话、本会话自己名下还有哪些活在跑、各自在跑什么,以及交接记录能不能把它们接回来 ——
 * 让人自己决定要不要现在重启。id 最多列 MAX_LISTED_SESSIONS 个,超出用"等 N 个"收尾。
 * @param detected detectRunningSessions 的返回值(只处理 available:true 的形态)。
 * @param handoff saveHandoffBeforeRestart 的结果 —— 决定"接得回来"还是"接不回来"。
 */
export function formatInterruptedNotice(detected, handoff) {
  const others = detected.others
  const own = detected.own ?? { subagents: 0, jobs: 0 }
  const head = []
  if (others.length > 0) {
    const shown = others.slice(0, MAX_LISTED_SESSIONS)
      .map(({ id, reasons }) => `\`${id}\`(${reasons.map((kind) => ACTIVITY_TEXT[kind] ?? kind).join('、')})`)
      .join('、')
    const suffix = others.length > MAX_LISTED_SESSIONS ? ` 等 ${others.length} 个` : ''
    head.push(`本次重启会打断 ${others.length} 个其它会话(${shown}${suffix})`)
  }
  const ownKinds = [
    own.subagents > 0 ? `${own.subagents} 个子代理在跑` : '',
    own.jobs > 0 ? `${own.jobs} 个后台作业未结算` : '',
  ].filter((part) => part.length > 0)
  if (ownKinds.length > 0) head.push(`本会话自己名下还有 ${ownKinds.join('、')}`)
  if (head.length === 0) return ''
  const tail = others.length > 0
    ? '它们与本会话共用同一个 dsh 宿主,会被一起硬杀'
    : '它们随本会话一起被硬杀'
  return `${head.join('、')}:${tail} —— 正在跑的那一步工具调用直接丢(交接记录救得回上下文、救不回这一步);`
    + recoveryClause(handoff)
}

/**
 * 启动时的注入流程:读标记 → 判定 → 等 sessionController → 恢复会话 →
 * **看交接记录会不会接手(v0.4.2)** → 注入 followup(或让位 + 排一个兜底复查)。
 * 全程 fail soft:任何失败只归档标记 + 写日志,不抛回宿主(不能影响 dsh 正常服务)。
 * @param scheduleRecheck 排一个延迟任务并返回 disposer(apply 里注入;见 scheduleRecheck)。
 */
async function runInjection(ctx, resolved, log, isDisposed, scheduleRecheck) {
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

  // ── v0.4.2:交接记录会不会接手这次注入?──────────────────────────────────────
  // 判据、取数顺序与兜底见文件头 ⚠ v0.4.2 / readHandoffPendingSummary / runHandoffFallback。
  // 放在 resolveAgent **之后**:兜底复查要拿这个 agent 看 status、也要用它补注入。
  const summary = readHandoffPendingSummary(ctx, resolved, log)
  const handedOff = findUnhandledHandoffItem(summary, pending.sessionId)
  if (handedOff !== undefined) {
    log(`交接记录将接手注入，本次不再单独注入「已重启」:待续标记里有本会话 ${pending.sessionId} 的未处理条目`
      + `(来源=${summary.source},kind=${handedOff.kind},active=${handedOff.active === undefined ? '未判过' : handedOff.active})`
      + ` —— 注入内容由对方的【sl 交接续跑】给出(本插件不往里面塞说明);${resolved.deferRecheckMs}ms 后复查兜底`)
    // 本插件这条标记算消费掉了(决定已经做出;兜底注入用的是闭包里的 text,不再需要文件)
    try { unlinkSync(resolved.pendingFile) } catch { /* 已被消费 */ }
    const schedule = typeof scheduleRecheck === 'function' ? scheduleRecheck : () => {}
    schedule(
      () => runHandoffFallback(ctx, resolved, log, isDisposed, pending.sessionId, pending.text, found.agent),
      resolved.deferRecheckMs,
    )
    return
  }
  log(`交接记录不会接手本次注入(${summary.reason.length > 0 ? summary.reason : `待续标记里没有本会话 ${pending.sessionId} 的未处理条目`}),照旧自己注入「已重启」`)

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

/**
 * 重启前顺手保存一份会话交接记录（可选能力，2026-09-28 新增；服务由 `dsh-host-sl` 提供）。
 *
 * 语义：
 *   · **覆盖所有活跃会话**（2026-09-28 起，v0.4.0 的服务能力）：调 `saveAll({all:true, noteSessionId, session})`
 *     —— `dsh-host-sl` 会枚举宿主里**所有活着的 agent**（顶层会话 + 子代理）各存一份交接记录。
 *     **本插件不再传 `note`（v0.5.0）**：调用它只是为了把对方的活跃工作表刷到最新，注入内容里
 *     **没有**本插件的说明（`noteSessionId` / `session` 两个形参保留，v0.7.0 的 dsh-host-sl 不读它们，
 *     保留只为兼容）。为什么必须覆盖所有活跃会话：重启会硬杀整个进程，在飞的活不止当前这一个会话 —— 用户开着几个标签页、
 *     会话下还挂着后台子代理，只存当前这一个，其余的重启后就没有交接可续（本插件自己只复活
 *     发起重启的会话，其余会话的续跑完全靠这份交接）。
 *   · **完全 fail-soft** —— 服务不存在、接口形态不符（没有 `saveAll`/不是函数）、
 *     `ctx.get()` 抛错、`saveAll()` 抛错、服务返回 `ok:false`：一律只写**一行**日志，返回
 *     `{ok:false, text}`，**绝不阻断重启**（这条能力是附加价值，不是重启的前提）；
 *   · 结果会进工具返回文案（`text`），用户与模型都看得见"到底存了没有、存到哪了"。
 *
 * 调用时机（`execute` 里，两条拒绝路径之后、`writePendingFile` 与 `launchDriver` 之前）：
 *   · 放在拒绝路径之后 —— 那两条（拿不到归属会话 / 子代理发起）的语义是"一个字节都不写盘"，
 *     那时不该留下交接记录；"其它会话有活在跑"自 2026-09-28 起不再是拒绝路径，照常走到这里；
 *   · 放在启动驱动脚本之前、并且 **await 到保存完成** —— 保存是同步的（读内存历史 + 渲染 +
 *     写小文件，实测通常几毫秒，见 README §4；枚举 + 逐个保存会按会话数线性放大，仍是毫秒级），
 *     它只会让"发起重启"整体晚一点点，**不会挤占驱动脚本那 2 秒静默窗口**（那个窗口由驱动脚本
 *     从自己启动那一刻开始计时，只用来保证本次工具结果落盘）。顺序反过来（先起脚本再存）才会真的吃掉窗口。
 *   函数写成 `async` 是为了**将来**：服务哪天变成异步实现，`await` 依然保证"存完才往下走"，
 *   不会出现"保存还在飞、进程已经被杀"的静默丢失。
 *
 * ⚠ **服务形态变化**：`dsh-host-sl` v0.4.0 起提供 `saveAll`；v0.3.0 只有 `save`。
 *   本插件只认 `saveAll`（不退回 `save`）—— 退回就等于"只存当前会话"，那正是这次要改掉的行为；
 *   而"服务形态不符"本身是 fail-soft 的一条（只记一行日志、照常重启），不会把重启卡住。
 *
 * @param ctx cordis 上下文（用 ctx.get 可选读取服务，不依赖 inject）。
 * @param session 当前会话对象（`exec.agent.session`）—— 它的 id 作为 `noteSessionId`（形参保留，
 *   v0.7.0 的 dsh-host-sl 不读它），同时是"枚举不到活跃会话表"时服务侧的退路（只存这一个）。
 * @param log 写日志的函数（本插件的 appendLog 包装）。
 * @returns {Promise<{ok:boolean, files:string[], text:string}>} `files` = 成功写出的记录文件路径
 *   （多条会话 ⇒ 多个路径）；`text` = 给用户/模型看的一句话（成功是"存到哪了"，失败是原因）。
 */
export async function saveHandoffBeforeRestart(ctx, session, log) {
  let service
  try {
    service = typeof ctx.get === 'function' ? ctx.get(HANDOFF_SERVICE) : undefined
  } catch (error) {
    log(`读取 ${HANDOFF_SERVICE} 服务抛错,跳过重启前的交接保存,照常重启:${errText(error)}`)
    return { ok: false, files: [], text: `读取 ${HANDOFF_SERVICE} 服务抛错(${errText(error)})` }
  }
  if (service === undefined || service === null) {
    log(`未找到 ${HANDOFF_SERVICE} 服务(dsh-host-sl 未装载?),跳过重启前的交接保存,照常重启`)
    return { ok: false, files: [], text: `${HANDOFF_SERVICE} 服务不可用(dsh-host-sl 未装载?)` }
  }
  // 形态检查与调用放在同一个 try 里:取属性本身也可能抛(代理/getter),那样同样只该记一行日志
  try {
    const saveAll = service.saveAll
    if (typeof saveAll !== 'function') {
      log(`${HANDOFF_SERVICE} 服务没有 saveAll()(接口形态不符,dsh-host-sl 需要 v0.4.0+),跳过重启前的交接保存,照常重启`)
      return { ok: false, files: [], text: `${HANDOFF_SERVICE}.saveAll 不是函数(接口形态不符,需要 dsh-host-sl v0.4.0+)` }
    }
    // noteSessionId = 发起重启的**这个**会话(形参保留给 v0.7.0 之前的 dsh-host-sl;不传 note)
    const noteSessionId = typeof session?.id === 'string' ? session.id : ''
    // await 到保存完成才继续:服务是同步实现时立即返回,是异步实现时也等它落盘
    const result = await saveAll.call(service, { all: true, noteSessionId, session })
    const files = Array.isArray(result?.items)
      ? result.items.filter((item) => item?.ok === true && typeof item.file === 'string' && item.file.length > 0).map((item) => item.file)
      : []
    if (result?.ok === true) {
      const where = files.length > 0 ? files.join('、') : '(服务未回传记录路径)'
      log(`重启前已保存会话交接记录(${files.length} 个会话):${where}`)
      return { ok: true, files, text: where }
    }    // 失败:服务给的是**裸原因**(不带"未保存"前缀),这里补上重启语境
    const reason = typeof result?.message === 'string' && result.message.trim().length > 0
      ? result.message.trim()
      : '服务返回了 ok:false(无说明)'
    log(`重启前的交接保存未成功:${oneLine(reason)};照常重启`)
    return { ok: false, files, text: reason }
  } catch (error) {
    log(`调用 ${HANDOFF_SERVICE}.saveAll() 抛错,跳过重启前的交接保存,照常重启:${errText(error)}`)
    return { ok: false, files: [], text: `调用 ${HANDOFF_SERVICE}.saveAll() 抛错(${errText(error)})` }
  }
}

/**
 * 探测结论与**真实调用结果**不一致时的那行日志(v0.4.1,纯函数;一致时返回空串 = 不写)。
 *
 * 为什么要有它:探测(`probeHandoffOnce`)与真实调用(`saveHandoffBeforeRestart`)是两次独立的
 * `ctx.get` + 一次真实调用,两者理论上可能不一致(服务在这一瞬被卸载/刚挂上/形态漂移)。
 * 日志里出现自相矛盾的两行时,排障的人没法判断该信哪一行 —— 所以这里明说"以真实调用为准"。
 *
 * 三种探测结论 × 真实结果:
 *   · `present` + 真实成功 ⇒ 一致,不写;
 *   · `present` + 真实失败 ⇒ 写一行,带上真实失败原因(探测看到的是方法在不在,不是它能不能干活);
 *   · `absent` / `shape` / `error` + 真实成功 ⇒ 写一行,说明"探测那一刻的结论不可信"(服务刚挂上);
 *   · `absent` / `shape` / `error` + 真实失败 ⇒ 一致(都认为这次存不下来),不写。
 *
 * @param probe `probeHandoffOnce()` 的返回值:'present' | 'shape' | 'absent' | 'error' | 'unprobed'。
 * @param handoff `saveHandoffBeforeRestart` 的返回值。
 * @returns 要写进日志的一行(空串 = 不用写)。
 */
export function describeHandoffProbeMismatch(probe, handoff = { ok: false, files: [], text: '' }) {
  const saved = handoff?.ok === true
  if (probe === 'present') {
    return saved ? '' : `交接服务探测说"在场",但真实调用没成功 —— 以真实调用为准:${oneLine(handoff?.text)}`
  }
  if (probe === 'unprobed' || probe === undefined) return ''
  const said = probe === 'absent' ? '不在场' : (probe === 'shape' ? '接口形态不符' : '读取抛错')
  if (!saved) return ''
  const count = Array.isArray(handoff?.files) ? handoff.files.length : 0
  return `交接服务探测说"${said}",但真实调用成功了 —— 探测那一刻的结论不可信,以真实调用为准(本次已保存 ${count} 份)`
}

/** 把多行原因压成一行(工具返回文案里那一条不该被换行撑开)。 */
function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 一条交接记录条目的摘要形状(服务与"读文件"两条来源共用一份;v0.4.2)。
 *
 * `wake` = **恢复侧这次会不会唤醒它**:`done` 的条目不会(已经注入过),`active:false` 的也不会
 * (保存那一刻没有在飞的活,dsh-host-sl v0.5.1 起按设计不注入)。`active` 缺失(旧版标记没判过)
 * 按"有活"处理 —— 与 dsh-host-sl 的 `runResume` 同口径。
 * @returns {{sessionId:string, kind:string, done:boolean, active:(boolean|undefined), wake:boolean}}
 */
export function summarizeHandoffItem(item) {
  const done = item?.done === true
  const active = item?.active === false ? false : (item?.active === true ? true : undefined)
  return {
    sessionId: typeof item?.sessionId === 'string' ? item.sessionId : '',
    kind: item?.kind === 'subagent' ? 'subagent' : 'root',
    done,
    active,
    wake: !done && active !== false,
  }
}

/**
 * 把 `dsh-host-sl` 的待续标记折成条目摘要数组(v2 列表结构;v1 单会话标记按 **1 条**读)。
 *
 * 形态不符(不是对象 / 一条条目都没有 / 条目缺 `sessionId` / 条目不是对象)返回 `undefined`,
 * 由调用方按"读不到"处理 ⇒ 照旧自己注入(宁可多注入一条,也不能没人叫醒会话)。
 * 只看形状、不看 `version` —— 与 dsh-host-sl 的 `normalizePending` 同口径(新旧标记都读得进)。
 */
export function summarizeHandoffItems(pending) {
  if (pending === null || typeof pending !== 'object' || Array.isArray(pending)) return undefined
  const list = Array.isArray(pending.items)
    ? pending.items
    : (typeof pending.sessionId === 'string' && pending.sessionId.length > 0 ? [pending] : undefined)
  if (list === undefined) return undefined
  const items = []
  for (const item of list) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
    if (typeof item.sessionId !== 'string' || item.sessionId.length === 0) return undefined
    items.push(summarizeHandoffItem(item))
  }
  return items
}

/**
 * 读「dsh-host-sl 的待续标记」摘要 —— **两条来源,按优先级**(v0.4.2 的取数顺序):
 *   ① `ctx.get('slHandoff')` 上的只读方法 `pendingSummary()`(dsh-host-sl v0.6.0 起提供;
 *      **旧版没有这个方法** ⇒ `typeof !== 'function'` 就往下走);
 *   ② 退回直接读默认路径 `<DSH_HOME>\storages\sl-handoff\pending.json`(`resolved.handoffPendingFile`,
 *      只读,绝不写);
 *   ③ 两条都拿不到 ⇒ `{exists:false, reason, items:[], source:'none'}`,调用方**照旧自己注入**。
 *
 * 为什么服务优先:它读的是**同一个落点**,但 v1 兼容与字段语义都在对方那边维护(normalizePending);
 * 文件那条退路只是"对方是旧版 / 服务还没挂上"时的兜底,免得瞎猜。
 *
 * 全程 fail-soft:**从不抛**。任何一步失败只写一行日志(说明为什么退到下一条来源),
 * 因为这条判断的失败代价不对称 —— 误判成"有人接手"会让会话没人叫醒,误判成"没人接手"
 * 只是多注入一条消息(兜底复查还会再看一次)。
 *
 * @returns {{exists:boolean, reason:string, items:Array, source:'service'|'file'|'none'}}
 */
export function readHandoffPendingSummary(ctx, resolved, log) {
  // ① 服务上的 pendingSummary()(只读方法,见 dsh-host-sl README「命令与服务契约」)
  let service
  try {
    service = typeof ctx.get === 'function' ? ctx.get(HANDOFF_SERVICE) : undefined
  } catch (error) {
    service = undefined
    log(`读交接记录的待续标记:读 ${HANDOFF_SERVICE} 服务抛错(${errText(error)}),改读文件 ${resolved.handoffPendingFile}`)
  }
  if (service === undefined || service === null) {
    log(`读交接记录的待续标记:${HANDOFF_SERVICE} 服务不在场,改读文件 ${resolved.handoffPendingFile}`)
  } else {
    let method
    try {
      method = service.pendingSummary
    } catch (error) {
      method = undefined
      log(`读交接记录的待续标记:取 ${HANDOFF_SERVICE}.pendingSummary 抛错(${errText(error)}),改读文件`)
    }
    if (typeof method === 'function') {
      let summary
      try {
        summary = method.call(service)
      } catch (error) {
        summary = undefined
        log(`读交接记录的待续标记:调用 ${HANDOFF_SERVICE}.pendingSummary() 抛错(${errText(error)}),改读文件`)
      }
      if (summary !== null && typeof summary === 'object' && Array.isArray(summary.items)) {
        return {
          exists: summary.exists === true,
          reason: typeof summary.reason === 'string' ? summary.reason : '',
          items: summary.items.filter((item) => item !== null && typeof item === 'object' && typeof item.sessionId === 'string'),
          source: 'service',
        }
      }
      if (summary !== undefined) {
        log(`读交接记录的待续标记:${HANDOFF_SERVICE}.pendingSummary() 的返回值形态不符(${typeof summary}),改读文件`)
      }
    } else {
      log(`读交接记录的待续标记:${HANDOFF_SERVICE} 没有 pendingSummary()(旧版 dsh-host-sl),改读文件`)
    }
  }

  // ② 退回读文件(与 dsh-host-sl 的默认落点同一个文件)
  const raw = readPendingFile(resolved.handoffPendingFile)
  if (raw === undefined) {
    return {
      exists: false,
      reason: `没有可用的待续标记(${HANDOFF_SERVICE} 未提供 pendingSummary,且 ${resolved.handoffPendingFile} 不存在或读不出)`,
      items: [],
      source: 'none',
    }
  }
  const items = summarizeHandoffItems(raw)
  if (items === undefined) {
    return { exists: false, reason: `待续标记形态不符(${resolved.handoffPendingFile})`, items: [], source: 'file' }
  }
  return { exists: true, reason: '', items, source: 'file' }
}

/**
 * 摘要里有没有**本会话尚未处理**的条目 —— 有就意味着"有人会接手本次注入"(v0.4.2)。
 *
 * 判据只有两条:`sessionId` 相等、`done !== true`。
 * ⚠ **`active` 不参与这条判断**:空闲条目(`active:false`,保存那一刻没有在飞的活)同样会被
 *   dsh-host-sl 处理掉并归档,所以它一样意味着"有人接手",不该因为它是空闲的就让本插件再插一条
 *   (那正是这次要合并掉的第二条消息)。
 * @returns 命中的条目摘要,没有则 `undefined`。
 */
export function findUnhandledHandoffItem(summary, sessionId) {
  if (summary === null || typeof summary !== 'object' || summary.exists !== true) return undefined
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  if (!Array.isArray(summary.items)) return undefined
  return summary.items.find((item) => item?.sessionId === sessionId && item.done !== true)
}

/**
 * 兜底注入(v0.4.2):"让位给交接记录"之后延迟复查一次,**对方没接手就自己补一条**。
 *
 * 为什么必须有它:让位的前提是"dsh-host-sl 会注入",而它会**让位**(闸门① 别的顶层会话正在跑一轮)
 * 或**失败**(sessionController 等不到、目标会话不可恢复)—— 那些时候标记原样保留、谁都不注入,
 * 会话就没人叫醒。所以这里复查两件事,**两件都成立才补注入**:
 *   ① 标记里**仍有**本会话的未处理条目(= 对方没接手;若已被对方移除/整份归档 ⇒ 什么都不做);
 *   ② 本会话 `status !== 'running'`(对方已经把它排进下一轮 ⇒ 别再插一条,免得两条消息都到)。
 *
 * 全程 fail-soft:复查本身失败、注入抛错都只写一行日志,绝不抛回宿主。
 * @returns {{injected:boolean, reason:string}} 只用于日志/测试断言,不影响任何流程。
 */
export async function runHandoffFallback(ctx, resolved, log, isDisposed, sessionId, text, agent) {
  if (typeof isDisposed === 'function' && isDisposed()) {
    log('交接记录复查:插件已卸载,兜底注入跳过')
    return { injected: false, reason: '插件已卸载' }
  }
  const summary = readHandoffPendingSummary(ctx, resolved, log)
  if (findUnhandledHandoffItem(summary, sessionId) === undefined) {
    log(`交接记录复查:待续标记里已没有本会话 ${sessionId} 的未处理条目(dsh-host-sl 已接手),兜底注入跳过`)
    return { injected: false, reason: '标记里已无本会话条目' }
  }
  const status = agent?.status
  if (status === 'running') {
    log(`交接记录复查:标记里仍有本会话 ${sessionId} 的未处理条目,但本会话已在 running ⇒ 兜底注入跳过(不插话)`)
    return { injected: false, reason: '本会话已在 running' }
  }
  const why = `复查时标记里仍有本会话的未处理条目,且 status=${typeof status === 'string' ? status : '(未知)'} 不是 running`
  if (agent === undefined || agent === null || typeof agent.followup !== 'function') {
    log(`交接记录没接手(${why}),但拿不到可注入的 agent(followup 不可用),兜底注入失败`)
    return { injected: false, reason: 'agent 不可用' }
  }
  try {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
  } catch (error) {
    log(`交接记录没接手(${why}),自己兜底注入失败:${errText(error)}`)
    return { injected: false, reason: `兜底注入抛错:${errText(error)}` }
  }
  log(`交接记录没接手(${why}),自己兜底注入「已重启」`)
  return { injected: true, reason: '交接记录没接手' }
}

/**
 * 交接保存结果那一行（工具返回文案里的一行；成功写清"存到哪了"，失败写清原因）。
 * 重启**失败**的路径也带上它 —— 那时交接可能已经存下来了，用户该知道（README §4 有这条残留说明）。
 */
function handoffLine(handoff = { ok: false, files: [], text: '' }) {
  return handoff.ok
    ? `重启前已保存会话交接记录:${handoff.files.length > 0 ? handoff.files.join('、') : '(服务未回传记录路径)'}`
      + '(新进程启动时会由 dsh-host-sl 注入回本会话)。'
    : `重启前的会话交接未保存:${handoff.text}(不影响本次重启)。`
}

/**
 * 「本次会打断谁」那一段（工具返回文案里；没有在飞的活就整段省略）。
 * ⚠ 必须在 `saveHandoffBeforeRestart` **之后**调用 —— 这段要用保存结果，不许在没存下时谎称"已存"。
 * @param detected detectRunningSessions 的返回值（含 available:false 的形态）。
 * @param handoff saveHandoffBeforeRestart 的结果。
 */
function interruptedLine(detected, handoff) {
  if (detected === undefined || detected === null) return ''
  if (detected.available !== true) {
    // 检测不到也要说实话:不假装"没有别的会话",只说"说不清会打断谁"
    return `本次没能读到宿主会话表(${oneLine(detected.reason)}),无法提前说明会打断哪些会话;`
      + '若此刻还有别的会话或子代理在跑,它们会一起被硬杀。'
  }
  return formatInterruptedNotice(detected, handoff)
}

/** 组装工具结果文本(模型看到的就是这段)。 */
function successMessage(launched, waitSeconds, resolved, instance = {}, handoff = { ok: false, files: [], text: '' }, detected) {
  // 把身份写进结果:用户与模型都能立刻看到"杀的是哪一个实例",不必翻日志
  const who = [
    instance.pid !== undefined ? `pid=${instance.pid}` : undefined,
    instance.profile !== undefined ? `profile=${instance.profile}` : undefined,
    instance.port !== undefined ? `port=${instance.port}` : undefined,
  ].filter((part) => part !== undefined).join(', ')
  return [
    `重启已发起:驱动脚本(pid=${launched.pid},${launched.mode} 通道)将在约 ${waitSeconds} 秒后终止本实例的 dsh 后端(${who.length > 0 ? who : `pid=${process.pid}`}),`,
    '常驻看门狗随即拉起新进程;新进程就绪后会自动向本会话注入一条续跑消息(交接记录在场时由它那条接手,只会注入一条),整轮约 20~40 秒。',
    handoffLine(handoff),
    interruptedLine(detected, handoff),
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
  log(`apply: v${VERSION} pendingFile=${resolved.pendingFile} script=${resolved.restartScript} wait=${resolved.waitSeconds}s(固定)`
    + ` handoff=${HANDOFF_SERVICE}(可选,不进 inject)`)
  // 交接服务在不在:**apply 时不再探测**(v0.4.1,理由见文件头那段 ⚠)。旧版在这里 ctx.get 一次并
  // 打一行"服务不在场(dsh-host-sl 未装载?)" —— 那一刻同进程的 dsh-host-sl 还没把服务挂上,
  // 所以**必是假阴性**,而 README §5 还把这行当排障线索。改成惰性探测:首次工具调用时探一次。
  // 探测结果只用于日志(工具行为由 saveHandoffBeforeRestart 自己的 fail-soft 决定,一个字节都没变)。
  let handoffProbe = 'unprobed'
  /** 探测一次并写一行日志(只探一次);返回 'present' | 'shape' | 'absent' | 'error'。 */
  const probeHandoffOnce = () => {
    if (handoffProbe !== 'unprobed') return handoffProbe
    try {
      const service = typeof ctx.get === 'function' ? ctx.get(HANDOFF_SERVICE) : undefined
      if (service === undefined || service === null) {
        handoffProbe = 'absent'
        log(`重启前的交接保存:${HANDOFF_SERVICE} 服务不在场(dsh-host-sl 未装载?),工具照常可用(首次工具调用时探测)`)
      } else if (typeof service.saveAll === 'function') {
        handoffProbe = 'present'
        log(`重启前的交接保存:${HANDOFF_SERVICE} 服务在场(首次工具调用时探测)`)
      } else {
        // 在场但形态不符:旧版 dsh-host-sl(≤v0.3.0)只有 save、没有 saveAll —— 与"没装"是两回事
        handoffProbe = 'shape'
        log(`重启前的交接保存:${HANDOFF_SERVICE} 服务在场但没有 saveAll()(接口形态不符,dsh-host-sl 需要 v0.4.0+),工具照常可用(首次工具调用时探测)`)
      }
    } catch (error) {
      handoffProbe = 'error'
      log(`探测 ${HANDOFF_SERVICE} 服务抛错(不影响工具可用,首次工具调用时探测):${errText(error)}`)
    }
    return handoffProbe
  }

  // 本实例身份:重启只允许杀命中它的 dsh 进程。三件套都取自本进程 argv,所以目标进程的
  // 命令行里必然带同样的 token ⇒ 脚本侧正向校验不会假阴性(见启动命令行里的 -DshPid 等)。
  const instance = resolveInstanceIdentity()
  log(`实例身份: pid=${instance.pid ?? '?'} profile=${instance.profile ?? '(未识别)'} port=${instance.port ?? '(未识别)'}`)
  if (instance.profile === undefined && instance.port === undefined) {
    log('警告:argv 里既没有 profile 也没有 --port,身份判据只剩 pid;跨 profile 场景请人工确认。')
  }

  let disposed = false
  const isDisposed = () => disposed

  /**
   * v0.4.2 兜底复查的定时器:排一个延迟任务并返回 disposer。
   * timer 已在 inject 里声明;拿不到时退到全局 setTimeout(与启动注入那条路同款兜底)。
   * 排出来的 disposer 收在 `cancelRecheck` 里,由下面的 `ctx.effect` 在插件卸载时回收。
   */
  let cancelRecheck = null
  const scheduleRecheck = (fn, ms) => {
    try {
      cancelRecheck = ctx.timeout(fn, ms)
    } catch (error) {
      log(`ctx.timeout 不可用(${errText(error)}),回退全局 setTimeout`)
      const timer = setTimeout(fn, ms)
      cancelRecheck = () => clearTimeout(timer)
    }
    return cancelRecheck
  }

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
          'immediately: after a fixed 2-second grace (enough for this turn\'s tool result to reach disk) the driver kills',
          'the current dsh, lets the resident watchdog start a fresh one, and once the new process boots this plugin resumes',
          'THIS session and injects a continuation user message, so the conversation continues automatically without user action.',
          'Exactly ONE message is injected, and its text is fixed (no arguments to this tool can change it): when a dsh-host-sl',
          'handoff record with an unhandled entry for this session is pending, that plugin\'s own injection takes over, and this',
          'plugin only falls back with its own fixed message about 10 seconds later if the handoff did not take over and the',
          'session is not running.',
          'Before launching the driver it also asks the optional dsh-host-sl cordis service `slHandoff` to refresh its active-session',
          'work sheet, so those sessions can be woken up again; the outcome - saved, with the file path, or not saved, with the',
          'reason - is reported in this tool\'s output, and a missing or failing handoff service never blocks the restart.',
          'The current turn ends when the process dies, so finish your reply right after calling this tool and do not call',
          'further tools; already-persisted output is kept, anything still streaming is lost. Expect roughly 20-40 seconds',
          'before the injected message appears. All tabs/windows of this Web GUI share ONE host process, while only the',
          'calling session is resumed by this plugin in the new process. This call is NEVER refused: when it detects other',
          'sessions that still have work in flight (their own turn running, a running subagent they own, or an unsettled',
          'background job they own) it names them - with the reason and the session id - in this tool\'s output and restarts',
          'anyway, hard-killing that work. Their handoff records, when the handoff service saved them, are injected back',
          'after the restart so those sessions resume on their own; the single tool call that was in flight is lost either',
          'way. The same paragraph also reports subagents running under the calling session itself.',
          'Use it only when the user explicitly asks to restart dsh, for example after',
          'changing host-plugin code or a cordis patch that only takes effect on a process restart. It terminates only THIS',
          'dsh instance (the process serving this session), identified by its pid/profile/port - other profiles\' instances',
          'running on the same machine are left untouched.',
        ].join(' '),
        // 本工具**没有任何参数**(v0.5.0)。parameters 必须写成空对象 —— defineTool 不接受省略该字段
        // ("parameters must be an object of value schemas"),空对象编译成 {type:'object',properties:{}}。
        // 沿革:wait_seconds 于 2026-09-27 删除(等待固定成 WAIT_SECONDS);note 于 2026-09-29 删除
        // (注入文案固定成 DEFAULT_INJECT_TEXT,调用方再也改不了注入内容)。
        // 注意:value-schema DSL 的 required 只接受 true —— 将来若加可选参数,必须**省略**该字段,
        // 写 required:false 会让 defineTool 直接抛(0.1.0 实测)。
        parameters: {},
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
          // ── 检测:还有别的会话有活在跑 —— 只如实告知,不拒绝(2026-09-28 用户要求)──────
          // 口径三条(自己在本轮 / 名下有子代理在跑 / 名下有未结算作业)见 detectRunningSessions。
          // 旧版在这里 return {ok:false}:现在改成继续往下走 —— 检测结果只进日志与返回文案,
          // 由调用方自己判断要不要现在重启(README §4 写了这么改的理由与代价)。
          // 检测本身也兜一层 try:检测再怎样都不该让重启工具变成"调用即报错"。
          let detected
          try {
            detected = detectRunningSessions(ctx, sessionId)
          } catch (error) {
            detected = { available: false, reason: `会话检测异常(${errText(error)})` }
          }
          if (detected.available) {
            const summary = detected.others.map((other) => `${other.id}(${other.reasons.join('+')})`).join(', ')
            log(`会话检测: 顶层会话 ${detected.total} 个(本轮运行 ${detected.running} 个), 其它有活在跑 ${detected.others.length} 个${summary.length > 0 ? `: ${summary}` : ''}`)
            if (detected.others.length > 0) {
              // 不再拒绝:把"会被打断谁"记清楚,然后照常重启(返回文案里还会再说一遍)
              log(`其它会话有活在跑(${detected.others.length} 个),不再拒绝:照常重启,它们会被硬杀;`
                + '交接记录与返回文案里如实说明')
            }
          } else {
            // fail-soft:检测不到也要照常重启,并且不许假装"没有别的会话"
            log(`无法检测其它会话(${detected.reason}),按无其它会话处理,照常重启`)
          }
          // ── 重启前顺手保存会话交接记录(可选服务,完全 fail-soft)────────────────
          // 位置:两条拒绝路径之后、writePendingFile 与 launchDriver **之前**,
          // 并且 await 到保存完成 —— 这样保存耗时不会挤占驱动脚本那 2 秒静默窗口
          // (窗口由脚本自己从启动那一刻开始计时,只用来保证本次工具结果落盘)。
          // 服务由 dsh-host-sl 提供;它缺席/抛错都只写一行日志,绝不阻断重启。
          // v0.4.1:交接服务的"在不在"在这里探测(首次工具调用,那时服务一定可见) ——
          // apply 时探测必是假阴性,见文件头 ⚠ v0.4.1 与 probeHandoffOnce。
          const handoffProbeSeen = probeHandoffOnce()
          const handoff = await saveHandoffBeforeRestart(ctx, session, log)
          // 探测结论与真实调用结果不一致时如实区分(以真实调用为准),别让日志自相矛盾
          const probeMismatch = describeHandoffProbeMismatch(handoffProbeSeen, handoff)
          if (probeMismatch.length > 0) log(probeMismatch)
          // 等待固定,不接受调用方覆盖(参数已删):见文件头"为什么等待固定成 2s"
          const waitSeconds = WAIT_SECONDS
          const record = {
            version: 1,
            sessionId,
            text: buildInjectText(),
            createdAt: Date.now(),
            waitSeconds,
            pidBefore: process.pid,
            cwd: session?.header?.cwd,
          }
          try {
            writePendingFile(resolved.pendingFile, record)
          } catch (error) {
            log(`写重启标记失败:${errText(error)}`)
            // 交接可能已经存下来了(它在写标记之前) —— 如实说出来,别让用户以为"什么都没发生"
            return { ok: false, message: `restart_dsh 未执行:写重启标记失败 —— ${errText(error)} ${handoffLine(handoff)}` }
          }
          let launched
          try {
            launched = await launchDriver(resolved, sessionId, waitSeconds, log, instance)
          } catch (error) {
            try { unlinkSync(resolved.pendingFile) } catch { /* 不存在 */ }
            log(`启动驱动脚本失败,已撤销重启标记:${errText(error)}`)
            return {
              ok: false,
              handoff: { ok: handoff.ok, files: handoff.files },
              message: `restart_dsh 未执行:驱动脚本启动失败(${errText(error)}),本次没有重启;标记已撤销。${handoffLine(handoff)}`,
            }
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
            handoff: { ok: handoff.ok, files: handoff.files },
            message: successMessage(launched, waitSeconds, resolved, instance, handoff, detected),
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
  // v0.4.2:返回 promise 是为了让用例能 await 到这次注入结束(真宿主不看返回值,无副作用)。
  const runInject = () => runInjection(ctx, resolved, log, isDisposed, scheduleRecheck).catch((error) => {
    log(`注入流程异常:${errText(error)}`)
  })
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
  // **唯一登记处** = `ctx.effect(() => 返回清理函数)`:返回值被登记进当前 fiber,卸载时自动执行
  // (cordis `lib/index.js` 的 `_execute` → `runner.collect`;同 profile 的 dsh-host-sl 也这么写)。
  // ⚠ **不许用 `ctx.on('dispose', …)`**:本机 cordis 卸载时发的是 `internal/plugin`,**根本没有
  //   `dispose` 事件** —— 此前那处就是这么写的,于是这段清理**从来没执行过**(`tools.register`
  //   返回的 disposer 没被调用、「启动注入」与「兜底复查」两个定时器都没被取消)。2026-09-29 修:
  //   全包只剩下面这一处登记,原先"只处理 disposed/cancelRecheck"的那段 effect 已合并进来,
  //   不留第二处重复登记;除「卸载时真的清理」外,运行时行为一个字节没变。
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        disposed = true
        try { cancelBoot?.() } catch { /* 已触发 */ }
        try { cancelRecheck?.() } catch { /* 已触发 */ }
        if (typeof disposeTool === 'function') {
          try { disposeTool() } catch { /* 已回收 */ }
          disposeTool = null
        }
        log('dispose:已回收工具注册、启动注入与兜底复查定时器')
      }, 'restart-dsh: cleanup')
    } else {
      log('ctx.effect 不可用,卸载清理未登记(工具注册与两个定时器到期后自行结束)')
    }
  } catch (error) {
    log(`ctx.effect 登记卸载清理失败(${errText(error)}),工具注册与两个定时器到期后自行结束`)
  }
}
