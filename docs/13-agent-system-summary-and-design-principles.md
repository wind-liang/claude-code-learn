---
title: "13、从启动到恢复：Claude Code Agent 源码总结"
---

一路读到第 12 篇，前面散在各处的函数才慢慢对上：`main.tsx` 在准备会话，`queryLoop()` 在推进任务，`runToolUse()` 在执行模型给出的动作；`CLAUDE.md`、Skill 和 Memory 决定每一轮多带什么上下文；JSONL 和恢复分支又负责让这段过程在退出或出错后不至于断掉。

单独看，每一篇都只是在回答一个局部问题。把它们按运行顺序排回去，Claude Code 的轮廓会更清楚：它维持一段会话，让模型、工具、上下文和外部状态在多轮里持续配合。

## 先把模型和 Claude Code 分开看

以「检查登录模块」为例。`queryLoop()` 把当前消息、规则和 Tool 定义发给模型后，模型可能选择返回一条 `Grep` Tool Use：搜索 `login|auth`。到这一步为止，模型只给出了一个动作意图；文件还没有被搜索，也没有任何结果可以进入下一轮。

接下来的调用才进入 Claude Code：`runToolUse()` 找到 `GrepTool`，Schema 检查参数，权限层判断是否允许，Tool 执行后把结果包装为带 `tool_use_id` 的 Tool Result，`queryLoop()` 再把结果带回下一次模型请求。模型决定「下一步尝试什么」；Claude Code 决定这个尝试怎样真正发生、怎样被记录，以及失败时还能怎样收尾。

源码里没有一段固定逻辑规定「登录问题必须先 `Grep`，再 `Read`」。模型根据这一轮输入作出选择，Claude Code 则为这个选择准备文件、终端、远程服务等能力，并在真实副作用前后建立校验、权限和恢复边界。

这套承载模型运行的环境通常称为 Agent Harness。所谓「Agent 产品 = 模型 + Harness」，在这里并不是抽象口号：模型给出推理和行动选择，Harness 把选择接到具体项目的上下文、工具和约束上。

图 1 把这个交接点放到一次普通 Tool 调用中：模型提出动作，Claude Code 负责校验、执行和记录；同一条调用链也会在用户中断、工具报错、会话恢复和上下文超限后负责收尾。

