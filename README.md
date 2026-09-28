# dsh-host-restart

给 DSH web 宿主加一个模型可调用的工具 `restart_dsh`：**杀掉当前 dsh 后端 → 常驻看门狗拉起新进程 → 新进程自动恢复原会话并注入「已重启」继续对话**。

用途：改完宿主插件代码或 cordis patch 后常常要重启 dsh 才生效，而重启会掐断正在进行的会话。
本插件把「重启」和「把会话接回来」合成一步，用户不用刷新页面、不用重新描述上下文。

---

## 1. 时序

```
模型调用 restart_dsh(note?, wait_seconds?)
   │
   ├─① 插件写标记 $DSH_HOME/storages/dsh-restart/pending.json
   │      { sessionId, text:"已重启。…", createdAt, waitSeconds, pidBefore }
   ├─② 插件用 WMI(Win32_Process.Create) 启动驱动脚本 —— 脱离 dsh 进程树,
   │      并把**本实例身份**(自己的 pid + profile 名 + 端口)随命令行传给脚本
   ├─③ 插件确认脚本真的起来了(日志首行出现本次 SessionId)后才返回
   └─④ 工具结果要求模型立刻结束本轮输出
                 │
   [dsh-restart.ps1]（独立进程，父级是 WmiPrvSE.exe）
     a. 单实例保护 → 解析本实例身份(-DshPid/-ProfileName/-Port) → 等 WaitSeconds(默认 6s，让本轮输出落盘)
     b. 只杀**本实例**的 dsh：精确 pid(命令行已校验)优先 → 退按 profile 名 + 端口扫描 →
        仍确定不了 ⇒ 退出码 4，一个进程都不杀（fail closed）
        · dsh 没被杀掉 ⇒ 放弃，退出码 2（避免拉起后 EADDRINUSE 假崩溃）
     c. **先探测看门狗进程在不在**（判据：node 后紧跟 dsh-watchdog.js；2026-09-24 起重启不再依赖看门狗）：
        · 在 ⇒ 换手（杀旧看门狗 → 用当前 DSH_ENTRY 起新实例）→ 轮询本实例端口等它回门户
               （它判定端口空闲需约 15s）→ 发一次 HTTP 请求触发它拉起 dsh → 转 e
        · 不在 ⇒ **不再盲等 25s 门户**，直接转 d
     d. 自行拉起 dsh（看门狗不在时的**主路径**，不再是"降级"）：
        绝对路径 node + Start-Process 重定向 stdout/stderr 到 dsh-selflaunch-out/-err.log
        → 就绪判据＝端口可应答 **且** 输出文件里用 `dsh web:\s*(\S+)` 抓到**带 token** 的 URL
        → 失败最多重试 3 次（每次写清原因：进程已退出 / 无 URL 行 / URL 不带 token / 端口未应答）
        → 仍失败 ⇒ 退出码 2；成功后把带 token 的完整 URL 覆盖写入 dsh-last-url.txt
        → 再尽力起回一个看门狗接管这个 dsh（失败只记日志，不影响"重启已成功"）
     e. 轮询管理端口 3081 /dsh-url 直到新 dsh 就绪(最长 60s)；走 d 的路径在 d 内已确认就绪
                 │
   [新 dsh 进程] 插件 apply → 延迟 4s → 读标记
     → 等 sessionController 就绪 → resolveAgent(sessionId)（必要时 resume + 重新挂载会话记录的 preset）
     → agent.followup("已重启。…") → 删标记
```

整轮耗时约 20–40 秒。2026-09-17 实测一次**工具发起**的重启（`wait_seconds=15`）全程 **39 秒**：
15s 静默 + 1s 杀进程 + 15s 看门狗回门户 + 2s 新 dsh 启动 + 4s 注入延迟 + 2s 注入。
其中那 15s 是看门狗判定"端口空闲"的固定开销，与本插件参数无关；把它算进去，
默认 `wait_seconds=6` 的典型整轮约 **30 秒**。
**看门狗不在场时更快**：那条 15s 固定开销不再发生（脚本探不到看门狗进程就直接自行拉起），
整轮约 15 秒左右；代价是少了看门狗的 token 自动跳转（见 §4「自行拉起路径的 token」）。

## 2. 文件与配置

