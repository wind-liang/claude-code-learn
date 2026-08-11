---
title: "9、子 Agent 如何分叉、继续与回到父会话"
---

第 4 篇走到 `runToolUse()` 时，每个模型返回的 `tool_use` 都会交给对应 Tool。`Agent` 也在这张 Tool 表里，`call()` 内部会再启动一次 `query()`。

这里的子 Agent 指父 Agent 通过 `Agent` Tool 启动的一段独立会话。它有自己的消息历史和 Tool 循环；同步运行结束后，父 Agent 收到的是这次 `Agent` Tool Use 对应的 Tool Result。

假设当前任务是检查登录失败为什么没有留下审计日志。父 Agent 先看到了用户输入和前面已经做过的工作，随后模型返回下面这次 Tool Use：

```javascript
// 函数体：src/query.ts::queryLoop()
async function* queryLoop(state) {
  // ...
  for await (const message of callModelAndForwardMessages()) {
    if (message.type === 'assistant') {
      const msgToolUseBlocks = message.message.content.filter(
        block => block.type === 'tool_use',
      )
      // 运行值 message.message.content => [
      //   {
      //     type: 'tool_use',
      //     id: 'toolu_agent_01',
      //     name: 'Agent',
      //     input: {
      //       subagent_type: 'Explore',
      //       description: '查找审计日志调用链',
      //       prompt: '只读检查登录失败路径，找出审计日志写入位置和缺失位置。返回涉及的文件与调用关系。',
      //     },
      //   },
      // ]
      toolUseBlocks.push(...msgToolUseBlocks)
      needsFollowUp = true
    }
  }
  // 源码位置：src/query.ts:1380-1395
  const toolUpdates = runTools(
    toolUseBlocks,
    assistantMessages,
    canUseTool,
    toolUseContext,
  )
  for await (const update of toolUpdates) {
    yield update
  }
  // ...
}
```

`Agent` Tool 由父循环执行。它创建的子 Agent 可以读取、搜索、调用模型并完成自己的多轮循环；父循环最后收到的是一份 Tool Result，其中保存子 Agent 的最终文本结论，部分 Agent 还会附带使用统计。