![图 1：模型、Harness 与一次 Tool 调用](https://windliangblog.oss-cn-beijing.aliyuncs.com/cc-agent-summary-13-harness-20260814-7f9a2.png)

最小闭环只有「模型提出 Tool Use → 程序执行 → 结果回到模型」。前 12 篇增加的模块没有另起一条决策主线，它们分别补上能力、信息、边界和连续性。

## Harness 工程师到底在做什么

落到工程里，Harness 工程主要在补下面五件事：

| 工程工作 | 在 Claude Code 源码中落到哪里 | 解决的实际问题 |
| --- | --- | --- |
| 把外部能力做成可靠的行动接口 | Tool 的 Schema、`runToolUse()`、Tool Result，以及 MCP 的适配层。 | 模型给出的是名称和参数；文件、终端或远程 API 的真实调用必须能校验、执行并回传结果。 |
| 把领域知识放到合适的位置 | `CLAUDE.md`、Skill、Memory 和上下文压缩。 | 规则、方法和历史不能全部挤进第一轮请求，需要让相关内容在需要时出现。 |
| 给副作用划出边界 | `canUseTool()`、Tool 专属权限规则和用户确认。 | 模型能提出动作，不等于动作可以直接发生；写文件、执行命令和调用外部系统都要有明确的授权点。 |
| 让长任务保持连续 | `queryLoop()` 的状态、子 Agent、JSONL、`parentUuid` 和恢复路径。 | 多轮调用、分叉会话和进程退出后，任务不能只靠「上一段文本」猜测当前进度。 |
| 留下可追踪的运行记录 | `tool_use_id`、`transition`、Tool Result、Tombstone 和会话记录。 | 出错时需要判断哪一步已经执行、哪些展示可以撤回、哪些外部副作用只能补偿或停止。 |

这些工作都围绕同一件事：模型负责判断下一步，Harness 负责让这个判断在真实环境中有能力可用、有信息可看、有边界可守，也有过程可追。源码没有把「检查登录模块」硬编码成一套固定步骤，工程的重点落在让不同任务都能复用同一套运行条件。

## 12 篇回到同一条路径

一次典型任务「检查登录模块」会沿着下列顺序推进：

1. `claude` 命令找到入口，解析参数，组装一次会话；
2. `queryLoop()` 把用户消息发给模型；
3. 模型流返回文本或 Tool Use；
4. Tool 系统校验、授权并执行 `Grep`、`Read`、`Bash` 等能力；
5. Tool Result 进入消息历史，主循环再请求模型；
6. `CLAUDE.md`、Skill、Memory、MCP 等信息按各自的时机进入上下文；
7. 会话过程写入磁盘，必要时可以恢复；
8. 请求失败、输出截断或输入超限时，按错误发生的位置选择恢复路径。

第 2 到第 5 步是最小的 Agent 闭环。后面的模块并没有离开这条闭环：它们分别处理能力从哪里来、模型每轮看到什么、任务怎样拆开、进程退出后怎样接续，以及错误发生后怎样避免把状态留在半路。

图 2 将这条闭环放在中间。箭头指向循环的模块不会各自再开一条 Agent 主线：它们只在准备请求、更新能力、处理异常或恢复会话时，改变下一次循环的输入与状态。

![图 2：12 篇回到同一条路径](https://windliangblog.oss-cn-beijing.aliyuncs.com/cc-agent-summary-13-overview-20260814-7f9a1.png)

## 一条循环，同时维护四类事实

顺着前 12 篇的调用关系，可以把 Claude Code 运行时维护的内容归成四类。它们都围绕 `queryLoop()` 运转，但回答的不是同一个问题。

| 需要对上的事实 | 对应源码中的主要载体 | 解决的问题 |
| --- | --- | --- |
| 模型当前能知道什么 | `messages`、`userContext`、`ToolUseContext.options.tools` | 下一次请求带哪些历史、规则和 Tool Schema。 |
| 系统已经做了什么 | `tool_use_id`、`tool_result`、文件修改与 Shell 输出 | 一次模型意图是否已被校验、执行，并且结果能否对应回原调用。 |
| 当前会话怎样走到这里 | `State.transition`、`turnCount`、`parentUuid` | 此刻为什么继续、从哪里恢复，以及并行结果应当连接到哪条消息。 |
| 出错后还允许做什么 | `AbortController`、Fallback、压缩状态、Tombstone | 可以重试、可以撤回显示，还是只能补偿并停止。 |

这张表也把许多看似独立的模块放回了同一处：Skill、Memory、MCP 都在改变「模型当前能知道什么」；权限和 Tool 在约束「系统已经做了什么」；JSONL 和恢复保存「会话怎样走到这里」；第 12 篇的分支则判断「出错后还允许做什么」。

## 每一篇最后对上了什么

| 篇章 | 顺着源码走到哪里 | 这一段最后说明了什么 |
| --- | --- | --- |
| [01：从 `claude` 命令到会话启动](https://cc.windliang.wang/01-claude-command-to-agent-loop.html) | `cli.tsx` 选择入口，`main.tsx` 初始化进程，`run()` 注册命令并由 `.action()` 装配会话。 | 启动阶段不执行任务本身，它负责把参数、配置、权限、模型、Tools 和运行适配器装进同一次会话。快速命令延迟加载重模块，避免无关启动成本。 |
| [02：`queryLoop` 与 Agent 主循环](https://cc.windliang.wang/02-query-loop.html) | 用户消息进入 `query()`，`queryLoop()` 重复「请求模型 → 执行 Tool → 写回结果」。 | Agent 不是「多次调用模型」这么简单；`messages`、`turnCount` 和 `transition` 让每次继续都有可以追踪的状态。 |
| [03：一次模型回答如何流进 Agent](https://cc.windliang.wang/03-streaming-model-call-and-failure-recovery.html) | API 事件流在 `queryModel()` 中被拼成 `AssistantMessage`，再交回 `queryLoop()`。 | 终端看到的流式碎片与主循环保存的正式消息是两套数据。内容块完整后，模型的 Tool Use 才能交给执行层；流失败后，旧展示还要撤回。 |
| [04：Tool 工具系统](https://cc.windliang.wang/04-tool-system-from-schema-to-side-effects.html) | 完整 Tool Use 经由 Schema、Hook、权限、`tool.call()` 和 Tool Result 回到主循环。 | 模型只提出调用意图。参数校验、授权、执行和结果回写由代码接管，`tool_use_id` 与 `tool_result.tool_use_id` 保持一次调用和结果的对应关系。 |
| [05：权限系统与安全边界](https://cc.windliang.wang/05-permission-system-and-security-boundaries.html) | `canUseTool()` 进入通用规则和 Tool 专属规则，得到 `allow`、`deny` 或 `ask`。 | 通用层不解释 Bash 命令等具体语义，Tool 自己补充这部分判断。`ask` 会暂停原有调用，用户决定后再从这条调用链继续。 |
| [06：上下文的发现、注入与压缩](https://cc.windliang.wang/06-context-lifecycle-from-claude-md-to-compaction.html) | 根目录规则进入 `userContext`；读取文件后，局部 `CLAUDE.md` 以附件补入；消息过长时再整理历史。 | 稳定指令、按路径出现的局部规则、历史消息和 Tool Result 不在同一时刻产生，也不该用同一种方式维护。 |
| [07：Skill 如何进入 Agent](https://cc.windliang.wang/07-skills-from-discovery-to-execution.html) | `SKILL.md` 先变成运行时 `Command`；模型先看目录，再经 `Skill` Tool 展开正文。 | Skill 是一份按需进入上下文的工作方法。名称和描述先参与选择，正文、脚本路径和参数只在选中后出现。 |
| [08：Memory 如何写入、整理与召回](https://cc.windliang.wang/08-memory-and-agentic-rag.html) | 长期信息保存为「`MEMORY.md` 索引 + 正文文件」；启动后预取并用 `sideQuery()` 选择相关内容。 | 记忆不靠把全部历史塞进 Prompt。索引帮助发现，正文提供细节，预取、写入和整理各自有独立时机。 |
| [09：子 Agent 如何分叉、继续与回到父会话](https://cc.windliang.wang/09-subagents-forking-and-recovery.html) | `AgentTool.call()` 启动独立 `query()`；子会话结束后，结果沿 Tool 调用栈回到父 `queryLoop()`。 | 子 Agent 把一段工具调用很多的工作隔离在独立会话中，父会话拿到的是足够继续判断的结论，而不是全部中间过程。 |
| [10：MCP 外部工具如何进入下一轮 Agent 调用](https://cc.windliang.wang/10-mcp-and-dynamic-tool-discovery.html) | 配置启动 Server，`tools/list` 发现声明，内部适配后在下一轮成为模型可见 Tool。 | 连接得到的动态能力先进入状态；下一轮才变成固定 Tool 快照。内部名称和 MCP Server 接收的原始名称也分开保存。 |
| [11：一段会话怎样保存、恢复与续写](https://cc.windliang.wang/11-session-persistence-resume-and-remote.html) | 消息追加到 JSONL；`--resume` 从记录中沿 `parentUuid` 找回有效链。 | 恢复会话需要保存消息关系，不只是文本。Tool Result 还要指向发起 Tool Use 的 Assistant Message，恢复时才能找回正确的主链。 |
| [12：错误处理与自动恢复](https://cc.windliang.wang/12-production-agent-recovery-observability-and-testability.html) | 请求重试、输出截断续写、输入压缩、用户中断和运行时错误分别在不同阶段处理。 | 错误发生在请求前、流中、Tool 执行中还是中断后，决定了是否能重试、该保留什么和该怎样结束。恢复状态也要留下记录，才有办法验证。 |

### 1. `messages` 不是普通数组，`State` 也不只是缓存

第 2 篇里，`queryLoop()` 每次请求都会以 `messages` 为基础构造模型输入；第 6 篇里的压缩和第 12 篇里的恢复，又可能替换其中的一段历史。它更接近「当前会话已经确认、可以再次交给模型的事实记录」，而不是随手放变量的容器。

但仅有消息还不够。`turnCount`、`transition`、输出上限和压缩标记放在 `State` 中，记录的是「循环控制到了哪里」。两者被刻意分开：消息回答「模型知道了什么」，状态回答「程序下一步为什么这样走」。

第 2 篇还留下一个容易被忽略的判断：`needsFollowUp` 最终看的是正式消息内容中是否真的有 `tool_use`，而不是只相信 API 的 `stop_reason`。源码注释直接标明后者并不总是可靠；控制流因此依赖已经确认的内容块。

这也是 `queryLoop()` 看起来比简单 `while` 更长的原因。Agent 每轮既要维护对话事实，也要维护控制事实；把两者混进一条 Prompt 或一个布尔变量，恢复、测试和排错都会失去落点。

### 2. 流式输出有「展示」和「提交」两个时刻

第 3 篇追到 `queryModel()` 时，网络一到数据就可以产生 `StreamEvent`，终端因此能立即显示文字和正在生成的 Tool 参数。但 `content_block_stop` 之前，参数 JSON 仍可能不完整；只有内容块完成，代码才产出可写进 `assistantMessages` 的正式消息。

这不是单纯为了动画效果。模型流相当于在逐步暴露一个候选结果，内容块结束才是这份结果可以参与下一步执行的提交点。流式 Fallback 触发时，`Tombstone` 撤销的是已经展示或写入会话的旧消息；它并不撤销 Tool 对文件或 Shell 已经产生的副作用。

这层区分还落在一个很细的实现上：源码会为需要展示的派生字段克隆一份消息再 `yield`，而留给 `assistantMessages`、后续 API 请求和 transcript 的原始消息不被修改。注释直接指出，修改原消息会让 Prompt Cache 的字节前缀不再匹配。流式展示、会话事实和缓存输入因此不能共用一份可随意改写的对象。

从这里能看到一个容易被忽略的边界：界面状态可以补偿，外部世界通常不能。第 3、4、12 篇里的重试和收尾逻辑，都是围绕这条边界展开的。

### 3. Tool 的重点：把不可信意图变成可治理动作

第 4 篇的 `runToolUse()` 没有直接按 `name` 调用函数。模型给出的 `tool_use` 会经过 Schema、Hook、权限和 Tool 本身的执行逻辑，最后才得到 Tool Result。

其中最小却很关键的一点是 `tool_use_id`：它作为调用协议的一部分，把请求和结果绑定在一起。模型给出 `toolu_01`，对应结果必须带回同一个 ID。下一轮模型才能知道「这段搜索结果对应刚才哪一次 `Grep`」，并行 Tool Use 也不会串到一起。

这条链说明，Tool 的边界应当落在「参数、授权、执行、结果」四件事上，而不是只给现有 API 加一个自然语言描述。模型负责提出计划，执行层负责把计划限制在系统允许的范围内。

### 4. 并发执行不等于并发提交状态

第 4 篇的 `partitionToolCalls()` 不在「全部串行」和「全部 `Promise.all()`」之间二选一。相邻且明确声明 `isConcurrencySafe()` 的 Tool Use 会组成一批并行执行；遇到不安全的调用，再切回新的串行边界。

更关键的是，Tool 的完成顺序不会直接决定共享状态的写入顺序。并发 Tool 的 `contextModifier` 先按 `tool_use_id` 收集，整批结束后，再按模型最初给出的 Tool Use 顺序应用。这样可以让 `Read`、`Grep` 等安全工作并行，又不会因为某个 Promise 先完成而让下一轮上下文变得不确定。

可以把同一批 Tool Use 想成模型依次写下的 A、B 两个任务。A 和 B 可以同时开始；B 即使先完成，也不该因此先改变下一轮上下文。等这一批都结束后，源码仍按模型写下 A、B 的顺序合并它们带来的状态变化。

这样一来，执行快慢只影响等待时间，不会改变下一轮模型究竟看见什么。并发的是互不冲突的工作；会影响消息、权限上下文或后续调度的共享状态，仍需要一个固定的提交顺序。

### 5. 权限确认是一段暂停的控制流

第 5 篇中的 `ask` 很容易被看成「弹一个确认框」。顺着 `canUseTool()` 往下看，它实际保留了原来的 Promise；用户点击允许或拒绝后，`resolveOnce()` 才让这次 Tool 调用从暂停点继续。

因此，权限层没有重新请求模型，也没有重新跑整个任务。它只在真正要触发副作用的地方暂停，并且用 `claim()` 防止界面、Hook 或其他路径同时给出多个决定。

这种写法把交互选择变成正常的异步控制流。对于付费操作、部署操作、数据删除等能力，同样可以把「等待确认」放在操作边界，而不是散落到上层页面逻辑里。

### 6. 上下文管理：用分层检索控制 Prompt 的信息密度

第 6、7、8 篇起初像三个不同主题，最后却在处理同一个上下文预算问题：

- 根目录 `CLAUDE.md` 是稳定的规则，随请求进入 `userContext`；
- 读取某个路径后，局部 `CLAUDE.md` 才作为附件出现；
- Skill 目录先让模型知道可用的方法，选中后才展开 `SKILL.md` 正文；
- Memory 先用 `MEMORY.md` 提供索引，再用 `sideQuery()` 选择可能相关的正文；
- 大 Tool Result 和旧消息接近预算时，再持久化、替换或压缩。

这些做法共同形成一种「先给索引，后给内容」的层次。token 预算仍是硬边界；是否让一段内容占用这份预算，取决于它是否已经和当前任务相关。

### 7. 上下文的稳定前缀同时关系到 Prompt Cache

第 10 篇里，`assembleToolPool()` 组装 Tool 时会先放稳定的内置 Tool，再放排序后的 MCP Tool。源码注释明确把这段顺序和 Anthropic API 的服务端 Prompt Cache 联系起来：system prompt、model、Tools 和消息前缀都会影响缓存命中。

这段排序处理对应服务端的全局缓存断点：断点位于最后一个可匹配的内置 Tool 后面。如果把 MCP Tool 按名称混进内置 Tool 中间，某个 Server 新增或删除 Tool 时，后面所有内置 Tool 的缓存键都会一起失效。把两类 Tool 分区排序，保住的是一段尽可能长的稳定前缀。

第 9 篇的 fork 子 Agent 也会专门构造可复用的消息前缀，让父子会话尽量共享同一段缓存。Prompt 组织因此不只是「能不能放进上下文窗口」的问题：稳定前缀可复用服务端已有的 KV Cache，动态内容则应尽量局部化，减少重复的前缀计算。

Skill 延迟展开和 Memory 按需读取直接解决的是当前轮的上下文预算；MCP Tool 的分区排序则是源码明确为缓存稳定性写下的实现。两者关注点不同，但都要求把变化尽量限制在请求的后半段。

### 8. 动态能力在源码中隔一轮才生效

第 10 篇中，MCP Server 连接成功后，`tools/list` 的结果先写入 `appState.mcp.tools`；正在运行的本轮不会立刻多出一个可调用 Tool。下一轮构建 `ToolUseContext` 时，才把最新状态固化成这一轮可见的 Tool 集合。

从「先写状态、下一轮再构造 `ToolUseContext`」的调用顺序可以推断，这个时间差是在让一次模型请求使用一致的 Tool 快照。假如模型已经开始生成 Tool Use，另一边 MCP Server 又在增删能力，那么这一轮的 Schema、权限配置和真实执行器可能不再对应。

同样地，Skill 目录和权限上下文都会在进入调用链前固定下来；一轮运行中，模型可见能力和可执行边界不会半途变化。

### 9. 子 Agent、会话恢复和并行 Tool 都依赖「关系」，不只依赖文本

第 9 篇中，子 Agent 有独立的 `query()`、独立会话记录和自己的 Tool 过程，父 Agent 最终只收一条结果。第 11 篇恢复会话时，又需要从 JSONL 的 `parentUuid` 链条里找出当前主会话。

这两部分说明，消息不能只是按时间排列的文本列表。并行 Tool Result 可能同时指回同一条 Assistant Message，子 Agent 又会产生 Sidechain；如果只依赖「上一条消息」，完成顺序一变，恢复链就会连错。`sourceToolAssistantUUID` 和 `parentUuid` 保存的正是这种关系。

### 10. 自动恢复先判断证据，再决定重试、补偿或停止

第 12 篇把错误分成请求未返回、输出截断、输入过长、媒体过大、Tool 失败和用户中断。分类依据是每个阶段手上掌握的证据不同：

- `withRetry()` 处理的是还没有有效 Assistant Message 的请求失败，重发不会和界面中的旧结果冲突；
- 流已经产出消息再 Fallback 时，先发 Tombstone 清理旧展示；
- 输出截断时，已经拿到的内容可以保留，并尝试提高输出上限或追加续写消息；
- 输入超限时，代码先替换或压缩输入，原样重发没有意义；
- Tool 已经改文件或执行 Shell 后，`discard()` 只能丢掉队列和内存结果，不能撤销真实副作用；
- 用户中断表达的是明确停止，不能伪装成网络错误自动继续。

这说明 Agent 的恢复更接近补偿操作，而不是数据库事务。先确认「已经对外发生了什么」，再决定能重试、能撤回显示，还是只能明确结束并留下可解释的结果。

### 11. 可测试性要跟着恢复路径一起设计

第 12 篇里，`queryLoop()` 的 `State.transition` 会留下本轮为何继续；`QueryDeps` 又把模型调用、压缩等依赖从循环主体抽出来。两者组合后，测试不必真的等待一次网络超时，仍能验证「输入过长后是否进入压缩重试」「截断后是否生成续写消息」。

这比只给函数打 mock 更进一步：恢复路径本身有可观察的状态，外部依赖也可以替换。对于多轮、异步、带副作用的 Agent，这种可观察性往往决定了线上问题能否稳定复现。

## 小结

Claude Code 由模型能力和 Harness 共同构成。模型读入消息并提出动作；Harness 则负责让循环能够使用 Tool、规则、Skill、Memory、权限、会话恢复和可观察状态，并将 Tool Result 写回消息，让任务能够连接外部世界并在多轮中持续推进。

因此，Claude Code 的复杂处不在于替模型安排思考步骤，而在于让每一次模型判断都落在同一套可验证的运行环境里：模型看到的事实、系统实际执行的动作、会话记录的关系，以及异常后可以继续使用的状态，要始终对得上。