| 位置 | 作用 |
|---|---|
| `~/.dsh/profiles/web/plugins/dsh-host-restart/lib/index.js` | 插件本体：注册工具 + 启动时消费标记并注入 |
| `~/.dsh/profiles/web/plugins/dsh-host-restart/cordis.patch.yml` | 本包自己的注册行 `id: restart-dsh`（**包层 patch**：本包是组合包，由 profile 的 `dsh.profile.bundles` 加载；改它不需要重启，但**不会自己触发重组合**，见 §7 末段） |
| `C:\run\tools\dsh-restart.ps1` | 驱动脚本：解析本实例身份 → 只杀本实例 dsh → **探看门狗**（在就换手+触发，不在就自行拉起）→ 等就绪（退出码 4 = 身份确定不了，一个都不杀） |
| `C:\run\tools\dsh-restart.log` | 插件与脚本**共用**的流程日志（超过 1MB 截断保留尾部） |
| `~/.dsh/storages/dsh-restart/pending.json` | 重启标记；成功注入即删，陈旧/失败改名归档为 `pending.<原因>-<时间>.json` |
| `C:\run\tools\dsh-selflaunch-out.log` / `dsh-selflaunch-err.log` | 脚本**自行拉起** dsh 时的 stdout/stderr（每轮**覆盖写**，不是追加）。默认与 `-LogFile` 同目录，可用 `-SelfLaunchLogDir` 覆盖 |
| `C:\run\tools\dsh-last-url.txt` | 最近一次自起 dsh 的**带 token 完整 URL**（覆盖写、只保留最近一次）。用途：清 cookie / 换浏览器时取一次；重启日志里只记"已取得带 token 的 URL"，不留 token 明文 |
| `%USERPROFILE%\Desktop\kill_dsh.bat` | 桌面**人工**用的"杀 web 实例"脚本（判据是命令行含 `dsh\lib\bin.js` 且含 ` web `，**跨实例**）。驱动脚本**不再调用它**，只按本实例身份杀进程 |
| `C:\run\tools\dsh-restart.lock` | 驱动脚本的锁文件（单实例保护）。退出后**故意不删**：判据是"里面记的 pid 是否还活着"，所以残留无害、也不会阻塞下次重启 |

