# DSH 重启驱动脚本(由 dsh-host-restart 插件用 WMI 启动)
#
# 看门狗(`dsh-watchdog.js` + 它的 `dsh-watchdog.vbs` 启动器)是**可选件,不随本仓库发布**:
#   有它就换手交给它拉起、没有就由本脚本自行拉起 dsh(见下面「流程」的降级分支),
#   两种情形语义自洽 —— 缺看门狗只是少了"冷启动门户 + 按需接管",重启照常完成。
#
# 为什么不能直接用 dsh 的 pwsh 工具跑本脚本:
#   dsh 的 pwsh 工具走 dsh-subprocess-local(Windows 上 detached:false + taskkill 树级清理),
#   脚本会随 dsh 一起被清理,重启的后半段(拉起 + 等待就绪)根本不会发生。
#   插件用 Win32_Process.Create 启动本脚本,父进程是 WmiPrvSE.exe,与 dsh 进程树无关。
#
# 流程(2026-09-24 起:重启不再依赖看门狗 —— 看门狗只保留"冷启动门户 + 按需拉起"的职责):
#   等静默 → 杀本实例 dsh → **先探测看门狗进程是否在跑**(判据见 Get-LiveWatchdogProcess):
#     · 在 ⇒ 换手(先杀旧、再起新,让新实例用当前 DSH_ENTRY 拉起 dsh)
#            → 等它回门户(它判定端口空闲需约 15s)→ 发请求触发拉起 → 轮询管理端口 3081 等就绪
#     · 不在 ⇒ **不再盲等 25s 门户**,立即自行拉起 dsh(步骤 3.5):绝对路径 node +
#              Start-Process 重定向 stdout/stderr 到文件 → 端口可应答 **且** 能从输出文件里
#              抓到 `dsh web: <带 token URL>` 才算就绪;失败最多重试 3 次,每次写清原因
#              → 就绪后把带 token 的 URL 覆盖写入 dsh-last-url.txt
#              → 最后尽力起回一个看门狗接管这个 dsh(失败只记日志,不影响"重启已成功")
#   降级:看门狗在但换手失败 / 门户在 DoorWaitSeconds 内没回来 → 同样转入自行拉起(步骤 3.5);
#         换手前若 dsh 又冒出来且杀不掉 → 放弃换手,保留旧看门狗(见步骤 2.5)。
#
# 桌面端(Electron,2026-09-30 起 -Mode desktop;本机 DSH 已于 2026-09-30 切到官方桌面端):
#   形态与 web 完全不同 —— Electron **主进程** `DeepSeek Harness.exe`(命令行无 --type=)fork 出
#   后端 Host 子进程(同一个 exe,Electron 的 Node 模式,命令行含 --expose-internals 与
#   `dsh-desktop-host\lib\index.js`),Host 监听 127.0.0.1:19387。主进程把 Host 当子进程管
#   (`DesktopHostProcess`),**Host 一死主进程就走"崩溃恢复"弹原生对话框** —— 那条路要人点,
#   不能当自动化用 ⇒ 桌面端只有一种可行语义:**整树重启**。
#   桌面端分支与 web 分支的三处差别:
#     · 身份 = **pid + exe 路径**(没有 profile/端口判据):插件把 process.execPath 作为
#       -DesktopExe 传进来;主进程与全部子进程(GPU/渲染/网络/后端 Host/runner)共用同一个 exe
#       ⇒ 按 exe 路径扫一遍就是整棵树。**只杀同一安装路径的应用**(用户 2026-09-30 选定),
#       别的安装位置/dev 版不受影响。
#       ⚠ 插件注入的 pid 是**后端 Host** 的 pid(不是 Electron 主进程!)⇒ pid 校验只要求
#         "同一棵树"(Test-DesktopTreeMember),**不能**要求它是主进程 —— 第一版这么写过,
#         真机验收时被判 fail closed(2026-09-30)。对不上才退出 4。
#     · **先杀旧、后起新**:Electron 有单实例锁(requestSingleInstanceLock,第二实例会把已有
#       窗口聚焦后自杀),所以必须等旧进程全部退出、锁释放,才 Start-Process 冷启动 exe。
#     · 就绪判据 = **端口可应答 + 主进程在**(默认 19387,插件按 Host 真实端口传 -Port);
#       不再有看门狗换手、不再有"等门户"、不写 dsh-last-url.txt(桌面端没有 token URL)。
#   自起通道已实测:WMI 创建的 pwsh 里 Start-Process 起的 GUI 进程**能正常显示窗口**
#   (2026-09-30 用 notepad 做过对照:WMI 创建的 notepad 主窗口句柄非 0)。
#   演练开关 -DesktopDryRun:只做身份校验并打印将执行的命令,**不杀任何进程、不启动任何东西**
#   —— 离线自测用(web 那套 -SelfLaunchTest 只管 web 分支,管不到这里)。
#
# 「杀哪一个 dsh」的判据(2026-09-21 收紧):
#   本实例身份 = -DshPid(发起重启的宿主 pid,插件注入)+ -ProfileName + -Port,三者都来自
#   插件宿主自己的 argv ⇒ 目标进程的命令行里必然带同样的 token,正向校验不会假阴性。
#   profile 名是 dsh 的**位置参数**(`dsh web …` 等价 `dsh --profile web`),所以旧判据
#   "命令行含 dsh\lib\bin.js 且含 web"是跨实例的:从 teamlab 实例(--port 3090)发起重启
#   会杀掉 web 实例(3080)。现在:精确 pid 校验优先 → 退按 profile+端口扫描 → 仍确定不了
#   就 fail closed(退出码 4,一个进程都不杀)。也绝不再调用 kill_dsh.bat(同款跨实例判据)。
#
# 日志:<日志目录>\dsh-restart.log(与插件共用,超过 1MB 截断保留尾部;
#   默认落点见 -LogFile,即 <DSH_HOME>\tools,<DSH_HOME> 未设时用 ~\.dsh)
# 自行拉起相关文件(默认与 -LogFile 同目录,可用 -SelfLaunchLogDir / -LastUrlFile 覆盖):
#   dsh-selflaunch-out.log / dsh-selflaunch-err.log = 自起 dsh 的 stdout/stderr(每轮**覆盖写**)
#   dsh-last-url.txt = 最近一次自起 dsh 的**带 token 完整 URL**(覆盖写,只保留最近一次;
#                      用途:用户清 cookie / 换浏览器时取一次)。重启日志里只记"已取得带 token 的 URL",
#                      不留 token 明文 —— 与看门狗"写盘前脱敏"的口径一致。
# 退出码:0=新 dsh 已就绪;1=前置失败;2=就绪超时或 dsh 未被杀掉;3=已有驱动实例在运行;
#         4=无法确定本实例身份(或 pid 校验不符),拒绝杀任何进程
#
# 演练开关:-SelfLaunchTest(或环境变量 DSH_RESTART_SELFLAUNCH_TEST=1)+ -TestDshEntry <假 dsh 脚本>,
#   端口限定 39000-39999。语义:不杀任何真实进程、跳过看门狗换手与回归、强制走自行拉起分支、
#   用假 dsh 替代真实入口。**默认(不开开关)行为与生产完全一致。**
#
# 语法保持 PowerShell 5.1 兼容(插件先试 pwsh,失败回退 powershell.exe),故不使用 ??/三元等 7.x 专有语法。
# 2026-09-30 新增桌面端参数:见文件头「桌面端」一节的 -Mode/-DesktopExe/-DesktopDryRun 与
# -DesktopLaunchAttempts/-DesktopRetryDelaySeconds/-DesktopReadySeconds(均有默认值,web 调用方不受影响)。