![图 1：一次普通子 Agent 从 Tool Use 到 Tool Result](https://windliangblog.oss-cn-beijing.aliyuncs.com/diagram-01.png)

这篇沿着图中的同步 `Explore` 路径向下走。后面再对照两条容易混在一起的分支：继承父对话的 fork，以及已停止子 Agent 的 resume。

## 1. 从 `runToolUse()` 进入 `AgentTool.call()`

第 4 篇中，`runToolUse()` 会根据 `toolUse.name` 找到 Tool，再把完整 Tool Use 的 `input` 传给 `tool.call()`。这次调用因此落在 `AgentTool.call()`。

源码位置：`src/services/tools/toolExecution.ts`、`src/tools/AgentTool/AgentTool.tsx:196-499`

```javascript
// 函数体：src/tools/AgentTool/AgentTool.tsx::AgentTool.call()
// 源码位置：230-245
async function call(
  {
    prompt,
    subagent_type,
    description,
    run_in_background,
  },
  toolUseContext,
  canUseTool,
  assistantMessage,
) {
  // prompt => '只读检查登录失败路径，找出审计日志写入位置和缺失位置。返回涉及的文件与调用关系。'
  // subagent_type => 'Explore'
  // description => '查找审计日志调用链'
  // run_in_background => undefined
  // assistantMessage.message.content 中包含：
  // {
  //   type: 'tool_use',
  //   id: 'toolu_agent_01',
  //   name: 'Agent',
  //   input: {
  //     subagent_type: 'Explore',
  //     description: '查找审计日志调用链',
  //     prompt: '只读检查登录失败路径，找出审计日志写入位置和缺失位置。返回涉及的文件与调用关系。',
  //   },
  // }
}
```

这次调用先根据 `subagent_type` 在启动阶段加载的 `agentDefinitions.activeAgents` 中查找定义。`Explore` 是内置的代码探索 Agent：定义明确禁用 `Agent`、`Edit`、`Write`、`NotebookEdit` 和 `ExitPlanMode`，并使用面向搜索与报告的 System Prompt。

源码位置：`src/tools/AgentTool/AgentTool.tsx:339-387`、`src/tools/AgentTool/built-in/exploreAgent.ts:59-77`

```javascript
// 函数体：src/tools/AgentTool/AgentTool.tsx::AgentTool.call()
// 源码位置：339-387
async function call({ subagent_type }, toolUseContext) {
  // ...
  const effectiveType = subagent_type ?? GENERAL_PURPOSE_AGENT.agentType
  // subagent_type => 'Explore'
  // effectiveType => 'Explore'

  const allAgents = toolUseContext.options.agentDefinitions.activeAgents
  // => [
  //   {
  //     agentType: 'general-purpose',
  //     tools: ['*'],
  //     model: undefined,
  //     source: 'built-in',
  //   },
  //   {
  //     agentType: 'Explore',
  //     disallowedTools: ['Agent', 'Edit', 'Write', 'NotebookEdit', 'ExitPlanMode'],
  //     model: 'haiku',
  //     omitClaudeMd: true,
  //     source: 'built-in',
  //   },
  // ]

  const selectedAgent = allAgents.find(
    agent => agent.agentType === effectiveType,
  )
  // => {
  //   agentType: 'Explore',
  //   disallowedTools: ['Agent', 'Edit', 'Write', 'NotebookEdit', 'ExitPlanMode'],
  //   model: 'haiku',
  //   omitClaudeMd: true,
  //   source: 'built-in',
  // }
  // ...
}
```

`Agent` Tool 根据名称选择并启动 Agent 定义；子 Agent 的 System Prompt、工具集合、模型和权限模式由这份定义提供。`Explore` 的定义同时给出面向探索的提示和禁用 Tool 列表。

## 2. 普通子 Agent 的消息历史从新任务开始

选定 `Explore` 后，`AgentTool.call()` 先把 `prompt` 包装成一条新的 User Message，再把它传给 `runAgent()`。普通路径的 `forkContextMessages` 为 `undefined`，因此不会把父会话的历史消息拼进来。

源码位置：`src/tools/AgentTool/AgentTool.tsx:512-540`、`src/tools/AgentTool/AgentTool.tsx:603-636`

```javascript
// 函数体：src/tools/AgentTool/AgentTool.tsx::AgentTool.call()
// 源码位置：512-540、603-636
async function call({ prompt }, toolUseContext, canUseTool) {
  const promptMessages = [
    createUserMessage({
      content: prompt,
    }),
  ]
  // prompt => '只读检查登录失败路径，找出审计日志写入位置和缺失位置。返回涉及的文件与调用关系。'
  // promptMessages => [
  //   {
  //     type: 'user',
  //     isMeta: false,
  //     uuid: 'user_agent_01',
  //     message: {
  //       role: 'user',
  //       content: '只读检查登录失败路径，找出审计日志写入位置和缺失位置。返回涉及的文件与调用关系。',
  //     },
  //   },
  // ]

  const runAgentParams = {
    agentDefinition: selectedAgent,
    promptMessages,
    toolUseContext,
    canUseTool,
    isAsync: shouldRunAsync,
    querySource:
      toolUseContext.options.querySource ??
      getQuerySourceForAgent(
        selectedAgent.agentType,
        isBuiltInAgent(selectedAgent),
      ),
    availableTools: workerTools,
    forkContextMessages: undefined,
  }
  // shouldRunAsync => false
  // querySource => 'agent:builtin:Explore'
  // forkContextMessages => undefined

  return runAgent(runAgentParams)
}
```

「从新任务开始」只描述消息历史，不表示请求只有这一条消息。`runAgent()` 仍会构建子 Agent 自己的 System Prompt、`userContext` 和 `systemContext`；普通路径不带入的是父 Agent 已经积累的用户对话、Tool Use 和 Tool Result。

接着看 `runAgent()` 怎样把这份输入变成独立的 `ToolUseContext`：

源码位置：`src/tools/AgentTool/runAgent.ts:368-379`、`src/tools/AgentTool/runAgent.ts:697-757`

```javascript
// 函数体：src/tools/AgentTool/runAgent.ts::runAgent()
// 源码位置：368-379、697-757
async function* runAgent({
  toolUseContext,
  promptMessages,
  forkContextMessages,
  override,
  agentDefinition,
  availableTools,
  isAsync,
  agentGetAppState,
}) {
  const agentId = override?.agentId ?? createAgentId()
  // agentId => 'agent_explore_01'

  const contextMessages = forkContextMessages
    ? filterIncompleteToolCalls(forkContextMessages)
    : []
  // forkContextMessages => undefined
  // contextMessages => []

  const initialMessages = [
    ...contextMessages,
    ...promptMessages,
  ]
  // initialMessages => [
  //   {
  //     type: 'user',
  //     message: {
  //       role: 'user',
  //       content: '只读检查登录失败路径，找出审计日志写入位置和缺失位置。返回涉及的文件与调用关系。',
  //     },
  //   },
  // ]

  const agentReadFileState = forkContextMessages !== undefined
    ? cloneFileStateCache(toolUseContext.readFileState)
    : createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
  // agentReadFileState => 空的文件状态缓存

  const resolvedTools = resolveAgentTools(
    agentDefinition,
    availableTools,
    isAsync,
  ).resolvedTools
  // resolvedTools 不包含 Explore 禁用的 Agent、Edit、Write、
  // NotebookEdit 与 ExitPlanMode。

  const agentToolUseContext = createSubagentContext(toolUseContext, {
    options: { ...toolUseContext.options, tools: resolvedTools },
    agentId,
    agentType: agentDefinition.agentType,
    messages: initialMessages,
    readFileState: agentReadFileState,
    abortController: toolUseContext.abortController,
    getAppState: agentGetAppState,
    shareSetAppState: !isAsync,
  })
  // agentToolUseContext.agentId => 'agent_explore_01'
  // agentToolUseContext.messages => initialMessages
  // agentToolUseContext.queryTracking.depth => 1

  // 后面省略：构建 System Prompt、userContext、systemContext，
  // 再调用 query()。
}
```

普通路径的文件状态缓存从空开始，消息历史只含这次任务；第 6 节的 fork 路径才会传入父会话消息，并克隆父 Agent 的文件状态缓存。

## 3. `runAgent()` 仍然调用同一个 `query()`

上下文准备好后，`runAgent()` 进入第 2 篇中的 `query()`。子 Agent 也会走「模型返回 Tool Use → 执行 Tool → 下一轮模型请求」的循环，只是使用它自己的 System Prompt、工具池和消息数组。

源码位置：`src/tools/AgentTool/runAgent.ts:747-805`

```javascript
// 函数体：src/tools/AgentTool/runAgent.ts::runAgent()
// 源码位置：747-805
async function* runAgent({
  initialMessages,
  agentSystemPrompt,
  userContext,
  systemContext,
  canUseTool,
  agentToolUseContext,
  querySource,
  maxTurns,
}) {
  // agentToolUseContext.agentId => 'agent_explore_01'
  // 先保存子 Agent 的初始消息。
  void recordSidechainTranscript(
    initialMessages,
    agentToolUseContext.agentId,
  )
  // 初始文件路径形如：
  // ~/.claude/projects/-Users-me-shop/session_01/subagents/agent-agent_explore_01.jsonl
  // 文件中的第一条消息是：
  // {
  //   type: 'user',
  //   message: {
  //     role: 'user',
  //     content: '只读检查登录失败路径，找出审计日志写入位置和缺失位置。返回涉及的文件与调用关系。',
  //   },
  // }
  let lastRecordedUuid = initialMessages.at(-1)?.uuid ?? null
  // lastRecordedUuid => 'user_agent_01'

  for await (const message of query({
    messages: initialMessages,
    // => [
    //   {
    //     type: 'user',
    //     message: {
    //       role: 'user',
    //       content: '只读检查登录失败路径，找出审计日志写入位置和缺失位置。返回涉及的文件与调用关系。',
    //     },
    //   },
    // ]
    systemPrompt: agentSystemPrompt,
    // => Explore 的只读搜索提示。
    userContext,
    systemContext,
    canUseTool,
    toolUseContext: agentToolUseContext,
    querySource,
    // querySource => 'agent:builtin:Explore'
    maxTurns,
  })) {
    if (isRecordableMessage(message)) {
      await recordSidechainTranscript(
        [message],
        agentToolUseContext.agentId,
        lastRecordedUuid,
      )
      yield message
    }
  }
  // ...
}
```

一次可能的子循环如下。父 Agent 在等待这次 `Agent` Tool 返回；`Explore` 在自己的循环中完成 `Grep` 和 `Read`。

```text
// 函数体：src/tools/AgentTool/runAgent.ts::runAgent() 调用的 query() 循环。
子 Agent 第 1 轮：Grep('audit|auditLog', 'src')
子 Agent 第 2 轮：Read('src/auth/login.ts') 与 Read('src/services/audit.ts')
子 Agent 第 3 轮：返回文本结论
```

每条可记录消息都会写入 `agent_explore_01` 对应的 sidechain transcript。它保存的是子 Agent 自己的会话记录，和主会话的 transcript 分开。第 7 节中可继续的 `general-purpose` Agent 也使用同一种 transcript 保存过程。

`sidechain transcript` 就是这份按子 Agent 单独保存的消息链。`getAgentTranscriptPath()` 把它放在当前会话目录的 `subagents/agent-{agentId}.jsonl` 文件中。`runAgent()` 开始时先写入 `initialMessages`，循环中每产出一条可记录消息再追加一次；主会话的 transcript 不会混入这条链。之后 `resumeAgentBackground()` 通过同一个 `agentId` 读取文件，重建这个子 Agent 自己的历史消息，再追加追问。

源码位置：`src/tools/AgentTool/runAgent.ts:731-798`、`src/utils/sessionStorage.ts:247-262`、`src/utils/sessionStorage.ts:1451-1460`、`src/utils/sessionStorage.ts:4190-4234`

从调用关系能直接看到，普通子 Agent 复用了完整的 `query()` 循环，同时把「任务范围」「可见消息」「可用 Tool」放进独立容器。父会话只等待它的收口结果。

## 4. 子 Agent 的结果怎样回到父循环

第 3 节追的是 `AgentTool.call()` 内部启动的 `runAgent()`；第 4 节回到父会话的调用栈。两者之间的关系是：

1. 父 `queryLoop()` 把模型给出的 `Agent` Tool Use 交给 `runTools()`；
2. `runTools()` 再调用 `runToolUse()`；
3. `runToolUse()` 经过通用校验后调用 `AgentTool.call()`；
4. `AgentTool.call()` 启动并消费 `runAgent()`；
5. `runAgent()` 结束后，调用链反向返回，最终由 `runToolUse()` 向父 `queryLoop()` 产出 Tool Result。

因此，`runToolUse()` 是父会话执行一次 Tool 调用的入口，`runAgent()` 是这次调用内部运行子会话的函数。第 3 节讲第 4 步内部的子循环；这一节讲它结束后怎样沿原调用链回到父循环。

图中上半部分是第 1～3 节已经走过的「进入子会话」路径；下半部分从 `runAgent()` 结束开始，依次回到 `AgentTool.call()`、`runToolUse()`、`runTools()`，最后才回到父 `queryLoop()`。

![图 2：子 Agent 结果沿调用栈回到父会话](https://windliangblog.oss-cn-beijing.aliyuncs.com/diagram-02.png)

下面从 `runToolUse()` 开始。它收到 `toolu_agent_01` 后按名称找到 `AgentTool`，再把调用交给通用执行函数。

源码位置：`src/services/tools/toolExecution.ts:337-489`

```javascript
// 函数体：src/services/tools/toolExecution.ts::runToolUse()
// 源码位置：337-489
export async function* runToolUse(
  toolUse,
  assistantMessage,
  canUseTool,
  toolUseContext,
) {
  const tool = findToolByName(
    toolUseContext.options.tools,
    toolUse.name,
  )
  // toolUse => {
  //   type: 'tool_use',
  //   id: 'toolu_agent_01',
  //   name: 'Agent',
  //   input: {
  //     subagent_type: 'Explore',
  //     prompt: '检查登录失败路径是否写入安全审计日志。',
  //   },
  // }
  // tool.name => 'Agent'

  // 前面还会处理未知 Tool 与用户中断。
  // ...
  for await (const update of streamedCheckPermissionsAndCallTool(
    tool,
    toolUse.id,
    toolUse.input,
    toolUseContext,
    canUseTool,
    assistantMessage,
    assistantMessage.message.id,
    assistantMessage.requestId,
    getMcpServerType(toolUse.name, toolUseContext.options.mcpClients),
    getMcpServerBaseUrlFromToolName(
      toolUse.name,
      toolUseContext.options.mcpClients,
    ),
  )) {
    yield update
  }
}
```

`streamedCheckPermissionsAndCallTool()` 只是把进度与最终结果合成可迭代输出；它会调用 `checkPermissionsAndCallTool()`。权限、Hook 和 Schema 校验完成后，这个函数才执行 `tool.call()`。由于 `tool` 是上面查到的 `AgentTool`，这里实际进入 `AgentTool.call()`。

源码位置：`src/services/tools/toolExecution.ts:492-576`、`src/services/tools/toolExecution.ts:599-1480`

```javascript
// 函数体：src/services/tools/toolExecution.ts::streamedCheckPermissionsAndCallTool()
// 源码位置：492-576
function streamedCheckPermissionsAndCallTool(
  tool,
  toolUseID,
  input,
  toolUseContext,
  canUseTool,
  assistantMessage,
  messageId,
  requestId,
  mcpServerType,
  mcpServerBaseUrl,
) {
  const stream = new Stream()

  checkPermissionsAndCallTool(
    tool,
    toolUseID,
    input,
    toolUseContext,
    canUseTool,
    assistantMessage,
    messageId,
    requestId,
    mcpServerType,
    mcpServerBaseUrl,
    progress => {
      stream.enqueue({
        message: createProgressMessage({
          toolUseID: progress.toolUseID,
          parentToolUseID: toolUseID,
          data: progress.data,
        }),
      })
    },
  )
    .then(results => {
      for (const result of results) stream.enqueue(result)
    })
    .catch(error => stream.error(error))
    .finally(() => stream.done())

  return stream
}
```

第 3 步发生在 `AgentTool.call()`。同步运行时，它持续读取子 Agent 的生成器；每一条子消息都保留在 `agentMessages`，直到子循环结束。这个数组只属于子 Agent 的执行过程，尚未写入父会话。

源码位置：`src/tools/AgentTool/AgentTool.tsx:239-1261`

```javascript
// 函数体：src/tools/AgentTool/AgentTool.tsx::AgentTool.call()
// 源码位置：239-1261
async function call(
  {
    prompt,
    subagent_type,
    description,
    model: modelParam,
    run_in_background,
    name,
    team_name,
    mode: spawnMode,
    isolation,
    cwd,
  },
  toolUseContext,
  canUseTool,
  assistantMessage,
  onProgress,
) {
  // 前面根据 subagent_type 取得 Explore 定义，并组装 runAgentParams。
  // subagent_type => 'Explore'
  // prompt => '检查登录失败路径是否写入安全审计日志。'
  // run_in_background => undefined
  // ...

  // 前面省略：earlyAgentId = createAgentId()。
  const syncAgentId = asAgentId(earlyAgentId)
  // syncAgentId => 'agent_explore_01'
  const agentMessages = []
  const agentIterator = runAgent({
    ...runAgentParams,
    override: {
      ...runAgentParams.override,
      agentId: syncAgentId,
    },
  })[Symbol.asyncIterator]()

  while (true) {
    const result = await agentIterator.next()

    if (result.done) {
      break
    }

    const message = result.value
    agentMessages.push(message)
  }
  // agentMessages => [
  //   {
  //     type: 'assistant',
  //     message: {
  //       role: 'assistant',
  //       content: [{
  //         type: 'tool_use',
  //         id: 'toolu_grep_01',
  //         name: 'Grep',
  //         input: { pattern: 'audit|auditLog', path: 'src' },
  //       }],
  //     },
  //   },
  //   {
  //     type: 'user',
  //     message: {
  //       role: 'user',
  //       content: [{
  //         type: 'tool_result',
  //         tool_use_id: 'toolu_grep_01',
  //         content: 'src/services/audit.ts: recordLoginFailure() 写入登录失败审计日志。',
  //       }],
  //     },
  //   },
  //   {
  //     type: 'assistant',
  //     message: {
  //       role: 'assistant',
  //       content: [{
  //         type: 'text',
  //         text: '登录失败路径在 src/auth/login.ts。失败分支只返回错误；审计写入位于 src/services/audit.ts 的 recordLoginFailure()，当前分支没有调用它。',
  //       }],
  //     },
  //   },
  // ]

  const agentResult = finalizeAgentTool(
    agentMessages,
    syncAgentId,
    metadata,
  )

  return {
    data: {
      status: 'completed',
      prompt,
      ...agentResult,
      ...worktreeResult,
    },
  }
}
```

`finalizeAgentTool()` 做的收口很窄：从子 Agent 最后的 AssistantMessage 取文本块，统计 Tool 数、耗时和 Token，再返回一个普通对象。最后一条消息只有 Tool Use 时，它会向前找最近的文本块；正常完成的本例不进入这个兜底分支。

源码位置：`src/tools/AgentTool/agentToolUtils.ts:276-356`

```javascript
// 函数体：src/tools/AgentTool/agentToolUtils.ts::finalizeAgentTool()
// 源码位置：276-356
function finalizeAgentTool(agentMessages, agentId, metadata) {
  const lastAssistantMessage = getLastAssistantMessage(agentMessages)
  // lastAssistantMessage.message.content => [
  //   {
  //     type: 'text',
  //     text: '登录失败路径在 src/auth/login.ts。失败分支只返回错误；审计写入位于 src/services/audit.ts 的 recordLoginFailure()，当前分支没有调用它。',
  //   },
  // ]

  let content = lastAssistantMessage.message.content.filter(
    block => block.type === 'text',
  )

  if (content.length === 0) {
    for (let index = agentMessages.length - 1; index >= 0; index--) {
      const message = agentMessages[index]
      if (message.type !== 'assistant') continue

      const textBlocks = message.message.content.filter(
        block => block.type === 'text',
      )
      if (textBlocks.length > 0) {
        content = textBlocks
        break
      }
    }
  }

  const totalTokens = getTokenCountFromUsage(
    lastAssistantMessage.message.usage,
  )
  const totalToolUseCount = countToolUses(agentMessages)

  const agentResult = {
    agentId,
    agentType: metadata.agentType,
    content,
    totalDurationMs: Date.now() - metadata.startTime,
    totalTokens,
    totalToolUseCount,
    usage: lastAssistantMessage.message.usage,
  }
  // agentResult => {
  //   agentId: 'agent_explore_01',
  //   agentType: 'Explore',
  //   content: [{
  //     type: 'text',
  //     text: '登录失败路径在 src/auth/login.ts。失败分支只返回错误；审计写入位于 src/services/audit.ts 的 recordLoginFailure()，当前分支没有调用它。',
  //   }],
  //   totalToolUseCount: 3,
  //   totalDurationMs: 4820,
  //   totalTokens: 1298,
  // }

  return agentResult
}
```

`AgentTool.call()` 返回后，通用 Tool 执行层拿到 `result.data`。它通过当前 Tool 约定的 `mapToolResultToToolResultBlockParam()`，把这个结果对象转换为模型 API 所需的 Tool Result 内容块。

源码位置：`src/services/tools/toolExecution.ts:599-1480`

```javascript
// 函数体：src/services/tools/toolExecution.ts::checkPermissionsAndCallTool()
// 源码位置：599-1480
async function checkPermissionsAndCallTool(
  tool,
  toolUseID,
  input,
  toolUseContext,
  canUseTool,
  assistantMessage,
  messageId,
  requestId,
  mcpServerType,
  mcpServerBaseUrl,
  onToolProgress,
) {
  // 前面完成 Schema 校验、Hook 与权限判断。
  // tool.name => 'Agent'
  // toolUseID => 'toolu_agent_01'
  // ...

  const result = await tool.call(
    input,
    {
      ...toolUseContext,
      toolUseId: toolUseID,
    },
    canUseTool,
    assistantMessage,
    progress => onToolProgress(progress),
  )
  // result.data => finalizeAgentTool() 产生的完成结果对象。

  const mappedToolResultBlock = tool.mapToolResultToToolResultBlockParam(
    result.data,
    toolUseID,
  )

  let toolOutput = result.data
  const resultingMessages = []

  async function addToolResult(toolUseResult, preMappedBlock) {
    const toolResultBlock = preMappedBlock
      ? await processPreMappedToolResultBlock(
          preMappedBlock,
          tool.name,
          tool.maxResultSizeChars,
        )
      : await processToolResultBlock(
          tool,
          toolUseResult,
          toolUseID,
        )

    resultingMessages.push({
      message: createUserMessage({
        content: [toolResultBlock],
        toolUseResult,
        sourceToolAssistantUUID: assistantMessage.uuid,
      }),
    })
    // 源码还会在这里加入权限确认时附带的反馈内容。
    // ...
  }

  if (!isMcpTool(tool)) {
    await addToolResult(toolOutput, mappedToolResultBlock)
  }

  return resultingMessages
}
```

`AgentTool.mapToolResultToToolResultBlockParam()` 将 `finalizeAgentTool()` 产生的摘要接到父 Agent 最初的 `toolu_agent_01` 上；子 Agent 内部的 `toolu_grep_01` 留在子会话中。

源码位置：`src/tools/AgentTool/AgentTool.tsx:1298-1378`

```javascript
// 函数体：src/tools/AgentTool/AgentTool.tsx::AgentTool.mapToolResultToToolResultBlockParam()
// 源码位置：1340-1362
function mapToolResultToToolResultBlockParam(data, toolUseID) {
  // data.agentType => 'Explore'
  // toolUseID => 'toolu_agent_01'
  // data.content => [{
  //   type: 'text',
  //   text: '登录失败路径在 src/auth/login.ts。失败分支只返回错误；审计写入位于 src/services/audit.ts 的 recordLoginFailure()，当前分支没有调用它。',
  // }]

  const worktreeData = data
  const worktreeInfoText = worktreeData.worktreePath
    ? `\nworktreePath: ${worktreeData.worktreePath}\nworktreeBranch: ${worktreeData.worktreeBranch}`
    : ''
  // data.worktreePath => undefined
  // worktreeInfoText => ''

  const contentOrMarker = data.content.length > 0
    ? data.content
    : [{
        type: 'text',
        text: '(Subagent completed but returned no output.)',
      }]

  if (
    data.agentType &&
    ONE_SHOT_BUILTIN_AGENT_TYPES.has(data.agentType) &&
    !worktreeInfoText
  ) {
    // 'Explore' 在 ONE_SHOT_BUILTIN_AGENT_TYPES 中，因此条件为 true。
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: contentOrMarker,
    }
  }

  return {
    tool_use_id: toolUseID,
    type: 'tool_result',
    content: [
      ...contentOrMarker,
      {
        type: 'text',
        text: `agentId: ${data.agentId} (use SendMessage with to: '${data.agentId}' to continue this agent)
<usage>total_tokens: ${data.totalTokens}
tool_uses: ${data.totalToolUseCount}
duration_ms: ${data.totalDurationMs}</usage>`,
      },
    ],
  }
}
```

父循环随后和处理其他 Tool Result 一样，把 `toolu_agent_01` 的结果写进 `messages`，再让模型决定下一步。这里的 `tool_use_id` 没有改成子 Agent 内部的 Tool ID：它仍然对应开头那次 `Agent` Tool Use，保证父会话中的 Tool Use / Tool Result 协议完整。

这次选择的是 `Explore`，因此结果只有结论文本。`general-purpose` 等非 one-shot Agent 会在同一处额外附上 `agentId` 和 `<usage>`；下一节的继续运行使用的正是这种 Agent。

## 5. 后台 Agent：启动和完成是两次事件

后台路径与同步路径的分界很明确：同步路径在 `AgentTool.call()` 中等待 `runAgent()` 结束，再返回结论；后台路径先返回任务已启动，`runAgent()` 留在后台继续执行。

下面代入 `subagent_type: 'general-purpose'`、`description: '梳理认证模块依赖'`、`prompt: '检查认证模块依赖关系，列出入口、服务和测试文件。不要修改文件。'` 与 `run_in_background: true`。 `AgentTool.call()` 判断为后台路径后，注册任务，启动 `runAsyncAgentLifecycle()`，然后立刻返回。`void` 使这条后台 Promise 不阻塞当前 `call()`。

源码位置：`src/tools/AgentTool/AgentTool.tsx:567-764`

```javascript
// 函数体：src/tools/AgentTool/AgentTool.tsx::AgentTool.call()
// 源码位置：567-764
async function call(
  { prompt, subagent_type, description, run_in_background },
  toolUseContext,
  canUseTool,
  assistantMessage,
  onProgress,
) {
  // selectedAgent.agentType => 'general-purpose'
  // run_in_background => true
  // isBackgroundTasksDisabled => false
  // 前面省略：选 Agent、组装 runAgentParams。
  // ...

  const shouldRunAsync = (
    run_in_background === true ||
    selectedAgent.background === true ||
    isCoordinator ||
    forceAsync ||
    assistantForceAsync ||
    (proactiveModule?.isProactiveActive() ?? false)
  ) && !isBackgroundTasksDisabled
  // shouldRunAsync => true

  if (shouldRunAsync) {
    // 前面省略：earlyAgentId = createAgentId()。
    const asyncAgentId = earlyAgentId
    // asyncAgentId => 'agent_background_01'
    const agentBackgroundTask = registerAsyncAgent({
      agentId: asyncAgentId,
      description,
      prompt,
      selectedAgent,
      setAppState: rootSetAppState,
      toolUseId: toolUseContext.toolUseId,
    })
    // agentBackgroundTask.agentId => 'agent_background_01'

    void runWithAgentContext(
      asyncAgentContext,
      () => wrapWithCwd(() => runAsyncAgentLifecycle({
        taskId: agentBackgroundTask.agentId,
        abortController: agentBackgroundTask.abortController,
        makeStream: onCacheSafeParams => runAgent({
          ...runAgentParams,
          override: {
            ...runAgentParams.override,
            agentId: agentBackgroundTask.agentId,
            abortController: agentBackgroundTask.abortController,
          },
          onCacheSafeParams,
        }),
        metadata,
        description,
        toolUseContext,
        rootSetAppState,
        agentIdForCleanup: agentBackgroundTask.agentId,
        enableSummarization:
          isCoordinator ||
          isForkSubagentEnabled() ||
          getSdkAgentProgressSummariesEnabled(),
        getWorktreeResult: cleanupWorktreeIfNeeded,
      })),
    )

    return {
      data: {
        isAsync: true,
        status: 'async_launched',
        agentId: agentBackgroundTask.agentId,
        description,
        prompt,
        outputFile: getTaskOutputPath(agentBackgroundTask.agentId),
        canReadOutputFile: true,
      },
    }
  }

  // shouldRunAsync 为 false 时，才进入第 4 节的同步等待分支。
  // ...
}
```

主模型只等到「任务已经启动」，不等子 Agent 的最终结论。时间顺序是：

1. 主模型调用 `Agent({ run_in_background: true })`；
2. `AgentTool.call()` 很快返回 `async_launched`，父循环把这条 Tool Result 交还给主模型；
3. 主模型可以继续调用其他 Tool，或先结束当前回答；与此同时，子 Agent 在后台继续运行；
4. 子 Agent 完成后，`runAsyncAgentLifecycle()` 调用 `finalizeAgentTool()` 得到结论，再调用 `completeAsyncAgent()` 更新任务状态；
5. `enqueueAgentNotification()` 把带有结果的 `<task-notification>` 放进待处理队列。之后主循环消费这条队列消息时，主模型才会在新的请求中看到完成结果。

因此，`agent_background_01` 和输出文件路径只是第一次返回时给主模型的「任务句柄」，不是结论本身。需要在完成前主动查看时，模型可以调用 `TaskOutput` 读取当前状态或输出；任务完成后，通知也会携带结果。

源码位置：`src/tools/AgentTool/agentToolUtils.ts:508-650`、`src/tasks/LocalAgentTask/LocalAgentTask.tsx:197-261`、`src/query.ts:1572-1636`

## 6. fork：子 Agent 继承父会话的一条独立路径

普通子 Agent 的 `forkContextMessages` 是 `undefined`。当前源码还存在一条受 `FORK_SUBAGENT` 功能开关控制的 fork 路径：当模型调用 `Agent` Tool 时省略 `subagent_type`，`AgentTool.call()` 不选择 `general-purpose`，而是选择内部的 `FORK_AGENT`。

源码位置：`src/tools/AgentTool/AgentTool.tsx:330-355`、`src/tools/AgentTool/forkSubagent.ts:20-76`

```javascript
// 函数体：src/tools/AgentTool/AgentTool.tsx::AgentTool.call()
// 源码位置：330-355
async function call({ subagent_type, description, prompt }) {
  // subagent_type => undefined
  // description => '检查当前修改是否遗漏登录失败审计日志'
  // prompt => '只检查当前修改和已有上下文，指出仍遗漏的审计日志路径。'
  const effectiveType = subagent_type ?? (
    isForkSubagentEnabled()
      ? undefined
      : GENERAL_PURPOSE_AGENT.agentType
  )
  // => undefined

  const isForkPath = effectiveType === undefined
  // => true

  const selectedAgent = isForkPath
    ? FORK_AGENT
    : findAgentByType(effectiveType)
  // => {
  //   agentType: 'fork',
  //   tools: ['*'],
  //   model: 'inherit',
  //   permissionMode: 'bubble',
  // }
  // ...
}
```

这条路径随后调用 `buildForkedMessages()`，复制父会话最后一条 AssistantMessage，从中取出全部 Tool Use，为每一个 Tool Use 生成相同的占位 Tool Result，再在末尾追加这次 fork 的指令。`runAgent()` 还接收父 Agent 已渲染好的 System Prompt、原始 Tool 数组和 Thinking 配置。

源码位置：`src/tools/AgentTool/forkSubagent.ts:107-168`、`src/tools/AgentTool/AgentTool.tsx:603-633`

```javascript
// 函数体：src/tools/AgentTool/forkSubagent.ts::buildForkedMessages()
// 源码位置：107-168
function buildForkedMessages(directive, assistantMessage) {
  // directive => '只检查当前修改和已有上下文，指出仍遗漏的审计日志路径。'
  // assistantMessage.message.content => [
  //   {
  //     type: 'tool_use',
  //     id: 'toolu_agent_02',
  //     name: 'Agent',
  //     input: {
  //       description: '检查当前修改是否遗漏登录失败审计日志',
  //       prompt: '只检查当前修改和已有上下文，指出仍遗漏的审计日志路径。',
  //     },
  //   },
  // ]
  const fullAssistantMessage = {
    ...assistantMessage,
    uuid: randomUUID(),
    message: {
      ...assistantMessage.message,
      content: [...assistantMessage.message.content],
    },
  }

  const toolUseBlocks = assistantMessage.message.content.filter(
    block => block.type === 'tool_use',
  )
  // toolUseBlocks => [
  //   {
  //     type: 'tool_use',
  //     id: 'toolu_agent_02',
  //     name: 'Agent',
  //     input: {
  //       description: '检查当前修改是否遗漏登录失败审计日志',
  //       prompt: '只检查当前修改和已有上下文，指出仍遗漏的审计日志路径。',
  //     },
  //   },
  // ]

  if (toolUseBlocks.length === 0) {
    return [
      createUserMessage({
        content: [{ type: 'text', text: buildChildMessage(directive) }],
      }),
    ]
  }

  const toolResultBlocks = toolUseBlocks.map(block => ({
    type: 'tool_result',
    tool_use_id: block.id,
    content: [{ type: 'text', text: FORK_PLACEHOLDER_RESULT }],
  }))
  // toolResultBlocks => [
  //   {
  //     type: 'tool_result',
  //     tool_use_id: 'toolu_agent_02',
  //     content: [
  //       { type: 'text', text: 'Fork started — processing in background' },
  //     ],
  //   },
  // ]

  const toolResultMessage = createUserMessage({
    content: [
      ...toolResultBlocks,
      { type: 'text', text: buildChildMessage(directive) },
    ],
  })

  return [fullAssistantMessage, toolResultMessage]
}
```

`buildForkedMessages()` 只创建 fork 子会话的消息前缀。随后 `AgentTool.call()` 根据 `isForkPath` 组装 `runAgent()` 的参数：

```javascript
// 函数体：src/tools/AgentTool/AgentTool.tsx::AgentTool.call()
// 源码位置：603-636
async function call(
  { prompt, subagent_type: subagentType, model, description, isolation, cwd },
  toolUseContext,
  canUseTool,
  assistantMessage,
) {
  // 前面省略：计算 effectiveType、判断 isForkPath、选择 selectedAgent，
  // 构造 promptMessages，并在需要时创建 worktreeInfo。
  //
  // 本例是省略 subagent_type 后触发的 fork 路径：
  // isForkPath => true
  const runAgentParams = {
    // selectedAgent => {
    //   agentType: 'fork',
    //   tools: ['*'],
    //   model: 'inherit',
    //   permissionMode: 'bubble',
    // }
    agentDefinition: selectedAgent,

    // promptMessages => [
    //   fullAssistantMessage,
    //   {
    //     type: 'user',
    //     message: {
    //       role: 'user',
    //       content: [
    //         {
    //           type: 'tool_result',
    //           tool_use_id: 'toolu_agent_02',
    //           content: [{ type: 'text', text: 'Fork started — processing in background' }],
    //         },
    //         {
    //           type: 'text',
    //           text: buildChildMessage(
    //             '只检查当前修改和已有上下文，指出仍遗漏的审计日志路径。',
    //           ),
    //         },
    //       ],
    //     },
    //   },
    // ]
    // 如果 effectiveIsolation === 'worktree'，末尾还会追加一条
    // buildWorktreeNotice('/Users/me/shop', '/Users/me/shop/.worktrees/agent-a1b2c3d4')。
    promptMessages,

    // toolUseContext => 父会话这次 Agent Tool Use 的上下文，里面带有
    // 父会话 messages、tools、mainLoopModel、abortController 和 AppState 访问函数。
    toolUseContext,

    // canUseTool => 父会话传下来的权限判断函数，子 Agent 调 Tool 时仍会经过它。
    canUseTool,

    // shouldRunAsync => true 的常见原因是 fork 功能开启后 forceAsync 为 true；
    // 除非后台任务被禁用，否则 fork 子 Agent 会后台运行。
    isAsync: shouldRunAsync,

    // 父上下文已有 querySource 时继承；否则由 FORK_AGENT 的 agentType
    // 计算，例如 'agent:builtin:fork'。
    querySource:
      toolUseContext.options.querySource ??
      getQuerySourceForAgent(
        selectedAgent.agentType,
        isBuiltInAgent(selectedAgent),
      ),

    // fork 不接收本次 Tool Use 的 model override。
    // 即使 Tool Use 传了 model: 'opus'，这里也会落成 undefined。
    model: isForkPath ? undefined : model,

    // fork 子 Agent 直接使用父 Agent 已经渲染好的 System Prompt。
    // forkParentSystemPrompt => 父 Agent 当前已经渲染好的完整 System Prompt。
    override: isForkPath
      ? { systemPrompt: forkParentSystemPrompt }
      : enhancedSystemPrompt && !worktreeInfo && !cwd
        ? { systemPrompt: asSystemPrompt(enhancedSystemPrompt) }
        : undefined,

    // fork 子 Agent 使用父会话当前可用的完整 Tool 数组，而不是重新组装 workerTools。
    // availableTools => toolUseContext.options.tools
    // 例如包含 Read、Grep、Bash、Edit、Agent、TodoWrite、MCP tools 等父会话当前工具。
    availableTools: isForkPath
      ? toolUseContext.options.tools
      : workerTools,

    // fork 子 Agent 在 runAgent() 内部会把这份父会话 messages 拼到
    // promptMessages 前面，形成继承父上下文的子会话。
    // forkContextMessages => [
    //   用户原始任务消息，
    //   父 Agent 已经完成的若干 assistant/user tool_result 消息，
    //   当前包含 toolu_agent_02 的 assistant 消息之前的完整上下文，
    // ]
    forkContextMessages: isForkPath
      ? toolUseContext.messages
      : undefined,

    // useExactTools => true；runAgent() 会直接使用 availableTools，
    // 并继承父会话 thinkingConfig / isNonInteractiveSession。
    ...(isForkPath && { useExactTools: true }),

    // worktreePath => undefined
    // 如果 isolation: 'worktree'，则类似：
    // '/Users/me/shop/.worktrees/agent-a1b2c3d4'
    worktreePath: worktreeInfo?.worktreePath,

    // description => '检查当前修改是否遗漏登录失败审计日志'
    description,
  }

  // 后面省略：runAgent(runAgentParams) 的同步或后台执行分支。
}
```

把第 2 节的普通子 Agent 和这里的 fork 子 Agent 对照起来，差异集中在下面几项：

| 字段 | 普通子 Agent | fork 子 Agent |
| --- | --- | --- |
| `agentDefinition` | `Explore`、`general-purpose` 等实际 Agent 定义 | 内部 `FORK_AGENT` |
| `promptMessages` | 一条新的 `createUserMessage({ content: prompt })` | `buildForkedMessages()` 生成的父 AssistantMessage 副本、占位 Tool Result 和 fork 指令 |
| `model` | 可以保留 Tool Use 传入的 `'sonnet'`、`'opus'`、`'haiku'` | 固定为 `undefined`，继承父模型选择 |
| `override.systemPrompt` | 普通路径可能使用当前 Agent 增强后的 System Prompt | 使用父 Agent 已经渲染好的 System Prompt |
| `availableTools` | 按子 Agent 权限重新组装的 `workerTools` | 父会话当前完整 Tool 数组 |
| `forkContextMessages` | `undefined` | 父会话截至本次 Tool Use 的消息数组 |
| `useExactTools` | 不出现，`runAgent()` 会继续过滤工具 | `true`，`runAgent()` 直接使用父 Tool 数组并继承父 Thinking 配置 |

当前 fork 路径依赖的 `FORK_SUBAGENT` 开关还会令 `forceAsync` 为 `true`，从而使 `shouldRunAsync` 成立。因此这条 fork 子 Agent 会按第 5 节的后台生命周期运行：父 Agent 先得到 `async_launched`，完成结论通过任务通知或 `TaskOutput` 取得。

fork 子 Agent 会尽量复用父会话的请求前缀：父 System Prompt、父 Tool 定义和父消息上下文都会被带入。它仍设置独立 `agentId` 和新的 `queryTracking.chainId`；`isInForkChild()` 检查到 `<fork-boilerplate>` 时会阻止再次 fork。

## 7. `SendMessage` 如何继续已经停止的子 Agent

第 4 节里同步子 Agent 完成后，`AgentTool` 会把结果映射成父 Tool Use 对应的 Tool Result。这里还有一个小分支：`Explore`、`Plan` 属于 one-shot built-in，完成后只返回报告，不附带继续对话的句柄；其他可继续的 Agent，例如 `general-purpose`，会在 Tool Result 末尾追加一段提示：

```text
agentId: agent_general_01 (use SendMessage with to: 'agent_general_01' to continue this agent)
<usage>total_tokens: 1298
tool_uses: 3
duration_ms: 4820</usage>
```

上一次 `Agent` Tool Result 里的 `agentId` 给出了继续对话的目标。父模型需要追问这个子 Agent 时，可以调用：

`SendMessage` Tool，并传入 `to: 'agent_general_01'` 与 `message: '继续只读检查：确认 recordLoginFailure() 应由哪个失败分支调用。'`。

`SendMessageTool.call()` 收到这次 Tool Use 后，先把 `to` 解析成 Agent ID，再看这个 ID 对应的任务还在不在当前任务表里。只有任务已经停止，或者任务状态已经从内存里清掉但 sidechain transcript 还在磁盘上时，才会进入 `resumeAgentBackground()`。

源码位置：`src/tools/AgentTool/AgentTool.tsx:1340-1370`、`src/tools/SendMessageTool/SendMessageTool.ts:800-869`、`src/tools/AgentTool/resumeAgent.ts:42-264`

```javascript
// 函数体：src/tools/SendMessageTool/SendMessageTool.ts::SendMessageTool.call()
// 源码位置：800-869
async function call(input, context, canUseTool, assistantMessage) {
  // input => {
  //   to: 'agent_general_01',
  //   message: '继续只读检查：确认 recordLoginFailure() 应由哪个失败分支调用。',
  // }
  if (typeof input.message === 'string' && input.to !== '*') {
    const appState = context.getAppState()
    const registered = appState.agentNameRegistry.get(input.to)
    // registered => undefined；这里直接使用 raw agentId。
    const agentId = registered ?? toAgentId(input.to)
    // agentId => 'agent_general_01'

    if (agentId) {
      const task = appState.tasks[agentId]

      if (isLocalAgentTask(task) && !isMainSessionTask(task)) {
        if (task.status === 'running') {
          queuePendingMessage(
            agentId,
            input.message,
            context.setAppStateForTasks ?? context.setAppState,
          )
          return {
            data: {
              success: true,
              message: 'Message queued for delivery to agent_general_01 at its next tool round.',
            },
          }
        }

        // task 存在但已经不是 running，例如 completed / failed / stopped。
        // 这时不会把消息塞进运行中队列，而是恢复这条子 Agent sidechain。
        const result = await resumeAgentBackground({
          agentId,
          prompt: input.message,
          toolUseContext: context,
          canUseTool,
          invokingRequestId: assistantMessage?.requestId,
        })
        return {
          data: {
            success: true,
            message: `Agent "${input.to}" was stopped (${task.status}); resumed it in the background with your message. Output: ${result.outputFile}`,
          },
        }
      }

      // task 已经不在 appState.tasks 里，但 input.to 仍能解析成 agentId。
      // 这时再尝试从磁盘上的 sidechain transcript 恢复。
      const result = await resumeAgentBackground({
        agentId,
        prompt: input.message,
        toolUseContext: context,
        canUseTool,
        invokingRequestId: assistantMessage?.requestId,
      })
      return {
        data: {
          success: true,
          message: `Agent "${input.to}" had no active task; resumed from transcript in the background with your message. Output: ${result.outputFile}`,
        },
      }
    }
  }

  // 不能解析成子 Agent ID 时，才继续走 teammate / broadcast 等其它 SendMessage 分支。
}
```

`resumeAgentBackground()` 先读出子 Agent 的 sidechain transcript 和 metadata，再过滤未配对的 Tool Use，把新消息追加到这份子会话末尾，最后以异步方式重新交给 `runAgent()`。

源码位置：`src/tools/AgentTool/resumeAgent.ts:63-195`

```javascript
// 函数体：src/tools/AgentTool/resumeAgent.ts::resumeAgentBackground()
// 源码位置：63-195
async function resumeAgentBackground({
  agentId,
  prompt,
  toolUseContext,
}) {
  // agentId => 'agent_general_01'
  // prompt => '继续只读检查：确认 recordLoginFailure() 应由哪个失败分支调用。'
  const [transcript, meta] = await Promise.all([
    getAgentTranscript(agentId),
    readAgentMetadata(agentId),
  ])
  // transcript.messages => [
  //   {
  //     type: 'user',
  //     message: {
  //       role: 'user',
  //       content: '检查登录失败路径和审计日志调用链，给出可修改的位置。',
  //     },
  //   },
  //   {
  //     type: 'assistant',
  //     message: {
  //       role: 'assistant',
  //       content: [
  //         {
  //           type: 'text',
  //           text: '登录失败路径在 src/auth/login.ts。失败分支只返回错误；审计写入位于 src/services/audit.ts 的 recordLoginFailure()，当前分支没有调用它。',
  //         },
  //       ],
  //     },
  //   },
  // ]
  // meta => {
  //   agentType: 'general-purpose',
  //   description: '定位登录审计缺口',
  // }

  const resumedMessages = filterWhitespaceOnlyAssistantMessages(
    filterOrphanedThinkingOnlyMessages(
      filterUnresolvedToolUses(transcript.messages),
    ),
  )
  // => 上面两条完整消息仍保留；没有只剩 thinking 或缺少 Tool Result 的记录。

  const selectedAgent = meta?.agentType
    ? toolUseContext.options.agentDefinitions.activeAgents.find(
        agent => agent.agentType === meta.agentType,
      ) ?? GENERAL_PURPOSE_AGENT
    : GENERAL_PURPOSE_AGENT
  // meta.agentType => 'general-purpose'
  // selectedAgent => GENERAL_PURPOSE_AGENT

  const runAgentParams = {
    agentDefinition: selectedAgent,
    promptMessages: [
      ...resumedMessages,
      createUserMessage({
        content: prompt,
      }),
    ],
    isAsync: true,
    querySource: getQuerySourceForAgent(
      selectedAgent.agentType,
      isBuiltInAgent(selectedAgent),
    ),
    // selectedAgent.agentType => 'general-purpose'
    // querySource => 'agent:builtin:general-purpose'
  }
  // ...
  return runAgent(runAgentParams)
}
```

这里恢复的是子 Agent 自己先前保存的 sidechain。追问能够接着子 Agent 已经找到的文件和结论继续；父 Agent 同时仍保留自己的主会话节奏。

## 小结

子 Agent 是父 Agent 通过 `Agent` Tool 启动的一段独立会话：它自己调用模型和 Tools。同步运行完成后直接交回 Tool Result；后台运行则先交回任务信息，完成结论稍后通过通知提供。

从这条调用链可以看出，子 Agent 用来承接一段可以独立完成、但过程可能很长的工作，例如搜索多个目录、做只读排查或验证一个假设。父 Agent 不必把这段工作的每次 `Read`、`Grep` 都放进自己的消息历史，只保留能继续决策的结论。

这带来三个直接好处：

- **主会话更聚焦**：大量中间 Tool 输出留在子 Agent 的 sidechain transcript；
- **任务可分开运行**：后台路径启动后，父 Agent 可以继续处理当前任务；
- **上下文可以按任务选择**：普通调用从新任务开始，fork 继承父会话，resume 接回旧子会话。

代价也在源码里可见：每个子 Agent 都要单独运行一轮或多轮模型请求；父 Agent 默认只拿到结论，想追问过程需要通过 `SendMessage` 或 `TaskOutput` 回到对应子任务；后台运行还需要额外维护任务状态、通知和 transcript。

普通同步子 Agent 的主线只有这一条：

```text
父 Agent 的 Agent Tool Use
  -> AgentTool.call()
  -> runAgent()
  -> 子 Agent 自己的 query()、Read、Grep
  -> 最终结论
  -> 父 Agent 收到一条 Agent Tool Result
```

父 Agent 不会收到子 Agent 每一次 `Read`、`Grep` 的过程，只接收最后交回的结果。

三种路径只是在「子 Agent 从哪里接着开始」和「父 Agent 要不要等待结果」上不同：

| 路径 | 子 Agent 的起点 | 父 Agent 最先收到什么 |
| --- | --- | --- |
| 普通同步调用 | 一条新任务消息 | 子 Agent 完成后的 Tool Result |
| fork | 父会话已有的消息、System Prompt 和 Tools | `async_launched`；结论随后通过任务通知或 `TaskOutput` 取得 |
| resume | 已保存的子 Agent sidechain transcript，加一条新指令 | `SendMessage` 的「已恢复」结果；结论随后通过任务通知或 `TaskOutput` 取得 |

后台运行时，父 Agent 可以在子 Agent 工作期间继续当前任务。代价是要用任务状态、通知和 transcript 维护这段延后交付的结果。