> ⚠ **源码在 `plugins\` 下，但真正被加载的是 `node_modules\` 里的那份拷贝（含包内 `cordis.patch.yml`）。**
> pnpm 对 `file:` 本地依赖做的是**实体拷贝而非 junction**（`node_modules\dsh-host-restart` 是独立目录），
> 而且源目录内容变了它仍可能报 `Already up to date` 直接跳过同步 —— 必须 `dshpm remove` 再 `add`。
> 完整流程见 §7，已因此踩过一次坑（§8 第 3 条）。

启停：Web 侧栏「插件」页 →「已安装」区里本卡的总开关（写 `dsh.profile.bundles`）；
点开卡片后每一行还有行级开关（向 profile 的 `cordis.patch.yml` 写 `disabled` 覆盖 ——
profile 层在包层之后应用，所以覆写优先）。

插件配置（包内 `cordis.patch.yml` 的 `config` 段，全部可选；profile 层可按 id 覆写）：
`waitSeconds`(默认 6) / `bootDelayMs`(4000) / `staleMs`(600000) / `controllerWaitMs`(30000) /
`restartScript` / `logFile` / `pendingDir` / `psExe` / `wmiExec`（仅测试注入的启动原语，见 §6）。
非法值会 fail loud（抛错、不注册工具）。

工具参数：`note`（追加到注入文案末尾）、`wait_seconds`（2–60，默认 6，越大越不容易截断本轮输出）。

## 3. 为什么这样启动驱动脚本（本机实测结论）

dsh 的 pwsh 工具走 `dsh-subprocess-local`，Windows 上 `detached:false` 且带 `taskkill` 树级清理
⇒ **任何由 dsh 直接/间接拉起的进程都不保证能在 dsh 被杀后继续运行**。所以驱动脚本必须由一个
与 dsh 进程树无关的载体启动。逐项实测结果（判据＝WMI Create 后子进程能否写出文件）：

| 通道 | 结果 | 说明 |
|---|---|---|
| `conhost.exe --headless "pwsh.exe" …` | ✅ 0.4s 起效、无窗口 | **首选** |
| `"pwsh.exe" -WindowStyle Hidden …` | ✅ 4.5s 起效、无窗口 | 回退通道（不依赖 conhost） |
| `"pwsh.exe" …`（不带 WindowStyle） | ✅ 0.9s，但**会分配控制台窗口** | 不用 |
| `wscript.exe` + vbs 中转 | ❌ 完全不执行 | WMI 进程没有可用的交互式 window station，GUI 子系统宿主起不来 |
| `mshta.exe` / `cscript.exe` 中转 | ❌ 完全不执行 | 同上 |
| `Start-Process` / 普通 spawn | ❌ 仍在 dsh 进程树内 | 会被一起清理 |

⚠ `-WindowStyle Hidden` 只是**冷启动慢**（约 4.5 秒），不是失败 —— 启动确认窗口必须 ≥9s，
否则会把回退通道误判为不可用，进而重复启动驱动（脚本因此带单实例保护，见下）。

插件对每次启动都做**启动确认**：WMI Create 返回 0 只说明进程被创建，脚本解析/启动失败在
`CreateProcess` 层看不到；因此记录日志偏移，等驱动脚本写下含本次 SessionId 的首行日志才算成功，
失败则换下一通道重试，全失败就撤销标记并如实报错（不会出现"以为重启了其实什么都没发生"）。

启动命令行里同时带着**本实例身份**：`-DshPid`（插件宿主自己的 pid）、`-ProfileName`（profile 名）、
`-Port`（端口）。三者都由插件从**自己的 argv** 读出 ⇒ 驱动脚本在目标进程的命令行里必然能找到
同样的 token，"杀哪一个 dsh"因此有确定答案（判据与 fail-closed 语义见 §4）。

## 4. 边界与失败语义

- **只对主会话开放**：`session.header.origin === 'subagent'` 或拿不到会话 id → 直接拒绝，不写标记、不重启。
  原因：子代理会话不能作为"重启后要恢复的那个会话"（`sessionController` 会拒绝 subagent-owned 会话）。
- **看门狗未运行**（2026-09-24 改）：脚本**先探测看门狗进程在不在**，不在就**不再盲等 25 秒门户**，
  立即自行拉起 dsh —— 绝对路径 node + `Start-Process` 把 stdout/stderr 重定向到
  `dsh-selflaunch-out.log`（**禁止走管道**：父进程退出后子进程会 EPIPE 崩，实测 ~0.5s），
  就绪判据＝**端口可应答 且 输出文件里抓到带 token 的 `dsh web:` URL**（两者缺一不算就绪），
  失败最多重试 3 次（每次在日志里写清原因），仍失败才退出码 2。注入照常完成。
- **为什么不用 WMI 直起 node**（最容易被"简化"改回去的老路，实测否决）：`Win32_Process.Create` 起 node
  **会弹出可见的终端窗口**（实测 WindowsTerminal，确认在屏幕上可见 on-screen），且**无法重定向 stdout/stderr**
  —— 输出全丢，dsh 启动时打印的一次性 token URL 拿不到（浏览器无法自动取得带 token 的地址）。
  所以自行拉起固定用 `Start-Process` + 文件重定向 + `-WindowStyle Hidden`，node 用绝对路径
  `C:\Program Files\nodejs\node.exe`（裸 `node` 在 WMI 宿主里虽能解析、但依赖服务环境变量不可靠）；实测子进程在父脚本退出后仍存活 110s+、输出完整落盘、无可见窗口。
- **自行拉起路径的 token**：看门狗不在场时没人解析 dsh 的 stdout，脚本自己抓到的带 token URL 会
  **覆盖写入** `C:\run\tools\dsh-last-url.txt`（只留最近一次，日志里不留 token 明文）。
  浏览器通常已有长效 cookie，直接访问 3080 即可；清过 cookie / 换浏览器时从该文件取一次 URL 访问。
- **看门狗回归**（尽力而为）：自行拉起成功且 dsh 已就绪后，脚本会尝试起回一个看门狗去接管这个 dsh。
  顺序是"先 dsh 后看门狗"——看门狗启动时探测端口，见是 dsh 就接管；此时 dsh 已绑定端口，
  不存在门户与新 dsh 抢端口的问题（反过来才会有）。回归失败只记日志，**不影响"重启已成功"**。
- **自行拉起需要 profile 名**：profile 是 dsh 的**位置参数**（缺了它会 `error: --profile <name> is required` 退出），
  所以身份里没有 profile 时脚本不做"猜一个"的尝试，直接前置失败（退出码 1）。
- **dsh 没被杀掉**：脚本放弃拉起并记日志（避免双实例抢 3080）。
- **重复调用**：标记后写覆盖前写，只有最后一次生效。
- **陈旧标记**：超过 10 分钟（或时间戳在未来）→ 归档不注入，避免下次启动凭空插一条"已重启"。
- **注入失败**（sessionController 不可用 / resume 报错）：标记归档为 `pending.failed-*.json`，
  只记日志、不阻断宿主启动、不无限重试。
- **本轮输出被截断**：进程被杀时尚未落盘的输出会丢；前端"保留被打断回答"的补丁会保住已产出的部分。
- **其它会话在飞：只告知，不拦截（v0.4.0，2026-09-28 起）**：检测照旧跑，但结果只进日志与工具返回文案
  —— 逐条点名会被打断的会话（id + 原因）与交接记录的结局，然后**照常写标记、照常起驱动脚本**。
  v0.3.0 及以前那层"检测到别的会话有活在跑就 `return {ok:false}`"的闸门已**整段删除**
  （用户 2026-09-28 明确要求"重启不该被拒绝"）；现在只剩**两条结构性拒绝**：拿不到会话 id
  （`session.header.origin === 'subagent'`，见本节第一条）与子代理会话发起。
- **检测口径三条**：① 会话自己在本轮运行（`status === 'running'`，含"等审批/等回答"）；
  ② 名下还有正在跑的子代理（父会话派完后**台**子代理就结束本轮 ⇒ 父会话 idle、子代理还在跑；
  `roots()` 看不见子代理，靠 `session.header.parentSession` 上溯归到它的根）；
  ③ 名下还有未结算的后台作业（`running`/`stopping`；作业记录是纯内存态，硬杀即永久丢失）。
  **发起者自己名下的子代理/作业不算"其它会话"** —— 它们与本会话同进程共命，单独计进 `own`
  并写进文案（`本会话自己名下还有 N 个子代理在跑`）。
- **可见范围与"空闲"**：只看**本进程**的会话注册表与作业表（`ctx.get('agents')` / `ctx.get('jobs')`）——
  另一个 dsh 进程（另一个 profile、试跑实例）里的会话它看不见，也就不会出现在文案里；
  标签页开着但**空闲**、名下无子代理无作业 ⇒ 不算"在飞的活"（重启时它照样被杀）。
- **检测本身 fail-soft**：`agents`/`jobs` 拿不到、接口形态不符、枚举抛错都按"读不到"处理，只在日志里留
  一行 `无法检测其它会话(...),按无其它会话处理,照常重启`，**照常重启**；此时文案写「本次没能读到宿主
  会话表(<原因>),无法提前说明会打断哪些会话;…」（**不假装"没有别的会话"**）。⇒ 上游接口一旦漂移，
  这条检测会**悄悄退化成"读不到"**（重启照旧成功，只是文案不再点名谁会被打断），唯一线索是那行 warn。

### 重启前的会话交接与「一次重启只注入一条」（v0.3.0 / v0.4.2）

- **v0.3.0 起，发起重启前先存一份会话交接**：调同 profile 的可选服务 `slHandoff`（由 `dsh-host-sl`
  提供）的 `saveAll({all:true, note, noteSessionId})` —— 它枚举宿主里**所有活着的 agent**（顶层会话 +
  子代理）各存一份记录，`note` 只写进发起重启的这个会话；保存结果写进工具返回文案。
  **完全 fail-soft**：服务缺席 / 只有旧版的 `save`（接口形态不符，需要 `dsh-host-sl` v0.4.0+）/ 抛错 /
  返回 `ok:false`，一律只记一行日志、**照常重启**（最坏等于"没存"，不会把重启卡住）。
- **被打断的会话靠这份记录唤回**：新进程启动时由 `dsh-host-sl` 逐条注入并**重起一轮**接着跑 ——
  救得回上下文，**救不回被硬杀的那一步工具调用**。
- **v0.4.2 起一次重启只注入一条续跑消息、只跑一轮**：新进程里本插件先问「有没有 `dsh-host-sl` 的
  待续标记、且其中含本会话尚未处理的条目」（优先 `pendingSummary()`，退回只读标记文件）——
  **有 ⇒ 本插件不注入**，交给对方的【sl 交接续跑】（正文开头写着「dsh 已重启」，`note` 早在记录正文的
  「下一步」里）；**没有 ⇒ 照旧自己注入**。让位后约 **10 秒**（`deferRecheckMs`）复查一次：标记里
  **仍有**本会话条目（对方让位或失败）且本会话没在 running ⇒ 自己补注入一条。
- **只杀本实例**：驱动脚本按"本实例身份"选进程 —— 精确 pid（插件注入的宿主 pid，命令行已校验）
  → 退按 profile 名 + 端口扫描 → 仍确定不了 ⇒ **退出码 4，一个进程都不杀**（fail closed）。
  为什么必须这样：profile 名是 dsh 的**位置参数**（`dsh web …` 等价 `dsh --profile web`），
  所以"命令行含 ` web `"这种判据跨实例 —— 2026-09-21 试跑实测，从 teamlab 实例（`--port 3090`）
  发起重启会杀掉 web 实例（3080）。桌面 `kill_dsh.bat` 仍是那个跨实例判据，只作人工工具，
  驱动脚本**已不再调用它**。旧版插件（不传身份参数）启动新脚本时，脚本会从重启标记的
  `pidBefore` 兜底取宿主 pid（要求标记的 sessionId 与本次一致、且写于 5 分钟内），
  所以"改完插件之后的第一次重启"不会空转。

## 5. 排障

| 现象 | 查什么 |
|---|---|
| 工具调用后什么都没发生 | `C:\run\tools\dsh-restart.log`：有没有 `===== 重启驱动启动` 行；没有就是启动通道失败（插件日志里会写命中的通道与失败原因） |
| 看门狗在场时，重启日志出现 `触发请求返回异常…401 (Unauthorized)` | 属正常现象，不需要处理 —— 浏览器页面自动重连已抢先唤起 dsh，脚本那次触发请求落在刚绑定端口的新 dsh 上（无 token 故 401）；只要同一轮日志随后出现 `新 dsh 已就绪`，本轮重启就是成功的 |
| dsh 重启了但会话没续 | 日志里搜 `发现重启标记` / `已向会话 … 注入`；`~/.dsh/storages/dsh-restart/` 下有没有 `pending.failed-*.json` |
| 重启后页面卡"启动中" | `C:\run\tools\dsh-watchdog.log`（看门狗侧）与 `dsh-watchdog-dsh.log`（dsh 侧），本插件不参与端口接管 |
| 想确认是不是本插件干的 | `~/.dsh/storages/plugins.json` 里的 `restart-dsh` 条目 + 工具表里的 `restart_dsh` |
| 从别的 profile 实例发起重启，怕误杀生产实例 | 日志里搜 `本实例身份:` 与 `本实例的 dsh 进程(…)`（含判据来源）；解析不出身份会写 `fail closed(退出 4)`，此时**一个进程都没被杀**，把 `-ProfileName`/`-Port` 补进调用参数即可 |
| 重启后浏览器要 token / 提示未授权 | 本次若走的是"自行拉起"（日志搜 `自行拉起:就绪`），后回归的看门狗没有 token 自动跳转 —— 从 `C:\run\tools\dsh-last-url.txt` 取一次 URL 访问，dsh 会签发长效 cookie |
| 自行拉起失败 | ① `dsh-restart.log` 里每轮的原因（进程已退出 / 无 URL 行 / URL 不带 token / 端口未应答）；② node 自身的报错在 `dsh-selflaunch-err.log`；③ 兜底双击桌面 `dsh-web.bat`（由看门狗拉起） |
| 卸载时 `pnpm remove` 报 `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED` | 本 profile 的 pnpm 带供应链策略：进 profile 目录（`~\.dsh\profiles\web\`）直接跑 `pnpm remove dsh-host-restart --config.minimum-release-age=0`。`dshpm` 的 `--fast` 只对 `add` 有效 —— `pnpm remove` 不接受 `--minimum-release-age` 这类参数 |

## 6. 测试与回滚

```powershell
cd ~\.dsh\profiles\web\plugins\dsh-host-restart
node --test "test/*.test.mjs"     # 98 个用例,分布在六个文件:
                                  #   pending(8):标记判定 / 注入文案 / 启动命令行 / 配置校验(纯函数)
                                  #   inject-coverage(10):静态断言 ctx.<service> 都已声明 inject、
                                  #     代码里不再有 required:false / wait_seconds、apply 任何情况下都不抛回 loader、
                                  #     **slHandoff 不在 inject 里(可选读取)**、**保存→写标记→起脚本的顺序**
                                  #   session-gate(41):多会话检测 —— 三条口径(本轮/子代理/作业)的
                                  #     **只告知不拦截**(在飞时照常写标记 + 经桩发起一次启动,文案点名 id 与原因)/
                                  #     无活在飞 / fail-soft(含"检测不到也不假装没有别的会话");
                                  #     **重启前的交接保存**(在场/缺席/抛错/形态不符/ok:false)与两条真拒绝
                                  #   instance-identity(9):本实例身份解析 + "多 profile 下只命中自己"的判据
                                  #     (与 ps1 同一条正则的 JS 镜像) + 启动命令行带身份 + 静态护栏
                                  #   boot-inject(24,**v0.4.2**):两条注入的合并 —— 取数顺序 / 让位判据 /
                                  #     照旧注入的四种"没人接手"情形 / 兜底两条 / 复查定时器由 ctx.effect 回收
                                  #   lifecycle-cleanup(6,**2026-09-29**):卸载清理 —— ctx.effect 恰好登记一处、
                                  #     工具 disposer 与两个定时器在卸载时被回收、可重复调用且不抛回 cordis