[CmdletBinding()]
param(
    [string]$SessionId = '',
    [int]$WaitSeconds = 6,
    [int]$DoorWaitSeconds = 25,
    [int]$ReadyWaitSeconds = 60,
    # ↓ 本实例身份(由插件从宿主自己的 argv 读出后注入)。缺哪个就少一条判据,
    #   三个都缺 ⇒ 直接退出 4,不杀任何进程。
    [int]$DshPid = 0,
    [string]$ProfileName = '',
    # 操作端口(门户/就绪探测)。只有**显式传入**时才同时当作身份判据:默认值不能当身份,
    # 否则 3080 会把别的实例认成自己。
    [int]$Port = 3080,
    # 已废弃:kill_dsh.bat 的判据跨实例(见文件头)。保留形参只为兼容旧调用方,显式传入只记一行日志。
    [string]$KillScript = '',
    # 重启标记(插件写,含 pidBefore = 发起重启的宿主 pid)。旧版插件不传身份参数时靠它兜底。
    [string]$PendingFile = '',
    # ↓ 运行模式(2026-09-30 加):'web' = 原行为(node 宿主 + 看门狗/自起);'desktop' = Electron 桌面端
    #   (杀整棵同 exe 进程树 + 冷启动应用)。插件按自己是不是桌面端 Host 决定传不传。
    [string]$Mode = 'web',
    # 桌面端应用 exe 的完整路径(插件从 process.execPath 取)。桌面模式下**必填** ——
    #   缺了它无法确定"杀哪一棵树",脚本直接退出 4(绝不退化成"凡同名进程都杀")。
    [string]$DesktopExe = '',
    # 桌面端演练开关:只校验身份并打印将执行的命令,不杀任何进程、不启动任何东西。
    [switch]$DesktopDryRun,
    # dsh 入口脚本的默认落点:用 $env:APPDATA 推导(不写死用户名)。
    #   ⚠ 参数默认值是**绑定期求值**,那时脚本体内的函数还不存在 ⇒ 只能用 $(...) 内联表达式。
    [string]$DshEntry = (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'),
    [string]$NodeExe = 'node',
    # 默认与插件默认落点一致(<DSH_HOME>\tools\dsh-restart.log;DSH_HOME 未设时用 ~\.dsh)。
    # 同样必须是绑定期可求值的表达式,不能调脚本里的函数。$LogDir 由本参数派生 ⇒ 自动跟随。
    [string]$LogFile = (Join-Path $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }) 'tools\dsh-restart.log'),
    # ↓ 自行拉起(看门狗不在时的**主路径**,2026-09-24 起不再是"降级")。参数都有默认值,
    #   旧调用方(插件)不传也照常工作。
    [int]$SelfLaunchAttempts = 3,            # 最多尝试几次(1~5 有意义;每次失败都会写清原因)
    [int]$SelfLaunchReadySeconds = 12,       # 单轮就绪超时:生产实测 dsh 从 spawn 到打印带 token 的 URL 需 4.1~5.3s
    [int]$SelfLaunchRetryDelaySeconds = 2,   # 两轮之间的间隔
    [string]$SelfLaunchLogDir = '',          # 自起 dsh 的输出目录(默认与 -LogFile 同目录)
    [string]$LastUrlFile = '',               # 带 token 的 URL 覆盖落盘位置(默认与 -LogFile 同目录)
    # ↓ 桌面端冷启动的重试/超时(2026-09-30)。默认值取自本机实测:桌面端冷启动到 19387 可应答
    #   约 5~10 秒;60 秒总期限留足余量(首次启动要建 GPU 缓存/加载插件)。
    [int]$DesktopLaunchAttempts = 2,
    [int]$DesktopRetryDelaySeconds = 3,
    [int]$DesktopReadySeconds = 60,
    # ↓ 演练开关(默认关闭 ⇒ 行为与生产完全一致)。语义见文件头;端口必须落在 39000-39999。
    [switch]$SelfLaunchTest,
    [string]$TestDshEntry = ''               # 演练用的假 dsh 脚本(仅 -SelfLaunchTest 生效)
)

$ErrorActionPreference = 'Continue'
# 运行模式:只认这两个值(fail loud —— 拼错的模式名不许静默按 web 跑,那会去杀 node 宿主)
if ($Mode -ne 'web' -and $Mode -ne 'desktop') {
    Write-Host ('未知的 -Mode "' + $Mode + '"(只认 web / desktop),本实例不做事,退出 1。')
    exit 1
}
$LogMaxBytes = 1MB
# 身份端口:只认显式给出的 -Port(或稍后从目标进程命令行里读到的那个),不认默认值
$portExplicit = $PSBoundParameters.ContainsKey('Port')
$identityPort = 0
if ($portExplicit) { $identityPort = $Port }

# ── 与"自行拉起"相关的派生路径(默认全部落在 -LogFile 同目录 ⇒ 默认即 <DSH_HOME>\tools)──────
$LogDir = Split-Path -Parent $LogFile
if (-not $LogDir) { $LogDir = '.' }
if ($SelfLaunchLogDir -eq '') { $SelfLaunchLogDir = $LogDir }
$SelfLaunchOutFile = Join-Path $SelfLaunchLogDir 'dsh-selflaunch-out.log'
$SelfLaunchErrFile = Join-Path $SelfLaunchLogDir 'dsh-selflaunch-err.log'
if ($LastUrlFile -eq '') { $LastUrlFile = Join-Path $LogDir 'dsh-last-url.txt' }
$WatchdogScript = Join-Path $LogDir 'dsh-watchdog.js'
$WatchdogPidFile = Join-Path $LogDir 'dsh-watchdog.pid'
# 自起 dsh 走绝对路径 node:本脚本由 WMI 启动,宿主(WmiPrvSE)拿的是**服务环境**,裸 node 只靠机级
# PATH 才解析得出(隔离实验实测能解析但不可靠);绝对路径不受环境影响。
$NodeExeAbs = 'C:\Program Files\nodejs\node.exe'