```

### 测试纪律（硬性，2026-09-21 事故换来的）

**放行路径会真的起进程**：`restart_dsh` 经 WMI 创建驱动脚本 ⇒ 几秒后杀掉 dsh 与其它会话。
所以测试与验证脚本必须把**启动原语**换掉，而不是只换日志目录、也不是只看结果文案：

1. **桩打在启动层**：`apply` 的 config 传 `wmiExec`（源码里唯一会 spawn 的那一步 `realExecFile` 被整段替换）。
   断言要写成"桩被调用了几次 / 命令行里是哪个脚本路径"，不要断言自备日志文件里的内容。
2. **假路径兜底**：`restartScript` / `psExe` 指向临时目录下**不存在**的路径 —— 桩万一被摘掉，只剩 ENOENT。
3. **进程级熔断**：测试进程设 `DSH_RESTART_NO_LAUNCH=1`，真实 `execFile` 被直接拒绝。

三道防线任意一道成立都不可能起真实进程；`test/session-gate.test.mjs` 里有专门用例逐条钉住它们
（当年就是"只断言自备日志文件 + 没覆盖 `restartScript`/`psExe`"⇒ 假阴性盖住了真实副作用）。

驱动脚本自己也有隔离演练开关（**不杀任何真实进程**，见脚本头注释）：加 `-SelfLaunchTest`
再配 `-TestDshEntry <假 dsh 脚本>`，端口限定在 39000-39999，就会跳过看门狗换手/回归、
强制走"自行拉起"分支并用假 dsh 替代真实入口；默认不开时行为与生产完全一致：

```powershell
pwsh -File C:\run\tools\dsh-restart.ps1 -SelfLaunchTest -TestDshEntry <假 dsh.js> `
     -ProfileName webtest -Port 39011 -WaitSeconds 0 -LogFile <临时目录>\drill.log
```