function Write-RestartLog {
    param([string]$Message)
    $line = '{0}  [ps1] {1}' -f (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffzzz'), $Message
    try {
        if (Test-Path -LiteralPath $LogFile) {
            $info = Get-Item -LiteralPath $LogFile -ErrorAction Stop
            if ($info.Length -gt $LogMaxBytes) {
                $tail = @(Get-Content -LiteralPath $LogFile -Tail 200 -ErrorAction SilentlyContinue)
                Set-Content -LiteralPath $LogFile -Value $tail -Encoding utf8 -ErrorAction SilentlyContinue
            }
        }
        Add-Content -LiteralPath $LogFile -Value $line -Encoding utf8 -ErrorAction SilentlyContinue
    } catch { }
    Write-Host $line
}

# ── 桌面端(Electron)判据 ──────────────────────────────────────────────────
# 「这条命令行是不是那个 exe」——把命令行开头的可执行文件路径取出来,剥引号、统一分隔符、转小写后比较
# (Windows 路径大小写不敏感)。与插件 lib/index.js 的 normalizeExePath 是同一套规则(JS 镜像)。
# 只处理"带引号"与"取到第一个空格"两种形态:没有引号且路径含空格时无法可靠切分 —— 本机真实命令行
# **总是带引号**(实测),而拿不准时调用方是 fail closed。
function Get-CommandLineExePath {
    param([string]$CommandLine)
    if (-not $CommandLine) { return '' }
    $line = $CommandLine.Trim()
    if ($line.Length -eq 0) { return '' }
    # 裸路径(直接给的 exe 路径,没有外层引号)原样返回,只做规范化 —— 绝不能按空格切分:
    # 本机路径是 …\Programs\DeepSeek Harness\DeepSeek Harness.exe,切一刀就只剩 …\DeepSeek。
    if ($line -match '^[A-Za-z]:') { return ($line -replace '/', '\').ToLowerInvariant() }
    if ($line.StartsWith('"')) {
        $end = $line.IndexOf('"', 1)
        if ($end -gt 0) { $line = $line.Substring(1, $end - 1) } else { $line = $line.Substring(1) }
    } else {
        $space = $line.IndexOf(' ')
        if ($space -gt 0) { $line = $line.Substring(0, $space) }
    }
    return ($line -replace '/', '\').ToLowerInvariant()
}

# 按 exe 路径扫目标应用的进程(0..n 个)。只按"命令行里的 exe 路径"匹配 ⇒ 只覆盖**这一个安装**,
# 别的安装位置 / dev 版 / 其它同名进程都不会命中。
function Get-DesktopAppProcess {
    param([string]$ExePath)
    if ($ExePath -eq '') { return @() }
    $name = [System.IO.Path]::GetFileName($ExePath)
    if ($name -eq '') { return @() }
    $want = Get-CommandLineExePath -CommandLine ('"' + $ExePath + '"')
    $all = @(Get-CimInstance Win32_Process -Filter ("Name = '" + $name.Replace("'", "''") + "'") -ErrorAction SilentlyContinue)
    return @($all | Where-Object { (Get-CommandLineExePath -CommandLine ([string]$_.CommandLine)) -eq $want })
}

# 「这个进程在不在目标 exe 的**进程树**里」——pid 校验用这一条。
# ⚠ 为什么不能要求"插件注入的 pid 是主进程":插件跑在**后端 Host** 里,它注入的 `process.pid` 就是
#   Host 的 pid(实测:主进程 28568 下面挂着 Host 30032),Host 的父进程才是主进程 ⇒ 用"必须主进程"
#   去校验它必然为假,于是 **fail closed、桌面端永远重启不了**(2026-09-30 真机验收踩到:
#   `桌面端:pid=30032 存在但不是目标 exe 的主进程 ⇒ fail closed(退出 4)`)。
#   判据只要求两件事:**同一个 exe** + **它的父进程也在这棵树里**(即它确实是这棵树的一部分,
#   而不是用户另外手起的一个同 exe 实例)。
#
# ⚠ **主进程不能用 --type= 区分**(2026-09-30 演练实测的教训):后端 Host 子进程同样没有 --type=,
#   按它筛会把 Host 也当成主进程,于是"命中 3 个主进程 ⇒ fail closed"。本函数**取反**就是"根进程"
#   判据 —— 父进程不在这棵树里的那个才是 Electron 主进程:
#     28568 主进程(父=explorer.exe,命令行就是 "…\DeepSeek Harness.exe")
#       ├ --type=gpu-process / --type=renderer / --type=utility(network/audio)
#       └ 30032 后端 Host(--expose-internals …\dsh-desktop-host\lib\index.js)
#             └ …\dsh-subprocess-local\lib\runner.js(插件/工具起的 pwsh 壳)
#   父进程已退出的孤儿进程同样算"根"(父进程不在列表里),这与"用户手动起的第二个实例"形态相同 ——
#   那种情况下会命中多个根,调用方按"无法确定本实例"fail closed(退出 4),不瞎杀。
function Test-DesktopTreeMember {
    param($Process, [string]$ExePath)
    if (-not $Process) { return $false }
    if ($ExePath -eq '') { return $false }
    if ((Get-CommandLineExePath -CommandLine ([string]$Process.CommandLine)) -ne (Get-CommandLineExePath -CommandLine ('"' + $ExePath + '"'))) { return $false }
    $all = @(Get-DesktopAppProcess -ExePath $ExePath)
    $ids = @{}
    foreach ($item in $all) { $ids[[int]$item.ProcessId] = $true }
    return $ids.ContainsKey([int]$Process.ParentProcessId)
}

# 「这条命令行是不是本实例的 dsh」——判据与插件 lib/index.js 的 matchesInstanceCommandLine 一致
# (test/instance-identity.test.mjs 用 JS 镜像锁行为,两边改一处必须改另一处):
#   · node 可执行文件后**紧跟** dsh 入口脚本 ⇒ 才是 dsh 宿主。不能只写"命令行里出现 dsh\lib\bin.js":
#     dsh 的子进程 runner.js 会把整条 PowerShell 命令文本带进自己的命令行,提到过就误命中
#     (2026-09-18 看门狗那侧实测踩过,这里用同一条写法)。
#   · 给了 profile ⇒ 命令行里要有这个 token(词边界,避免 ...\dsh-web-app\... 被 web 命中);
#   · 给了端口 ⇒ 要有 --port <n>,且 n 后面不能再跟数字(避免 3080 命中 30800)。
function Test-DshInstanceCommandLine {
    param([string]$CommandLine, [string]$Profile = '', [int]$TargetPort = 0)
    if (-not $CommandLine) { return $false }
    if ($CommandLine -notmatch 'node(\.exe)?"?\s+"?[^"\s]*dsh[\\/]lib[\\/]bin\.js') { return $false }
    if ($Profile -ne '') {
        if ($CommandLine -notmatch ('(?<![A-Za-z0-9_.\-])' + [regex]::Escape($Profile) + '(?![A-Za-z0-9_.\-])')) { return $false }
    }
    if ($TargetPort -gt 0) {
        if ($CommandLine -notmatch ('--port[\s=]+' + $TargetPort + '(?!\d)')) { return $false }
    }
    return $true
}

# 按身份扫描本实例的 dsh 进程(0..n 个)。没给 profile 也没给端口时不要调用它 —— 那等于"凡 dsh 都算"。
function Get-InstanceDshProcess {
    param([string]$Profile = '', [int]$TargetPort = 0)
    @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { Test-DshInstanceCommandLine -CommandLine $_.CommandLine -Profile $Profile -TargetPort $TargetPort })
}

# 本轮要杀/要复查的 dsh:有完整身份(profile 或端口)就按身份扫描;身份不全时退回"只看插件注入的
# pid"——绝不退化成"凡 dsh 都算"。
function Get-TargetDshProcess {
    if ($ProfileName -ne '' -or $identityPort -gt 0) {
        return @(Get-InstanceDshProcess -Profile $ProfileName -TargetPort $identityPort)
    }
    if ($DshPid -gt 0) {
        return @(Get-CimInstance Win32_Process -Filter "ProcessId = $DshPid" -ErrorAction SilentlyContinue)
    }
    return @()
}

# 看门狗进程(node + dsh-watchdog.js):与 dsh 进程是两回事,换手时必须分开判定。
# 判据收紧成"node.exe 后紧跟看门狗脚本路径",而不是"命令行里凡提到 dsh-watchdog.js" ——
# 后者会误伤无关 node 进程:dsh 的子进程 runner 会把整条 PowerShell 命令文本带进自己的
# 命令行,只要那条命令提到过本脚本路径就会被命中(2026-09-18 实测命中)。
# PID 文件可能残留上一次被强杀实例的记录,只作交叉验证,不作候选来源。
function Get-LiveWatchdogProcess {
    @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'node(\.exe)?"?\s+"?[^"\s]*dsh-watchdog\.js' })
}

function Test-TcpPort {
    param([int]$TargetPort, [int]$TimeoutMs = 800)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync('127.0.0.1', $TargetPort)
        if (-not $task.Wait($TimeoutMs)) { return $false }
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

# 从自起 dsh 的输出文件里读 `dsh web: <URL>` 行(未脱敏原文)。找不到返回 ''。
# 正则与看门狗 DSH_URL_RE 完全一致 —— 隔离实验实测:重定向到**文件**时 Node 的 stdout 是同步写,
# token 行从打印到可被读到只滞后 4~5ms,不需要 NODE_OPTIONS 之类的缓冲设置。
function Get-DshUrlLineFromFile {
    param([string]$Path)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return '' }
    $text = ''
    try { $text = [string](Get-Content -LiteralPath $Path -Raw -ErrorAction Stop) } catch { return '' }
    if (-not $text) { return '' }
    $m = [regex]::Match($text, 'dsh web:\s*(\S+)')
    if (-not $m.Success) { return '' }
    return $m.Groups[1].Value.Trim()
}

# ── 自行拉起 dsh(看门狗不在时的主路径,2026-09-24 起不再依赖看门狗)─────────────────────
# 通道选择全部来自隔离实验(报告:%TEMP%\dsh-spawn-lab-20260924-171435\REPORT.md):
#   · 推荐:绝对路径 node + Start-Process -RedirectStandardOutput/-RedirectStandardError -WindowStyle Hidden
#     —— 父脚本退出后子进程存活(实测 110s+)、输出完整落盘、无可见窗口、起效 0.6~1.1s;
#   · **禁止 stdout 走管道**:父进程退出约 0.5s 后子进程即 EPIPE 崩(与看门狗必须常驻是同一原因);
#   · **禁止 WMI 直起 node**:会弹可见终端窗口,且重定向全丢 ⇒ token 拿不到;
#   · 重定向是**截断写**(旧文件被清空),且本函数每轮先删输出文件 ⇒ 上一轮的旧 token 不可能造成假就绪
#     (反之若用追加写,旧 token 行会让正则立刻命中 ⇒ 假就绪 + 拿到过期 token)。
# 就绪判据(两条**都**要):端口可应答 + 输出文件里抓到**带 token** 的 `dsh web: <URL>` 行。
# 返回:@{ ok; url; pid; attempts; reason }
function Invoke-SelfLaunchDsh {
    $result = @{ ok = $false; url = ''; pid = 0; attempts = 0; reason = ''; pre = $false }
    $entry = $DshEntry
    if ($SelfLaunchTest) { $entry = $TestDshEntry }
    $nodePath = $NodeExeAbs
    if (-not (Test-Path -LiteralPath $nodePath)) {
        Write-RestartLog ('自行拉起:未找到绝对路径 node(' + $nodePath + '),回退用 "' + $NodeExe + '"(依赖 WMI 宿主的 PATH,不可靠)。')
        $nodePath = $NodeExe
    }
    # profile 名用脚本收到的身份参数(生产路径同一来源),不再写死 web。
    # 注意 dsh 的 profile 是**位置参数**,缺了它会直接 `error: --profile <name> is required` 退出,
    # 所以身份里没有 profile 时不做"猜一个"的尝试,也不去重试(退出码 1)。
    # 命令行形态与看门狗一致:node <入口脚本> <profile> --no-open --port <n>
    $launchArgs = @($entry)
    if ($ProfileName -ne '') {
        $launchArgs += $ProfileName
    } else {
        $result.reason = '未收到 profile 名(-ProfileName),无法确定该拉起哪个 profile'
        $result.pre = $true   # 前置失败 ⇒ 调用方按退出码 1 结算(不去重试,重试也没用)
        return $result
    }
    $launchArgs += @('--no-open', '--port', "$Port")

    if ($SelfLaunchAttempts -lt 1) { $SelfLaunchAttempts = 1 }
    if (-not (Test-Path -LiteralPath $SelfLaunchLogDir)) {
        $null = New-Item -ItemType Directory -Path $SelfLaunchLogDir -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path -LiteralPath $entry)) {
        Write-RestartLog ('自行拉起:入口脚本不存在(' + $entry + ')—— 仍按流程尝试,由 node 报错并计入本轮失败原因。')
    }

    $attempt = 0
    while ($attempt -lt $SelfLaunchAttempts) {
        $attempt++
        $result.attempts = $attempt
        # 先清输出文件:与"截断写"双保险,绝不让上一轮的 token 行留在文件里
        Remove-Item -LiteralPath $SelfLaunchOutFile, $SelfLaunchErrFile -Force -ErrorAction SilentlyContinue
        $proc = $null
        try {
            $proc = Start-Process -FilePath $nodePath -ArgumentList $launchArgs `
                -RedirectStandardOutput $SelfLaunchOutFile -RedirectStandardError $SelfLaunchErrFile `
                -WindowStyle Hidden -PassThru -ErrorAction Stop
        } catch {
            $result.reason = 'Start-Process 抛错:' + $_.Exception.Message
            Write-RestartLog ('自行拉起:第 {0}/{1} 次尝试失败 —— {2}' -f $attempt, $SelfLaunchAttempts, $result.reason)
            if ($attempt -lt $SelfLaunchAttempts) { Start-Sleep -Seconds $SelfLaunchRetryDelaySeconds }
            continue
        }
        Write-RestartLog ('自行拉起:第 {0}/{1} 次尝试已发起(pid={2} 通道=start-process-redirect node={3} profile={4} port={5};输出={6})' -f `
            $attempt, $SelfLaunchAttempts, $proc.Id, $nodePath, $ProfileName, $Port, $SelfLaunchOutFile)

        $deadline = (Get-Date).AddSeconds($SelfLaunchReadySeconds)
        $urlLine = ''
        $portUp = $false
        $exited = $false
        while ((Get-Date) -lt $deadline) {
            $urlLine = Get-DshUrlLineFromFile -Path $SelfLaunchOutFile
            if ($urlLine -ne '' -and $urlLine -match '[?&]token=') { $portUp = Test-TcpPort -TargetPort $Port }
            if ($urlLine -ne '' -and $urlLine -match '[?&]token=' -and $portUp) { break }
            if ($proc -and $proc.HasExited) { $exited = $true; break }
            Start-Sleep -Milliseconds 200
        }

        if ($urlLine -ne '' -and $urlLine -match '[?&]token=' -and $portUp) {
            $result.ok = $true
            $result.url = $urlLine
            $result.pid = $proc.Id
            Write-RestartLog ('自行拉起:就绪(第 {0} 次尝试,pid={1};端口 {2} 已应答,输出里已抓到带 token 的 URL)' -f $attempt, $proc.Id, $Port)
            # 带 token 的完整 URL 覆盖写入单个文件(只留最近一次):用户清 cookie / 换浏览器时取一次。
            # 日志里**不写** token 明文(与看门狗写盘前脱敏的口径一致)。
            try {
                Set-Content -LiteralPath $LastUrlFile -Value $urlLine -Encoding utf8 -NoNewline -ErrorAction Stop
                Write-RestartLog ('自行拉起:已取得带 token 的 URL(日志不留明文),覆盖写入 ' + $LastUrlFile)
            } catch {
                Write-RestartLog ('自行拉起:写 ' + $LastUrlFile + ' 失败:' + $_.Exception.Message + '(就绪判定不受影响)')
            }
            return $result
        }

        # 未就绪:把原因写清楚(本轮为什么不算就绪)
        $why = @()
        if ($exited) {
            $code = '?'
            try { $code = $proc.ExitCode } catch { }
            $why += ('进程在就绪前已退出(exit code=' + $code + ')')
        } else {
            $why += ('进程存活但 ' + $SelfLaunchReadySeconds + 's 内未满足就绪判据')
        }
        if ($urlLine -eq '') {
            $why += ('输出文件里没有能匹配正则 dsh web:\s*(\S+) 的行 ⇒ 拿不到 token(' + $SelfLaunchOutFile + ')')
        } elseif ($urlLine -notmatch '[?&]token=') {
            $why += ('输出里虽有 dsh web: 行但不带 token=' + '(内容被丢弃,不落日志)' + ' ⇒ 拿不到可用 URL')
        } else {
            $why += ('已抓到带 token 的 URL 但端口 ' + $Port + ' 未应答(可能还没绑定或已被别的进程占用)')
        }
        $result.reason = ($why -join ';')
        Write-RestartLog ('自行拉起:第 {0}/{1} 次尝试未就绪 —— {2}' -f $attempt, $SelfLaunchAttempts, $result.reason)
        $errHead = @(Get-Content -LiteralPath $SelfLaunchErrFile -TotalCount 3 -ErrorAction SilentlyContinue)
        if ($errHead.Count -gt 0) {
            Write-RestartLog ('自行拉起:本轮 stderr 首几行 = ' + (($errHead | ForEach-Object { ([string]$_).Trim() }) -join ' | '))
        }
        # 清掉本轮这个半成品,避免它稍后绑定端口、与下一轮抢端口(只针对本轮 pid,绝不牵连其它进程)
        if ($proc -and -not $proc.HasExited) {
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction Stop
                Start-Sleep -Milliseconds 300
                Write-RestartLog ('自行拉起:已终止本轮未就绪的进程 pid=' + $proc.Id)
            } catch {
                Write-RestartLog ('自行拉起:终止本轮 pid=' + $proc.Id + ' 失败:' + $_.Exception.Message)
            }
            $still = Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.Id)" -ErrorAction SilentlyContinue
            if ($still) {
                Write-RestartLog ('自行拉起:警告 —— pid=' + $proc.Id + ' 仍在,可能占住端口 ' + $Port + ',下一轮会 EADDRINUSE。')
            }
        }
        if ($attempt -lt $SelfLaunchAttempts) { Start-Sleep -Seconds $SelfLaunchRetryDelaySeconds }
    }
    if ($result.reason -eq '') { $result.reason = ('连续 ' + $SelfLaunchAttempts + ' 次尝试均未就绪') }
    return $result
}

# 起一个看门狗实例(看门狗换手 与 "自行拉起后回归" 共用同一条通道,避免两处实现漂移)。
# 通道:WMI `conhost.exe --headless "<绝对路径 node>" "<dsh-watchdog.js>" --port N` ——
#   WMI 创建的进程没有可用的交互式 window station,wscript/mshta/cscript 这类 GUI 子系统宿主在里面
#   起不来,conhost --headless 是已验证可用的无窗口通道;回退 Start-Process -WindowStyle Hidden
#   (它是本脚本的子进程,可能随本脚本一起被清理,只作保底)。
# 返回命中的通道名('wmi-conhost' / 'start-process-fallback'),全失败返回 ''。
# 失败只记日志、不抛错、不改退出码 —— 调用方各自决定后果。
function Start-WatchdogInstance {
    param([int]$TargetPort, [string]$Phase, [int[]]$ExcludePids = @(), [int]$ReadyWaitSeconds = 15)
    $channel = ''
    $nodePath = $NodeExeAbs
    if (-not (Test-Path -LiteralPath $nodePath)) {
        Write-RestartLog ('{0}:未找到 {1}(WMI 通道需要绝对路径),跳过 WMI,直接走回退通道。' -f $Phase, $nodePath)
        $nodePath = $NodeExe   # 与旧实现一致:回退通道才用可能依赖 PATH 的裸 node
    } else {
        $cmd = 'conhost.exe --headless "' + $nodePath + '" "' + $WatchdogScript + '" --port ' + $TargetPort
        try {
            $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd } -ErrorAction Stop
            if ($created.ReturnValue -eq 0) {
                $channel = 'wmi-conhost'
                Write-RestartLog ('{0}:已用 WMI 创建看门狗进程 pid={1}(命令:{2})' -f $Phase, $created.ProcessId, $cmd)
            } else {
                Write-RestartLog ('{0}:WMI 创建看门狗失败(ReturnValue={1}),改用回退通道。' -f $Phase, $created.ReturnValue)
            }
        } catch {
            Write-RestartLog ('{0}:WMI 创建看门狗异常:{1};改用回退通道。' -f $Phase, $_.Exception.Message)
        }
    }
    if ($channel -eq '') {
        try {
            Start-Process -FilePath $nodePath -ArgumentList @($WatchdogScript, '--port', "$TargetPort") -WindowStyle Hidden -ErrorAction Stop
            $channel = 'start-process-fallback'
            Write-RestartLog ('{0}:已用回退通道(Start-Process -WindowStyle Hidden)启动看门狗 —— 它在本脚本进程树内,本脚本退出后可能被一起清理;若门户因此无人监听,自行拉起那条路径仍能保证 dsh 起来。' -f $Phase)
        } catch {
            Write-RestartLog ('{0}:回退通道启动看门狗也失败:{1}' -f $Phase, $_.Exception.Message)
            return ''
        }
    }

    # 校验:进程存活 + 端口有人监听(最多等 ReadyWaitSeconds)
    $deadline = (Get-Date).AddSeconds($ReadyWaitSeconds)
    $newWatchdog = $null
    while ((Get-Date) -lt $deadline) {
        $newWatchdog = @(Get-LiveWatchdogProcess | Where-Object { $ExcludePids -notcontains $_.ProcessId }) | Select-Object -First 1
        if ($newWatchdog -and (Test-TcpPort -TargetPort $TargetPort)) { break }
        Start-Sleep -Milliseconds 500
    }
    if ($newWatchdog -and (Test-TcpPort -TargetPort $TargetPort)) {
        Write-RestartLog ('{0}:新看门狗已就绪(通道={1},pid={2}),端口 {3} 已有人监听。' -f $Phase, $channel, $newWatchdog.ProcessId, $TargetPort)
    } elseif ($newWatchdog) {
        Write-RestartLog ('{0}:新看门狗进程在(pid={1},通道={2})但 {3}s 内端口 {4} 仍无人监听。' -f $Phase, $newWatchdog.ProcessId, $channel, $ReadyWaitSeconds, $TargetPort)
    } else {
        Write-RestartLog ('{0}:{1}s 内未见新看门狗进程存活(通道={2})—— 可能被单实例保护判为重复实例而 exit(0),或启动即失败。' -f $Phase, $ReadyWaitSeconds, $channel)
    }
    return $channel
}

# ── 0) 单实例保护 ─────────────────────────────────────────────────────────
# 不能用"命令行含 dsh-restart.ps1"判定同类进程 —— 任何提到本脚本路径的 pwsh 都会命中
# (模型用 pwsh 工具拼接启动命令、人工查看脚本…),2026-09-17 实测把真正的启动挡在了门外。
# 改用锁文件:写入自己的 pid,检查时验证该 pid 是否仍存活 —— 脚本退出后 pid 消失,锁自动失效,
# 所以无需删除,残留锁文件也不会阻塞后续重启(只额外防 pid 复用:超过 5 分钟的不算持有者)。
$LockFile = Join-Path (Split-Path -Parent $LogFile) 'dsh-restart.lock'
function Get-LiveDriverLock {
    if (-not (Test-Path -LiteralPath $LockFile)) { return $null }
    $lock = $null
    try { $lock = (Get-Content -LiteralPath $LockFile -Raw -ErrorAction Stop) | ConvertFrom-Json } catch { return $null }
    if (-not $lock -or -not $lock.pid) { return $null }
    $holder = Get-CimInstance Win32_Process -Filter "ProcessId = $($lock.pid)" -ErrorAction SilentlyContinue
    if (-not $holder) { return $null }
    if ($holder.CreationDate -and $holder.CreationDate -lt (Get-Date).AddMinutes(-5)) { return $null }
    return $holder
}
$holder = Get-LiveDriverLock
if ($holder) {
    Write-RestartLog ('已有驱动实例在运行(pid=' + $holder.ProcessId + '),本实例退出以避免双驱动互相踩。')
    exit 3
}
Set-Content -LiteralPath $LockFile -Encoding utf8 -Value (@{
    pid = $PID
    sessionId = $SessionId
    startedAt = (Get-Date).ToString('o')
} | ConvertTo-Json)

Write-RestartLog ('===== 重启驱动启动 pid={0} Mode={1} SessionId={2} Wait={3}s DoorWait={4}s ReadyWait={5}s Port={6} =====' -f $PID, $Mode, $SessionId, $WaitSeconds, $DoorWaitSeconds, $ReadyWaitSeconds, $Port)

# ── 身份兜底:旧版插件(只传 -SessionId)从重启标记里取发起者 pid ────────────────
# 标记是插件在启动本脚本之前刚写的,pidBefore 就是发起重启的宿主 pid。三重校验才算数:
# ① 标记里的 sessionId 与本次 -SessionId 一致;② createdAt 在 5 分钟内;③ 该 pid 存在且命令行
# 是 dsh 宿主(下面的精确 pid 校验还会再复核一次)。任一不满足就当没读到 → 走后面的 fail-closed。
if ($DshPid -le 0) {
    if ($PendingFile -eq '') {
        $dshHome = $env:DSH_HOME
        if (-not $dshHome) { $dshHome = Join-Path $HOME '.dsh' }
        $PendingFile = Join-Path $dshHome 'storages\dsh-restart\pending.json'
    }
    $marker = $null
    if (Test-Path -LiteralPath $PendingFile) {
        try { $marker = (Get-Content -LiteralPath $PendingFile -Raw -ErrorAction Stop) | ConvertFrom-Json } catch { $marker = $null }
    }
    if ($marker -and $marker.pidBefore -and ("$($marker.sessionId)" -eq $SessionId)) {
        $epoch = [datetime]::SpecifyKind([datetime]'1970-01-01', [DateTimeKind]::Utc)
        $ageMinutes = ((Get-Date).ToUniversalTime() - $epoch.AddMilliseconds([double]$marker.createdAt)).TotalMinutes
        if ($ageMinutes -ge -5 -and $ageMinutes -le 5) {
            $DshPid = [int]$marker.pidBefore
            Write-RestartLog "身份兜底:从重启标记取到发起者 pid=$DshPid(标记 sessionId 一致,写于 $([math]::Round($ageMinutes, 2)) 分钟前)"
        } else {
            Write-RestartLog "身份兜底:重启标记已 $([math]::Round($ageMinutes, 1)) 分钟,超过 5 分钟不当身份来源。"
        }
    } else {
        Write-RestartLog "身份兜底:重启标记缺失/不可解析/sessionId 不匹配($PendingFile),不当身份来源。"
    }
}

# ── 1.5-desktop) 桌面端分支(Electron,2026-09-30):杀整棵同 exe 进程树 + 冷启动应用 ──────
# 与 web 分支完全独立:不解析 profile/端口,不探看门狗,不等门户,不写 dsh-last-url.txt。
# 走到这里时:单实例锁已拿、启动行已写(插件靠首行的 Mode=desktop 确认脚本真的跑起来了)、
# 身份兜底(pidBefore)已跑过。
if ($Mode -eq 'desktop') {
    if ($DesktopExe -eq '') {
        Write-RestartLog '桌面端:没有收到 -DesktopExe(应用 exe 路径)⇒ fail closed(退出 4),一个进程都不杀。'
        exit 4
    }
    if (-not (Test-Path -LiteralPath $DesktopExe)) {
        Write-RestartLog ('桌面端:exe 路径不存在(' + $DesktopExe + ')⇒ fail closed(退出 4),一个进程都不杀。')
        exit 4
    }
    # 端口必须**显式**给出:默认值 3080 是 web 的,拿它当桌面端的就绪判据会永远等不到(而脚本会一直
    # 以为"没就绪"),所以这里 fail loud。插件按 Host 真实端口(默认 19387)传 -Port。
    if (-not $portExplicit) {
        Write-RestartLog '桌面端:没有显式给出 -Port(默认值 3080 是 web 的,不能当就绪判据)⇒ fail closed(退出 4),一个进程都不杀。'
        exit 4
    }

    # ① 身份:pid 精确校验优先(插件注入的宿主 pid;校验它是"目标 exe 的主进程",判据 = 父子关系)
    #    → 退按 exe 路径扫描
    $exact = $null
    $exactAlive = $false
    $exactVerified = $false
    if ($DshPid -gt 0) {
        $exact = Get-CimInstance Win32_Process -Filter "ProcessId = $DshPid" -ErrorAction SilentlyContinue
        if ($exact) {
            $exactAlive = $true
            # 插件注入的是**后端 Host** 的 pid ⇒ 只校验"同一棵树"(见 Test-DesktopTreeMember)
            $exactVerified = Test-DesktopTreeMember -Process $exact -ExePath $DesktopExe
        } else {
            Write-RestartLog "桌面端:发起重启的宿主 pid=$DshPid 已不存在(可能已在重启中),改按 exe 路径扫描。"
        }
    }

    $mains = @()
    $targetSource = ''
    if ($exactVerified) {
        $mains = @($exact)
        $targetSource = "插件注入的 pid=$DshPid(已校验:同一 exe、且属于这棵进程树)"
    } elseif ($exactAlive) {
        Write-RestartLog ('桌面端:pid=' + $DshPid + ' 存在但不属于目标 exe 的进程树(exe 路径对不上,或它的父进程不在这棵树里)⇒ fail closed(退出 4),一个进程都不杀。')
        exit 4
    } else {
        # 根 = 父进程不在这棵树里的那个(见 Test-DesktopTreeMember);用同一套判据,不留第二份逻辑
        $mains = @(Get-DesktopAppProcess -ExePath $DesktopExe | Where-Object { -not (Test-DesktopTreeMember -Process $_ -ExePath $DesktopExe) })
        if ($mains.Count -eq 0) {
            Write-RestartLog ('桌面端:目标 exe 当前没有主进程在跑(' + $DesktopExe + ')—— 可能已在重启中,继续按流程冷启动。')
        } elseif ($mains.Count -gt 1) {
            Write-RestartLog ('桌面端:同一 exe 命中 ' + $mains.Count + ' 个主进程(pid=' + (($mains | ForEach-Object { $_.ProcessId }) -join ', ') + '),无法确定本实例 ⇒ fail closed(退出 4),一个进程都不杀。')
            exit 4
        } else {
            $targetSource = '按 exe 路径扫描'
        }
    }
    if ($mains.Count -eq 1) {
        Write-RestartLog ('桌面端目标应用(' + $targetSource + '):pid=' + $mains[0].ProcessId + ' exe=' + $DesktopExe)
    }

    if ($DesktopDryRun) {
        $allNow = @(Get-DesktopAppProcess -ExePath $DesktopExe)
        Write-RestartLog ('桌面端演练模式(-DesktopDryRun):只校验身份,不杀任何进程、不启动任何东西。命中主进程=' + $mains.Count + ' 整棵树=' + $allNow.Count + ' 个进程;将执行:Stop-Process → Start-Process ' + $DesktopExe + ' → 等端口 ' + $Port + ' 就绪。')
        exit 0
    }

    # ② 等静默:给本轮的模型输出留出落盘时间(与 web 分支同一条理由)
    if ($WaitSeconds -gt 0) {
        Write-RestartLog "桌面端:等待 $WaitSeconds 秒,让本轮的模型输出落盘..."
        Start-Sleep -Seconds $WaitSeconds
    }

    # ③ 杀整棵树:**先固定名单再杀**(名单 = 同一 exe 的全部进程,含主进程与所有子进程)。
    #    绝不在杀的过程中重新扫描 —— 那样可能命中刚被启动的新实例,造成"起了又杀"的死循环。
    $doomed = @(Get-DesktopAppProcess -ExePath $DesktopExe)
    Write-RestartLog ('桌面端:准备终止 ' + $doomed.Count + ' 个进程(pid=' + (($doomed | ForEach-Object { $_.ProcessId }) -join ', ') + ')')
    foreach ($proc in $doomed) {
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            Write-RestartLog "  已终止 pid=$($proc.ProcessId)"
        } catch {
            Write-RestartLog "  终止 pid=$($proc.ProcessId) 失败:$($_.Exception.Message)"
        }
    }

    # ④ 等旧进程彻底退出(Electron 单实例锁只在进程真正退出后释放;不等干净,新实例会自杀)
    $exitDeadline = (Get-Date).AddSeconds(30)
    $left = @(Get-DesktopAppProcess -ExePath $DesktopExe)
    while ($left.Count -gt 0 -and (Get-Date) -lt $exitDeadline) {
        Start-Sleep -Milliseconds 300
        $left = @(Get-DesktopAppProcess -ExePath $DesktopExe)
    }
    if ($left.Count -gt 0) {
        Write-RestartLog ('桌面端:仍有 ' + $left.Count + ' 个进程存活(pid=' + (($left | ForEach-Object { $_.ProcessId }) -join ', ') + '),再强杀一次。')
        foreach ($proc in $left) { try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop } catch { } }
        Start-Sleep -Milliseconds 1000
        $left = @(Get-DesktopAppProcess -ExePath $DesktopExe)
    }
    if ($left.Count -gt 0) {
        Write-RestartLog ('桌面端:旧进程杀不干净(pid=' + (($left | ForEach-Object { $_.ProcessId }) -join ', ') + '),放弃冷启动以免双实例抢端口/抢单实例锁。')
        exit 2
    }
    Write-RestartLog '桌面端:旧进程已全部退出,单实例锁应已释放。'

    # ⑤ 冷启动同一个 exe(Start-Process 而非 WMI 直起:脚本本身已经是 WMI 创建的、脱离 dsh 进程树,
    #    它 Start-Process 出来的进程同样不在应用进程树里;输出重定向到文件,方便排障)
    $launchOutFile = Join-Path $LogDir 'dsh-desktop-launch-out.log'
    $launchErrFile = Join-Path $LogDir 'dsh-desktop-launch-err.log'
    $readyDeadlineTotal = (Get-Date).AddSeconds($DesktopReadySeconds)
    $launched = $null
    $attempt = 0
    while ($attempt -lt $DesktopLaunchAttempts) {
        $attempt++
        # 起之前先确认没有主进程在(上一轮半成品会被清掉)
        $stale = @(Get-DesktopAppProcess -ExePath $DesktopExe | Where-Object { -not (Test-DesktopTreeMember -Process $_ -ExePath $DesktopExe) })
        if ($stale.Count -gt 0) {
            Write-RestartLog ('桌面端:启动前发现 ' + $stale.Count + ' 个主进程仍在(pid=' + (($stale | ForEach-Object { $_.ProcessId }) -join ', ') + '),先终止。')
            foreach ($proc in @(Get-DesktopAppProcess -ExePath $DesktopExe)) { try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop } catch { } }
            Start-Sleep -Milliseconds 800
        }
        Remove-Item -LiteralPath $launchOutFile, $launchErrFile -Force -ErrorAction SilentlyContinue
        $launched = $null
        try {
            $launched = Start-Process -FilePath $DesktopExe -WorkingDirectory (Split-Path -Parent $DesktopExe) -RedirectStandardOutput $launchOutFile -RedirectStandardError $launchErrFile -PassThru -ErrorAction Stop
            Write-RestartLog ('桌面端:第 {0}/{1} 次冷启动已发起(pid={2} 通道=start-process exe={3})' -f $attempt, $DesktopLaunchAttempts, $launched.Id, $DesktopExe)
        } catch {
            Write-RestartLog ('桌面端:第 {0}/{1} 次冷启动失败:{2}' -f $attempt, $DesktopLaunchAttempts, $_.Exception.Message)
            if ($attempt -lt $DesktopLaunchAttempts) { Start-Sleep -Seconds $DesktopRetryDelaySeconds }
            continue
        }

        # 就绪判据(两条都要):端口可应答 **且** 目标 exe 的主进程在
        # (端口单独不够 —— 别的进程占着同一个端口也会让 TcpClient 连上)
        $ready = $false
        while ((Get-Date) -lt $readyDeadlineTotal) {
            if ((Test-TcpPort -TargetPort $Port) -and (@(Get-DesktopAppProcess -ExePath $DesktopExe | Where-Object { -not (Test-DesktopTreeMember -Process $_ -ExePath $DesktopExe) }).Count -gt 0)) { $ready = $true; break }
            if ($launched -and $launched.HasExited) { break }
            Start-Sleep -Milliseconds 400
        }
        if ($ready) {
            $mainsAfter = @(Get-DesktopAppProcess -ExePath $DesktopExe | Where-Object { -not (Test-DesktopTreeMember -Process $_ -ExePath $DesktopExe) })
            Write-RestartLog ('桌面端:新实例已就绪(第 {0} 次尝试,pid={1},端口 {2} 已应答)。会话注入由 dsh-host-restart 插件在新进程里完成。' -f $attempt, (($mainsAfter | ForEach-Object { $_.ProcessId }) -join ','), $Port)
            exit 0
        }

        $why = @()
        if ($launched -and $launched.HasExited) { $why += ('进程在就绪前已退出(exit code=' + $launched.ExitCode + ')') } else { $why += '进程存活但端口未在期限内应答' }
        $errHead = @(Get-Content -LiteralPath $launchErrFile -TotalCount 3 -ErrorAction SilentlyContinue)
        if ($errHead.Count -gt 0) { $why += ('stderr 首几行=' + (($errHead | ForEach-Object { ([string]$_).Trim() }) -join ' | ')) }
        Write-RestartLog ('桌面端:第 {0}/{1} 次冷启动未就绪 —— {2}' -f $attempt, $DesktopLaunchAttempts, ($why -join ';'))
        # 清掉本轮半成品(只针对这一棵树的 pid),免得它稍后占住端口/单实例锁
        foreach ($proc in @(Get-DesktopAppProcess -ExePath $DesktopExe)) { try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop } catch { } }
        Start-Sleep -Milliseconds 1000
        if ($attempt -lt $DesktopLaunchAttempts) { Start-Sleep -Seconds $DesktopRetryDelaySeconds }
    }

    Write-RestartLog ('桌面端:冷启动失败(共尝试 ' + $DesktopLaunchAttempts + ' 次)⇒ 退出 2。兜底:手工启动 ' + $DesktopExe + '(或开始菜单里的 DeepSeek Harness)。')
    exit 2
}

# ── 1.5) 本实例身份与目标进程(2026-09-21:不再"见 web 就杀") ─────────────────
# 身份三件套来自发起重启的插件宿主**自己的 argv**,所以它们必然也出现在目标进程的命令行里
# ⇒ 正向校验不会出现"插件认得出、脚本认不出"的假阴性。
$identityText = @()
if ($Mode -eq 'desktop') { $identityText += 'mode=desktop' }
if ($DshPid -gt 0) { $identityText += "pid=$DshPid" }
if ($ProfileName -ne '') { $identityText += "profile=$ProfileName" }
if ($portExplicit) { $identityText += "port=$Port(显式)" }
if ($Mode -eq 'desktop' -and $DesktopExe -ne '') { $identityText += "exe=$DesktopExe" }
if ($identityText.Count -eq 0) { $identityText += '(未收到任何身份参数)' }
Write-RestartLog ('本实例身份:' + ($identityText -join ' '))

# ── 演练模式(默认关闭)─────────────────────────────────────────────────────
# 开关:-SelfLaunchTest 或环境变量 DSH_RESTART_SELFLAUNCH_TEST=1。校验不通过一律退出 1(前置失败),
# 绝不在不确定的状态下往下走 —— 这条路只用来跑假 dsh,任何"可能碰到真实进程"的退化都要 fail loud。
$testMode = $false
if ($SelfLaunchTest) { $testMode = $true }
if ($env:DSH_RESTART_SELFLAUNCH_TEST -eq '1') { $testMode = $true }
if ($testMode) {
    if ($Port -lt 39000 -or $Port -gt 39999) {
        Write-RestartLog ('演练模式:端口必须落在 39000-39999(收到 ' + $Port + ')⇒ 前置失败(退出 1),不动任何进程。')
        exit 1
    }
    if ($TestDshEntry -eq '') {
        Write-RestartLog '演练模式:必须用 -TestDshEntry 指定假 dsh 脚本 ⇒ 前置失败(退出 1),不动任何进程。'
        exit 1
    }
    Write-RestartLog ('演练模式已开启(-SelfLaunchTest):端口=' + $Port + ' 假入口=' + $TestDshEntry + ' 尝试上限=' + $SelfLaunchAttempts + ' 单轮就绪超时=' + $SelfLaunchReadySeconds + 's')
    Write-RestartLog '演练模式语义:不扫描/不终止任何真实进程;跳过看门狗换手与看门狗回归;强制走自行拉起分支。'
    if ($TestDshEntry -eq $DshEntry) {
        Write-RestartLog '演练模式:假入口与真实 -DshEntry 相同 —— 请确认这确实是假脚本,否则退出。'
    }
}

$exact = $null
$exactAlive = $false
$exactVerified = $false
if ($DshPid -gt 0) {
    $exact = Get-CimInstance Win32_Process -Filter "ProcessId = $DshPid" -ErrorAction SilentlyContinue
    if ($exact) {
        $exactAlive = $true
        # 端口没显式给出时,先从这条待确认的命令行里取端口,再拿完整身份复核
        if ($identityPort -le 0) {
            $portHit = [regex]::Match([string]$exact.CommandLine, '--port[\s=]+(\d{1,5})')
            if ($portHit.Success) { $identityPort = [int]$portHit.Groups[1].Value }
        }
        $exactVerified = Test-DshInstanceCommandLine -CommandLine $exact.CommandLine -Profile $ProfileName -TargetPort $identityPort
    } else {
        Write-RestartLog "发起重启的宿主 pid=$DshPid 已不存在(可能已在重启中),改按身份扫描。"
    }
}

$targets = @()
$targetSource = ''
if ($exactVerified) {
    $targets = @($exact)
    $targetSource = "插件注入的 pid=$DshPid(命令行已校验)"
} elseif ($exactAlive) {
    Write-RestartLog "pid=$DshPid 存在但命令行与本实例身份不符(入口脚本/profile/端口对不上),拒绝按 pid 杀 ⇒ fail closed(退出 4),一个进程都不杀。"
    exit 4
} else {
    if ($ProfileName -eq '' -and $identityPort -le 0) {
        Write-RestartLog '没有可用的身份参数(pid/profile/port 全缺)⇒ fail closed(退出 4),一个进程都不杀。'
        exit 4
    }
    $targets = @(Get-InstanceDshProcess -Profile $ProfileName -TargetPort $identityPort)
    if ($targets.Count -gt 1 -and $identityPort -le 0) {
        Write-RestartLog ('身份扫描命中 ' + $targets.Count + ' 个同 profile 的 dsh(pid=' + (($targets | ForEach-Object { $_.ProcessId }) -join ', ') + '),无法确定哪个是本实例 ⇒ fail closed(退出 4),一个进程都不杀。')
        exit 4
    }
    $targetSource = '身份扫描(profile/端口)'
}
if ($identityPort -gt 0) { $Port = $identityPort }   # 操作端口跟随本实例,不再默默盯着默认 3080
$AdminPort = $Port + 1
Write-RestartLog "端口:身份端口=$identityPort 操作端口=$Port 管理端口=$AdminPort"

if ($targets.Count -eq 0) {
    Write-RestartLog ('本实例的 dsh 进程当前不存在(来源:' + $targetSource + ')—— 可能已在重启中,继续按流程拉起。')
} else {
    Write-RestartLog ('本实例的 dsh 进程(' + $targetSource + '):' + (($targets | ForEach-Object { "pid=$($_.ProcessId)" }) -join ', '))
}

# ── 1) 等静默:给本轮的模型输出留出落盘时间(进程被杀后未落盘的输出会丢) ──
if ($WaitSeconds -gt 0) {
    Write-RestartLog "等待 $WaitSeconds 秒,让本轮的模型输出落盘..."
    Start-Sleep -Seconds $WaitSeconds
}

# ── 2) 杀本实例的 dsh ─────────────────────────────────────────────────────
# 只杀上面解析出来的目标。绝不再调用 kill_dsh.bat:它的判据("命令行含 dsh\lib\bin.js 且含 web")
# 是跨实例的 —— 从 teamlab 实例发起会杀掉 web 实例(2026-09-21 试跑实测),而它不接身份参数,
# 没法改成"只杀本实例"。桌面上的 kill_dsh.bat 保持原样,只作人工工具使用。
if ($testMode) {
    # 演练:结构性保证"一个真实进程都不动" —— 不是靠"扫描恰好没命中",而是根本不进杀进程那一段
    Write-RestartLog ('演练模式:跳过杀进程(本该终止的目标数=' + $targets.Count + '),一个真实进程都不动。')
    $targets = @()
} else {
    if ($KillScript -ne '') {
        Write-RestartLog "已忽略 -KillScript($KillScript):该脚本的判据跨实例,本脚本只按身份杀进程。"
    }
    foreach ($proc in $targets) {
        Write-RestartLog "终止本实例 dsh pid=$($proc.ProcessId)"
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            Write-RestartLog "  已终止 pid=$($proc.ProcessId)"
        } catch {
            Write-RestartLog "  终止 pid=$($proc.ProcessId) 失败:$($_.Exception.Message)"
        }
    }
    if ($targets.Count -gt 0) { Start-Sleep -Milliseconds 1000 }

    $survivors = @(Get-TargetDshProcess)
    if ($survivors.Count -gt 0) {
        Write-RestartLog "仍有 $($survivors.Count) 个本实例 dsh 进程存活,再终止一次。"
        foreach ($proc in $survivors) {
            try {
                Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
                Write-RestartLog "  已终止 pid=$($proc.ProcessId)"
            } catch {
                Write-RestartLog "  终止 pid=$($proc.ProcessId) 失败:$($_.Exception.Message)"
            }
        }
        Start-Sleep -Milliseconds 1000
        $survivors = @(Get-TargetDshProcess)
    }

    if ($survivors.Count -gt 0) {
        Write-RestartLog ('dsh 未被杀掉(存活 pid=' + (($survivors | ForEach-Object { $_.ProcessId }) -join ', ') + '),放弃拉起以免产生 EADDRINUSE 假崩溃。')
        exit 2
    }
    Write-RestartLog 'dsh 已终止。'
}

# ── 2.5) 看门狗换手:用当前 dsh-watchdog.js 里的 DSH_ENTRY 重新拉起看门狗 ──────
# 为什么要换手:看门狗在启动时就把 DSH_ENTRY 读进内存,改文件对已在跑的实例无效 ——
#   只有新进程才会用新入口(如 npm 全局那份)去拉起 dsh。
# 为什么只能插在这里:看门狗持有 dsh stdout/stderr 的管道读端,且两者同在一个 Windows
#   Job 对象内。若在 dsh 还活着时杀看门狗,dsh 会在下一次写 stdout 时以未捕获 EPIPE
#   崩溃(实测 ~330ms,时点不可预测)。上面的"杀 dsh"刚做完,这里是唯一的空档。
# 顺序硬约束:必须先杀旧、再起新 —— 看门狗的 acquireLock 一旦发现有存活旧实例
#   (命令行含 dsh-watchdog.js),新实例会直接 exit(0) 自杀。
# 失败语义:任何一步失败都只记日志,不改退出码、不提前退出,继续走原有流程
#   (第 3 步"等门户 → 触发"失败,或第 3.5 步"自行拉起"都能兜底,保证 GUI 仍能起来)。
# 注:$WatchdogScript / $WatchdogPidFile 已在文件上方"派生路径"处按 -LogFile 同目录算好。
$WatchdogChannel = ''
# ↓ 这里就是"重启是否依赖看门狗"的判据来源:有没有存活的看门狗进程(读一次,后面复用)
$oldWatchdogs = Get-LiveWatchdogProcess
$oldWatchdogPids = @($oldWatchdogs | ForEach-Object { $_.ProcessId })

if ($testMode) {
    Write-RestartLog '演练模式:跳过看门狗换手(不杀、也不起任何看门狗)。'
} elseif ($oldWatchdogs.Count -eq 0) {
    # 探测结果决定后面走哪条路:没有存活看门狗 ⇒ 不再等门户,直接自行拉起(步骤 3.5)
    Write-RestartLog '换手:当前没有存活的看门狗(判据:node 后紧跟 dsh-watchdog.js),跳过换手 —— 本实例改走"自行拉起"分支,不再等门户。'
} elseif (-not (Test-Path -LiteralPath $WatchdogScript)) {
    Write-RestartLog "换手:看门狗脚本不存在($WatchdogScript),跳过换手;存活的看门狗仍可服务门户,继续等门户 → 触发。"
} else {
    # a-1) 换手前再确认一次"此刻没有存活的 dsh":看门狗可能在步骤 2 之后已经把它拉回来了
    $reborn = @(Get-TargetDshProcess)
    if ($reborn.Count -gt 0) {
        Write-RestartLog ('换手:发现 dsh 又出现(存活 pid=' + (($reborn | ForEach-Object { $_.ProcessId }) -join ', ') + '),很可能是看门狗自动拉起的;先终止它们再换手。')
        foreach ($proc in $reborn) {
            try {
                Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
                Write-RestartLog "  已终止 dsh pid=$($proc.ProcessId)"
            } catch {
                Write-RestartLog "  终止 dsh pid=$($proc.ProcessId) 失败:$($_.Exception.Message)"
            }
        }
        Start-Sleep -Milliseconds 1000
        $reborn = @(Get-TargetDshProcess)
    }

    if ($reborn.Count -gt 0) {
        # 杀不掉就别动看门狗:杀它会断掉这个 dsh 的 stdout 管道,崩溃时点不可预测。
        # 保留旧看门狗 = 保留一条能用的路径(代价只是 DSH_ENTRY 仍是旧值)。
        Write-RestartLog ('换手:仍有 dsh 存活(pid=' + (($reborn | ForEach-Object { $_.ProcessId }) -join ', ') + '),放弃换手以免杀掉看门狗后该 dsh 因管道断裂崩溃;保留旧看门狗,继续走原有流程。')
    } else {
        # a-2) 终止旧看门狗(能走到这里 ⇒ 上面已确认至少有 1 个存活实例,不存在"0 个"分支)
        if ($oldWatchdogs.Count -gt 0) {
            if (Test-Path -LiteralPath $WatchdogPidFile) {
                $pidHint = ''
                try { $pidHint = (Get-Content -LiteralPath $WatchdogPidFile -Raw -ErrorAction Stop).Trim() } catch { $pidHint = '' }
                if ($pidHint.Length -gt 0) { Write-RestartLog "换手:看门狗 PID 文件记录 = $pidHint(仅交叉验证,候选以命令行为准)。" }
            }
            foreach ($wd in $oldWatchdogs) {
                Write-RestartLog "换手:终止旧看门狗 pid=$($wd.ProcessId)"
                try {
                    Stop-Process -Id $wd.ProcessId -Force -ErrorAction Stop
                    Write-RestartLog "  已终止 pid=$($wd.ProcessId)"
                } catch {
                    Write-RestartLog "  终止 pid=$($wd.ProcessId) 失败:$($_.Exception.Message)"
                }
            }
            Start-Sleep -Milliseconds 1000   # 等 3080/3081 的监听句柄随进程一起释放
            $leftover = Get-LiveWatchdogProcess
            if ($leftover.Count -gt 0) {
                Write-RestartLog ('换手:旧看门狗仍有 ' + $leftover.Count + ' 个存活(pid=' + (($leftover | ForEach-Object { $_.ProcessId }) -join ', ') + '),新实例会被单实例保护挡下而 exit(0);继续尝试启动并如实校验。')
            } else {
                Write-RestartLog '换手:旧看门狗已全部退出。'
            }
        }

        # b/c) 启动新看门狗并校验 —— 通道与校验逻辑与"自行拉起后回归"共用同一个函数,
        #       两处只有 Phase 前缀与排除 pid 不同(见 Start-WatchdogInstance 的注释)。
        #       失败只记日志、不改退出码:后面"等门户 → 触发"或"自行拉起"都能兜住。
        $WatchdogChannel = Start-WatchdogInstance -TargetPort $Port -Phase '换手' -ExcludePids $oldWatchdogPids -ReadyWaitSeconds 15
        if ($WatchdogChannel -ne '') {
            Write-RestartLog '换手:下一步将触发它用当前 DSH_ENTRY 拉起 dsh。'
        }
    }
}

# ── 3) 有看门狗 ⇒ 等它回门户监听并触发;没有 ⇒ 不再盲等,直接自行拉起 ────────────
# 进入等待**之前**重新探测一次:换手可能刚把新看门狗起起来(⇒ 要等门户),也可能根本没有看门狗
# (⇒ 等 25s 纯属白等,旧版就因为这条把"看门狗未运行"的重启拖成 25s 起步)。
$liveWatchdogs = @(Get-LiveWatchdogProcess)
$useDoorPath = $false
if ($testMode) {
    Write-RestartLog '演练模式:强制走自行拉起分支,不等门户。'
} elseif ($liveWatchdogs.Count -gt 0) {
    $useDoorPath = $true
    Write-RestartLog ('探测到存活的看门狗(pid=' + (($liveWatchdogs | ForEach-Object { $_.ProcessId }) -join ', ') + ')⇒ 走"等门户 → 触发它拉起 dsh"路径。')
} else {
    Write-RestartLog '探测结果:没有存活的看门狗进程(判据:node 后紧跟 dsh-watchdog.js)⇒ 跳过等待门户(原 DoorWaitSeconds=' + $DoorWaitSeconds + 's),立即自行拉起 dsh。'
}

$spawnedBySelf = $false
$selfLaunchPid = 0
$selfLaunch = $null
if ($useDoorPath) {
    $doorDeadline = (Get-Date).AddSeconds($DoorWaitSeconds)
    $doorReady = $false
    while ((Get-Date) -lt $doorDeadline) {
        if (Test-TcpPort -TargetPort $Port) { $doorReady = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if ($doorReady) {
        Write-RestartLog "端口 $Port 已有人监听(看门狗门户),发请求触发拉起 dsh..."
        try {
            $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -TimeoutSec 5 -ErrorAction Stop
            Write-RestartLog '触发请求已送达,等待新 dsh 就绪。'
        } catch {
            # 门户页握手期间连接被主动关闭属正常(它要释放端口给 dsh),只有连不上才值得记一笔
            Write-RestartLog "触发请求返回异常(握手期通常可忽略):$($_.Exception.Message)"
        }
    } else {
        Write-RestartLog "等待 ${DoorWaitSeconds}s 后端口 $Port 仍无人监听(看门狗在,门户没回来)⇒ 转入自行拉起 dsh。"
        $selfLaunch = Invoke-SelfLaunchDsh
    }
} else {
    $selfLaunch = Invoke-SelfLaunchDsh
}

# ── 3.5) 自行拉起的结算(两条路径共用同一套失败语义)────────────────────────
if ($selfLaunch -and -not $selfLaunch.ok) {
    Write-RestartLog ('自行拉起 dsh 失败(共尝试 ' + $selfLaunch.attempts + ' 次):' + $selfLaunch.reason)
    if ($selfLaunch.pre) {
        Write-RestartLog '前置失败(退出 1):身份里缺 profile 名,拼不出正确的 dsh 启动命令行,不重试也不动其它进程。'
        exit 1
    }
    Write-RestartLog '兜底:由看门狗冷启动门户拉起(看门狗是可选件,见 <看门狗所在目录>\dsh-watchdog.vbs;本机若做了桌面快捷方式,双击它等价)。'
    exit 2
}
if ($selfLaunch -and $selfLaunch.ok) {
    $spawnedBySelf = $true
    $selfLaunchPid = $selfLaunch.pid
}

# ── 4) 等新 dsh 就绪 ──────────────────────────────────────────────────────
$ready = $false
if ($spawnedBySelf) {
    # 自行拉起路径已在 Invoke-SelfLaunchDsh 内按"端口可应答 + 抓到带 token 的 URL"双判据确认过就绪
    $ready = $true
} else {
    $readyDeadline = (Get-Date).AddSeconds($ReadyWaitSeconds)
    while ((Get-Date) -lt $readyDeadline) {
        try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$AdminPort/dsh-url" -TimeoutSec 3 -ErrorAction Stop
            if ($resp.StatusCode -eq 200 -and "$($resp.Content)".Trim().Length -gt 0) { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 700
    }
}

# ── 4.5) 看门狗回归(尽力而为:自行拉起成功且 dsh 已就绪后,起回一个看门狗接管它)──────
# 顺序理由(为什么是"先 dsh 后看门狗"):看门狗启动时会探测端口 —— 发现是 dsh 就走
#   adoptExternalDsh → 进入 Monitor 接管;若端口空闲则会去 serveDoor() 占住门户。
#   此刻 dsh 已确认绑定端口,所以不存在"门户句柄与新 dsh bind 撞车"的抢端口风险
#   (反过来"先起看门狗再起 dsh"才有那个风险:门户正占着端口,新 dsh 必然 EADDRINUSE)。
#   唯一残留风险:起看门狗的那一刻 dsh 恰好死了 ⇒ 看门狗退回门户待命,属它本职行为,不是冲突。
# 失败只记日志、不影响"重启已成功"的判定(重启的判据是 dsh 就绪,不是门户是否回来了)。
if ($spawnedBySelf -and $ready) {
    if ($testMode) {
        Write-RestartLog '演练模式:跳过看门狗回归(不起任何看门狗)。'
    } elseif (-not (Test-Path -LiteralPath $WatchdogScript)) {
        Write-RestartLog ('回归:看门狗脚本不存在(' + $WatchdogScript + '),跳过;下次登录时启动文件夹里的 vbs 会拉起它。')
    } else {
        $alreadyRunning = @(Get-LiveWatchdogProcess)
        if ($alreadyRunning.Count -gt 0) {
            Write-RestartLog ('回归:已有看门狗在运行(pid=' + (($alreadyRunning | ForEach-Object { $_.ProcessId }) -join ', ') + '),无需回归 —— 它会靠端口探测接管本实例 dsh(注意:它没拿到本次 dsh 的 token,门户页跳转不可用,取 URL 见 dsh-last-url.txt)。')
        } else {
            Write-RestartLog '回归:自行拉起已就绪,尝试起回一个看门狗接管此 dsh(失败只记日志,不影响"重启已成功")。'
            $wdChannel = Start-WatchdogInstance -TargetPort $Port -Phase '回归' -ExcludePids @() -ReadyWaitSeconds 15
            if ($wdChannel -ne '') {
                Write-RestartLog '回归:看门狗已起回并接管本实例 dsh(冷启动门户能力恢复)。'
            } else {
                Write-RestartLog '回归:看门狗未能起回 ⇒ 当前 3080 由新 dsh 独占(Web 服务不受影响),只是少了"冷启动门户"这一层;需要补回时手工执行 wscript <看门狗所在目录>\dsh-watchdog.vbs(它开机会探测端口并接管这个 dsh)。'
            }
        }
    }
}

$after = @(Get-TargetDshProcess)
$pids = if ($after.Count -gt 0) { ($after | ForEach-Object { $_.ProcessId }) -join ', ' } else { '（未发现）' }
if ($selfLaunchPid -gt 0) { Write-RestartLog "本脚本自行拉起的进程 pid=$selfLaunchPid(身份扫描结果:$pids)。" }

if ($ready) {
    Write-RestartLog "新 dsh 已就绪(pid=$pids)。会话注入由 dsh-host-restart 插件在新进程里完成。"
    if ($spawnedBySelf) {
        Write-RestartLog ('本次由脚本自行拉起(入口=' + $(if ($testMode) { $TestDshEntry } else { $DshEntry }) + '),带 token 的 URL 已覆盖写入 ' + $LastUrlFile + ' —— 清 cookie / 换浏览器时可从这里取一次。')
    }
    exit 0
}

Write-RestartLog "等待 ${ReadyWaitSeconds}s 后仍未确认就绪(当前 dsh pid=$pids);请查看 <日志目录>\dsh-watchdog.log 与 dsh-watchdog-dsh.log。"
exit 2