回滚（按顺序）：
1. 插件页本卡的总开关停用（写 `dsh.profile.bundles`），或在 profile 的 `cordis.patch.yml`
   里写一行 `- id: restart-dsh` + `disabled: true` 覆写（profile 层在包层之后应用 ⇒ 覆写优先）
   —— 这两条路动的都是 dsh-hmr 监视的输入（profile 的 `package.json` / `cordis.patch.yml`），
   保存即触发重组合，工具消失；
2. `node <工作区>\dsh-plugin-manager\dshpm.mjs remove dsh-host-restart --profile web`
   （在 profile 目录下执行；⚠ 若 `pnpm remove` 报 `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED`，
   改跑 `pnpm remove dsh-host-restart --config.minimum-release-age=0`，见 §5）；
3. 删 `~/.dsh/profiles/web/plugins/dsh-host-restart/`、`C:\run\tools\dsh-restart.ps1`，
   可选删 `C:\run\tools\dsh-restart.log` 与 `~/.dsh/storages/dsh-restart/`；
4. `kill_dsh.bat` 与看门狗保持原样，不受影响。

## 7. 改动这个插件（四步，别跳）

```powershell
# 1) 改源码(唯一真源在 plugins\ 下)
notepad ~\.dsh\profiles\web\plugins\dsh-host-restart\lib\index.js

# 2) 跑测试 —— inject 覆盖自检能挡住"宿主起不来"这类改动
cd ~\.dsh\profiles\web\plugins\dsh-host-restart ; node --test "test/*.test.mjs"

# 3) 同步到真正被加载的那份(直接 add 可能报 Already up to date 而不同步,必须 remove 再 add)
cd ~\.dsh\profiles\web
node <工作区>\dsh-plugin-manager\dshpm.mjs remove dsh-host-restart --profile web
node <工作区>\dsh-plugin-manager\dshpm.mjs add file:./plugins/dsh-host-restart --profile web

# 4) 重启 dsh —— loader 按 URL 缓存模块,改 lib/*.js 必然要重启。
#    最方便的就是让模型调用 restart_dsh:重启后本会话自动续上,还能顺手验证工具本身。
```

包内 `cordis.patch.yml` 属**包层 patch**（同上需同步到副本）：改它不需要重启，但**不会自己触发重组合**
—— dsh-hmr 只监视 profile 的 `cordis.patch.yml`、home 层 `cordis.patch.yml` 与 profile 的 `package.json`
三个输入（`dsh-hmr/lib/index.js:353-376`），包内文件不在其中；重组合时会重读全部 bundle 层，所以改完
要有一次触发才被读入：在插件页点一下本卡（或任意行级）开关，或保存 profile 的 `cordis.patch.yml`
里任意一处改动。只有 `lib/*.js` 这类模块代码受 URL 缓存限制，必须走上面的第 4 步重启。

同步是否真的发生，用 SHA256 对一下两份：

```powershell
Get-FileHash ~\.dsh\profiles\web\plugins\dsh-host-restart\lib\index.js,
             ~\.dsh\profiles\web\node_modules\dsh-host-restart\lib\index.js -Algorithm SHA256
```

两个哈希必须一致 —— **改完源码没同步、或没核对哈希，就等于"改了没生效"**（§8 第 3 条踩过一次）。

不想经历 `remove` 造成的空窗（宿主正在服务用户的会话时）也可以**直接覆盖改动的文件** ——
那等价于 pnpm 对 `file:` 依赖做的实体拷贝，依赖规格没变时 lockfile 无需更新：

```powershell
Copy-Item ~\.dsh\profiles\web\plugins\dsh-host-restart\lib\index.js `
          ~\.dsh\profiles\web\node_modules\dsh-host-restart\lib\index.js -Force
# README 等其它改了文件同理;然后照上面核对 SHA256
```

（本机用 `dshpm` 时固定加 `--no-verify`：它收尾的 `dsh --dump-config` 校验会挂住不返回。）

## 8. 事故记录（2026-09-17，三条都已变成测试或流程）

| 现象 | 根因 | 现在的防线 |
|---|---|---|
| 每次启动 dsh 都在打印带 token 的启动行之前退出，看门狗反复拉起反复崩，浏览器一直卡"启动中" | `ctx.timeout` 是 `timer` 服务的 mixin，而 `inject` 只声明了 `['tools']` —— cordis 对**未声明注入的服务属性访问直接抛错**，apply 抛错 ⇒ 插件树加载失败 ⇒ 整个 dsh 起不来 | `inject = ['tools','timer']`；apply 外层 try/catch（插件永远不该拖垮宿主）；`test/inject-coverage.test.mjs` 静态断言覆盖 |
| 工具始终不出现：`restart_dsh 工具注册失败: parameters.note.required must be true when present` | value-schema DSL 的 `required` 只接受 `true`，可选参数必须**省略**该字段 | 删掉两处 `required: false`；测试断言代码里不再出现 |
| 改了代码却毫无变化（插件一直跑旧逻辑） | `file:` 依赖是实体拷贝，且 pnpm 可能跳过同步：改的是 A 份、加载的是 B 份 | 本节 §7 的 remove+add 流程 + SHA256 比对 |
