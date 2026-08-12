---
title: "10、MCP 外部工具如何进入下一轮 Agent 调用"
---

先设一个运行场景：项目里接了一个名为 `project-tracker` 的 MCP Server。用户启动 Claude Code 后输入「查询 SHOP-482 的状态」，这时源码里先能看到的，不是某个具体查工单函数，而是这台 Server 的配置。

源码里 `getMcpConfigsByScope('project')` 会从工作目录一路往父目录找 `.mcp.json`，再读取顶层的 `mcpServers` 字段。这个例子里的配置可以先想成这样：

```javascript
// 配置文件：.mcp.json；由 src/services/mcp/types.ts::McpJsonConfigSchema() 校验。
{
  "mcpServers": {
    "project-tracker": {
      "type": "stdio",
      "command": "node",
      "args": ["./tools/project-tracker-mcp.js"]
    }
  }
}
```

这份配置只说明「怎么启动或连接 `project-tracker` 这台 Server」，还没有具体业务 Tool。实际运行时还会合并 user settings、local settings、plugin、claude.ai 连接器等来源；这里先盯住项目级 `.mcp.json`，因为它最容易看清从 Server 配置到 Tool 发现的边界。

接下来假设这台 Server 对外提供一个查工单的工具，原始名称叫 `get_issue`，入参里有 `issueKey`。真正要追的，就是这个外部工具怎么被 Claude Code 发现、改名、放进模型可见的 Tool 表，最后又按 MCP 协议调用回去。

所以源码里最先遇到的并不是 `get_issue` 本身，而是还在连接的 Server。只有连接成功并拿到 `tools/list` 以后，`get_issue` 这个名字才第一次出现。

继续往下，才会看到它如何变成 `mcp__project-tracker__get_issue`，怎样在下一轮进入模型的 Tool 表；模型选中它后，发给 Server 的名称又为什么仍是 `get_issue`。

这条路径先记成：

```text
配置 → 建立连接 → tools/list → 转换为 Tool → 写入 MCP 状态
→ 下一轮创建 ToolUseContext → 模型返回 Tool Use
→ runToolUse() → MCP Tool.call() → tools/call → Tool Result
```

先把调用关系放在一张图里，后面每一节都只是在展开其中一段。

![图 1：MCP Tool 的函数调用关系](https://windliangblog.oss-cn-beijing.aliyuncs.com/10-mcp-and-dynamic-tool-discovery-diagram-01.png)



外部 Server 可以慢、可以变、可以断开；一轮 Agent 调用里的 Tool 表、权限和结果协议却不能中途变成另一份。

后面按三段追：第 1 到第 3 节只看「发现结果怎么进入状态」；第 4 节看「状态怎么变成本轮请求的固定快照」；第 5 节再看「模型选中后怎么调用回 MCP Server」。

## 1. 启动时：先连接，尚未有业务 Tool

配置里只有 Server 的连接信息，并没有 `get_issue` 的定义。交互界面启动后，`MCPConnectionManager` 会调用 `useManageMCPConnections()`；这个 hook 读完 MCP 配置，过滤掉禁用的 Server，然后把剩下的配置交给 `getMcpToolsCommandsAndResources()`。

源码位置：`src/services/mcp/useManageMCPConnections.ts:887-908`、`src/services/mcp/client.ts:2226-2381`

```javascript
// 函数体：src/services/mcp/useManageMCPConnections.ts::useManageMCPConnections()
function useManageMCPConnections(dynamicMcpConfig, isStrictMcpConfig = false) {
  // ...
  const configs = { ...claudeCodeConfigs, ...dynamicMcpConfig }
  // configs => {
  //   'project-tracker': {
  //     type: 'stdio',
  //     command: 'node',
  //     args: ['./tools/project-tracker-mcp.js'],
  //     scope: 'project',
  //   },
  // }

  const enabledConfigs = Object.fromEntries(
    Object.entries(configs).filter(([name]) => !isMcpServerDisabled(name)),
  )
  getMcpToolsCommandsAndResources(onConnectionAttempt, enabledConfigs)
}

// 函数体：src/services/mcp/client.ts::getMcpToolsCommandsAndResources()
async function getMcpToolsCommandsAndResources(
  onConnectionAttempt,
  mcpConfigs,
) {
  // ...
  const processServer = async ([name, config]) => {
    const client = await connectToServer(name, config, serverStats)
    // name => 'project-tracker'
    // client => {
    //   name: 'project-tracker',
    //   type: 'connected',
    //   capabilities: { tools: {} },
    // }

    if (client.type !== 'connected') {
      onConnectionAttempt({
        client,
        tools: client.type === 'needs-auth'
          ? [createMcpAuthTool(name, config)]
          : [],
        commands: [],
      })
      return
    }

    const tools = await fetchToolsForClient(client)
    // tools => [
    //   { name: 'mcp__project-tracker__get_issue', isMcp: true },
    // ]
    onConnectionAttempt({ client, tools, commands: [] })
  }

  // ...
}
```

这才进入连接阶段。`getMcpToolsCommandsAndResources()` 等 `connectToServer()` 返回后才调用 `fetchToolsForClient()`；连接尚未完成时，REPL 已经可以继续启动。

从 `if (client.type !== 'connected')` 这个分支可以先确认：连接结果先决定业务 Tool 是否出现。还没连上时，数组为空；需要认证时，数组里只有认证 Tool。因此模型不会拿到一项看似可调用、实际上没有连接的 `get_issue`。

再看调用位置，连接虽然从启动阶段发起，却没有让 REPL 等它结束。外部服务慢或暂时不可用时，内置 `Read`、`Grep` 仍能开始会话。MCP 的网络状态被留在扩展能力这一侧，没有占住 CLI 的基本启动路径。

## 2. 发现时：协议声明被转换成内部 Tool

第 1 节里 `client.type === 'connected'` 之后，走到 `fetchToolsForClient`。

这里开始才是真正的 Tool 发现：连接已经建立，`fetchToolsForClient(client)` 可以向这台 Server 发 `tools/list`。接着追进去，外部声明在这里才变成能放进 `ToolUseContext` 的 Tool 对象。

源码位置：`src/services/mcp/client.ts:1743-2014`

```javascript
// 函数体：src/services/mcp/client.ts::fetchToolsForClient()
export const fetchToolsForClient = memoizeWithLRU(
  async client => {
    if (client.type !== 'connected' || !client.capabilities?.tools) {
      return []
    }

    const result = await client.client.request(
      { method: 'tools/list' },
      ListToolsResultSchema,
    )
    // result => {
    //   tools: [
    //     {
    //       name: 'get_issue',
    //       description: '读取工单的状态、负责人和描述',
    //       inputSchema: {
    //         type: 'object',
    //         properties: {
    //           issueKey: { type: 'string' },
    //         },
    //         required: ['issueKey'],
    //       },
    //       annotations: {
    //         readOnlyHint: true,
    //       },
    //     },
    //   ],
    // }

    return result.tools.map(tool => {
      const fullyQualifiedName = buildMcpToolName(
        client.name,
        tool.name,
      )
      // client.name => 'project-tracker'
      // tool.name => 'get_issue'
      // fullyQualifiedName => 'mcp__project-tracker__get_issue'

      return {
        ...MCPTool,
        name: fullyQualifiedName,
        mcpInfo: {
          serverName: client.name,
          toolName: tool.name,
        },
        isMcp: true,
        isConcurrencySafe() {
          return tool.annotations?.readOnlyHint ?? false
        },
        isReadOnly() {
          return tool.annotations?.readOnlyHint ?? false
        },
        isDestructive() {
          return tool.annotations?.destructiveHint ?? false
        },
        inputJSONSchema: tool.inputSchema,
        async call(args, context, canUseTool, parentMessage, onProgress) {
          // ...
        },
      }
    })
  },
  client => client.name,
  MCP_FETCH_CACHE_SIZE,
)
```

这个 `return` 出来的数组，会回到第 1 节的 `const tools = await fetchToolsForClient(client)`。随后同一个函数把它传给 `onConnectionAttempt({ client, tools, commands: [] })`，所以第 3 节看到的 `tools`，就是这里转换完成的内部 Tool 数组。

返回对象里出现了两套名字：

- `name` 是 `mcp__project-tracker__get_issue`，供模型、内部查找和权限规则使用；
- `mcpInfo.toolName` 是原始的 `get_issue`，保留给后面的 MCP 协议调用。

两个 Server 都有 `get_issue` 时，前缀让内部 Tool 表仍能区分它们；后面 `tools/call` 又保留原始名称。这两处字段放在同一个对象里，正好把内部命名空间和外部协议边界分开。

`inputSchema`、`readOnlyHint` 也在这里变成内部 Tool 的 Schema 和属性。顺着这个返回对象可以看到：Server 负责声明能力和实现调用协议，权限确认、取消、并发调度和 Tool Result 沿用既有 Tool 系统。新增 Server 时，代码不需要再补一套 Agent 执行器。

## 3. 发现完成后：先写入状态，不改写正在请求的模型

上一步返回的 `tools` 没有在 `getMcpToolsCommandsAndResources()` 里直接写状态。它只是调用 `onConnectionAttempt({ client, tools, commands })`，把连接结果交出去。

源码里先声明 `flushPendingUpdates()`，再声明 `updateServer()` 和 `onConnectionAttempt()`；运行时的数据流则是 `onConnectionAttempt()` 接到结果，`updateServer()` 入队，`flushPendingUpdates()` 统一写一次 AppState。

源码位置：`src/services/mcp/MCPConnectionManager.tsx:38-49`、`src/services/mcp/useManageMCPConnections.ts:215-332`、`src/services/mcp/useManageMCPConnections.ts:887-908`

```javascript
// 函数体：src/services/mcp/useManageMCPConnections.ts::useManageMCPConnections()
function useManageMCPConnections(dynamicMcpConfig, isStrictMcpConfig = false) {
  // ...
  const MCP_BATCH_FLUSH_MS = 16
  type PendingUpdate = MCPServerConnection & {
    tools?: Tool[]
    commands?: Command[]
    resources?: ServerResource[]
  }
  const pendingUpdatesRef = useRef<PendingUpdate[]>([])
  const flushTimerRef = useRef(null)

  const flushPendingUpdates = useCallback(() => {
    const updates = pendingUpdatesRef.current
    pendingUpdatesRef.current = []

    setAppState(previousState => {
      let mcp = previousState.mcp

      for (const update of updates) {
        const { tools: receivedTools, ...client } = update
        // client.name => 'project-tracker'
        // receivedTools => [
        //   { name: 'mcp__project-tracker__get_issue', isMcp: true },
        // ]

        const prefix = getMcpPrefix(client.name)
        const updatedTools = receivedTools === undefined
          ? mcp.tools
          : [
              ...reject(mcp.tools, tool => tool.name?.startsWith(prefix)),
              ...receivedTools,
            ]

        const existingClientIndex = mcp.clients.findIndex(
          existingClient => existingClient.name === client.name,
        )
        const updatedClients = existingClientIndex === -1
          ? [...mcp.clients, client]
          : mcp.clients.map(existingClient =>
              existingClient.name === client.name ? client : existingClient,
            )

        mcp = {
          ...mcp,
          clients: updatedClients,
          tools: updatedTools,
        }
      }

      return { ...previousState, mcp }
    })
  }, [setAppState])

  const updateServer = useCallback(update => {
    pendingUpdatesRef.current.push(update)
    // pendingUpdatesRef.current => [
    //   {
    //     name: 'project-tracker',
    //     type: 'connected',
    //     tools: [
    //       { name: 'mcp__project-tracker__get_issue', isMcp: true },
    //     ],
    //   },
    // ]

    if (flushTimerRef.current === null) {
      flushTimerRef.current = setTimeout(
        flushPendingUpdates,
        MCP_BATCH_FLUSH_MS,
      )
    }
  }, [flushPendingUpdates])

  const onConnectionAttempt = useCallback(({ client, tools, commands }) => {
    updateServer({ ...client, tools, commands })
    // client.name => 'project-tracker'
    // tools => [
    //   { name: 'mcp__project-tracker__get_issue', isMcp: true },
    // ]
  }, [updateServer])

  useEffect(() => {
    // enabledConfigs => {
    //   'project-tracker': {
    //     type: 'stdio',
    //     command: 'node',
    //     args: ['./tools/project-tracker-mcp.js'],
    //     scope: 'project',
    //   },
    // }
    getMcpToolsCommandsAndResources(onConnectionAttempt, enabledConfigs)
  }, [onConnectionAttempt, enabledConfigs])

  // ...
  return { reconnectMcpServer, toggleMcpServer }
}
```

此处的 `appState.mcp.tools` 只是「此刻发现到了什么」。它还不是某次模型请求已经带上的 Tool 表：模型请求一旦发送，服务端看到的定义已经固定，只更新 Store 改不了那次请求。

同一段替换逻辑还显示，`tools/list_changed` 不是在旧数组后直接追加。例如 Server 先提供 `get_issue`，后改为 `get_issue` 与 `create_issue`，状态里留下的是这一台 Server 的新完整列表，而不是不断累积的历史列表。

## 4. 下一轮：把最新状态组装为固定 Tool 快照

如果第一轮请求已经在连接完成前发出，它只会包含内置 Tool。当前轮结束后，再顺着 REPL 和 `queryLoop()` 往下，才看到 Store 里的最新 Tool 怎样变成下一轮 `ToolUseContext` 的快照。

源码位置：`src/screens/REPL.tsx:2390-2449`、`src/query.ts:1658-1670`

```javascript
// 函数体：src/screens/REPL.tsx::REPL()
const getToolUseContext = (messages, newMessages, abortController, mainLoopModel) => {
  const computeTools = () => {
    const state = store.getState()
    const assembled = assembleToolPool(
      state.toolPermissionContext,
      state.mcp.tools,
    )
    // state.mcp.tools => [
    //   { name: 'mcp__project-tracker__get_issue', isMcp: true },
    // ]

    return mergeAndFilterTools(
      combinedInitialTools,
      assembled,
      state.toolPermissionContext.mode,
    )
  }

  return {
    abortController,
    options: {
      tools: computeTools(),
      refreshTools: computeTools,
    },
    messages,
    newMessages,
  }
}

// 函数体：src/query.ts::queryLoop()
async function* queryLoop(params, consumedCommandUuids) {
  // ...
  if (updatedToolUseContext.options.refreshTools) {
    const refreshedTools = updatedToolUseContext.options.refreshTools()
    // refreshedTools => [
    //   { name: 'Bash', isMcp: false },
    //   { name: 'Read', isMcp: false },
    //   { name: 'mcp__project-tracker__get_issue', isMcp: true },
    // ]

    if (refreshedTools !== updatedToolUseContext.options.tools) {
      updatedToolUseContext = {
        ...updatedToolUseContext,
        options: {
          ...updatedToolUseContext.options,
          tools: refreshedTools,
        },
      }
    }
  }
  // ...
}
```

`computeTools()` 中还会进入 `assembleToolPool()`。这里看到内置 Tool 与 MCP Tool 被放到同一张表里，但顺序并不随意：内置 Tool 排在前面，MCP Tool 接在后面。

源码位置：`src/tools.ts:345-379`

```javascript
// 函数体：src/tools.ts::assembleToolPool()
export function assembleToolPool(permissionContext, mcpTools) {
  const builtInTools = getTools(permissionContext)
  const allowedMcpTools = filterToolsByDenyRules(
    mcpTools,
    permissionContext,
  )
  // builtInTools => [Read, Grep, Bash, Edit]
  // allowedMcpTools => [
  //   { name: 'mcp__project-tracker__get_issue', isMcp: true },
  // ]

  const byName = (left, right) => left.name.localeCompare(right.name)

  return uniqBy(
    [...builtInTools]
      .sort(byName)
      .concat(allowedMcpTools.sort(byName)),
    'name',
  )
}
```

这段排序和 Prompt Cache 有关。这里的缓存不是本地缓存，也不是 MCP Server 的返回值缓存，而是 Anthropic API 侧对请求前缀做的服务端 Prompt Cache。Claude Code 发请求时，system prompt、tools、model、messages 前缀都会影响缓存命中；`src/utils/forkedAgent.ts` 也把 `tools` 写进 cache key 的组成里。

因此 Tool 数组的顺序不能随 MCP 工具增减而大幅抖动。源码注释提到，服务端的 `claude_code_system_cache_policy` 会把全局 cache breakpoint 放在最后一个能匹配上的内置 Tool 后面。如果直接把内置 Tool 和 MCP Tool 放在一起整体排序，一个新 MCP Tool 只要按名字插进两个内置 Tool 中间，后面的 Tool schema 顺序就会整体后移，请求前缀也随之改变。

现在的写法先排序内置 Tool，再把排序后的 MCP Tool 接到后面。这样动态变化主要集中在 MCP Tool 这一段；前面的内置 Tool 仍保持稳定，服务端 Prompt Cache 还有机会复用这段稳定前缀。

到此处，一条模型请求里的 Tool 表才真正确定。连接线程仍能继续更新 Store，但当前 `callModel()` 读取的是 `ToolUseContext.options.tools`；下一轮再取新的快照。从刷新发生的位置可以看出，这个轮次边界让模型生成 Tool Use 和执行器按名称查找 Tool 时面对同一份列表。

## 5. 执行时：外部 Tool 仍走统一入口

下一轮模型看到的是内部完整名称，所以返回的 Tool Use 也使用 `mcp__project-tracker__get_issue`。从这里开始，执行链分成三段：

1. `runToolUse()` 用模型给出的完整名称，在本轮 `ToolUseContext.options.tools` 快照里找 Tool；
2. 通用包装层完成权限、进度、取消等处理后，调用这个 Tool 对象的 `call()`；
3. MCP Tool 的 `call()` 闭包保留了 Server 原始名称 `get_issue`，再发出 `tools/call`。

先看模型返回的运行时值：

```javascript
// 运行时值，不属于函数体：模型回答的 content block，由 queryLoop() 收集并传给 runToolUse()。
const toolUse = {
  type: 'tool_use',
  id: 'toolu_mcp_01',
  name: 'mcp__project-tracker__get_issue',
  input: {
    issueKey: 'SHOP-482',
  },
}
```

### 5.1 先用完整名称查内部 Tool

`runToolUse()` 还不需要知道 MCP 协议细节。它只拿 `toolUse.name` 去本轮固定 Tool 表里找对象。由于第 4 节已经把 `appState.mcp.tools` 组装进 `ToolUseContext.options.tools`，这里能找到第 2 节转换出的 MCP Tool 对象。

源码位置：`src/services/tools/toolExecution.ts:337-434`

```javascript
// 函数体：src/services/tools/toolExecution.ts::runToolUse()
export async function* runToolUse(
  toolUse,
  assistantMessage,
  canUseTool,
  toolUseContext,
) {
  const toolName = toolUse.name
  // toolUse => {
  //   type: 'tool_use',
  //   id: 'toolu_mcp_01',
  //   name: 'mcp__project-tracker__get_issue',
  //   input: { issueKey: 'SHOP-482' },
  // }
  // toolName => 'mcp__project-tracker__get_issue'
  // toolUseContext.options.tools => [
  //   { name: 'Bash', isMcp: false },
  //   { name: 'Read', isMcp: false },
  //   {
  //     name: 'mcp__project-tracker__get_issue',
  //     isMcp: true,
  //     mcpInfo: {
  //       serverName: 'project-tracker',
  //       toolName: 'get_issue',
  //     },
  //   },
  // ]

  const tool = findToolByName(
    toolUseContext.options.tools,
    toolName,
  )
  // tool => {
  //   name: 'mcp__project-tracker__get_issue',
  //   isMcp: true,
  //   mcpInfo: {
  //     serverName: 'project-tracker',
  //     toolName: 'get_issue',
  //   },
  //   inputJSONSchema: {
  //     type: 'object',
  //     properties: { issueKey: { type: 'string' } },
  //     required: ['issueKey'],
  //   },
  //   call: async function call(args, context, _canUseTool, parentMessage) {},
  // }

  const mcpServerType = getMcpServerType(
    toolName,
    toolUseContext.options.mcpClients,
  )
  const mcpServerBaseUrl = getMcpServerBaseUrlFromToolName(
    toolName,
    toolUseContext.options.mcpClients,
  )
  // toolUseContext.options.mcpClients => [
  //   {
  //     name: 'project-tracker',
  //     type: 'connected',
  //     config: {
  //       type: 'stdio',
  //       command: 'node',
  //       args: ['./tools/project-tracker-mcp.js'],
  //       scope: 'project',
  //     },
  //   },
  // ]
  // mcpServerType => 'stdio'
  // mcpServerBaseUrl => undefined

  for await (const update of streamedCheckPermissionsAndCallTool(
    tool,
    toolUse.id,
    toolUse.input,
    toolUseContext,
    canUseTool,
    assistantMessage,
    getMessageId(assistantMessage),
    assistantMessage.requestId,
    mcpServerType,
    mcpServerBaseUrl,
  )) {
    // streamedCheckPermissionsAndCallTool() 后续会调用：
    // tool.call(
    //   { issueKey: 'SHOP-482' },
    //   toolUseContext,
    //   canUseTool,
    //   assistantMessage,
    //   onProgress,
    // )
    yield update
  }
}
```

这一步的关键是：执行器查找的是内部完整名称 `mcp__project-tracker__get_issue`。查到对象以后，后续权限检查和 Tool Result 回写仍走通用 Tool 系统，MCP 还没有真正发出协议调用。

### 5.2 再进入 MCP Tool 自己的 `call()`

通过通用包装层后，才进入 MCP Tool 对象里的 `call()` 闭包。第 2 节只展开了这个对象的外层字段，这里继续看当时省略掉的执行部分。

注意这里的 `tool.name` 已经不是模型返回的完整名称。它来自第 2 节里 `tools/list` 的返回值：`result.tools[0].name` 是 `get_issue`；随后 `result.tools.map(tool => ...)` 把这一项作为 map 参数 `tool` 传进来；`call()` 定义在这个 map 回调内部，所以闭包一直能读到这个原始 `tool.name`。

也就是说：

- 外层返回对象的 `name` 是 `mcp__project-tracker__get_issue`，给 Claude Code 内部查找用；
- 闭包里的 `tool.name` 是 `get_issue`，给 MCP Server 的 `tools/call` 用。

源码位置：`src/services/mcp/client.ts:1822-1923`

```javascript
// 函数体：src/services/mcp/client.ts::fetchToolsForClient()
export const fetchToolsForClient = memoizeWithLRU(
  async client => {
    // ...
    // result.tools[0].name => 'get_issue'
    return result.tools.map(tool => ({
      ...MCPTool,
      name: fullyQualifiedName,
      // fullyQualifiedName => 'mcp__project-tracker__get_issue'
      // tool.name => 'get_issue'

      async call(args, context, canUseTool, parentMessage, onProgress) {
        const toolUseId = extractToolUseId(parentMessage)
        const meta = toolUseId
          ? { 'claudecode/toolUseId': toolUseId }
          : {}
        // args => { issueKey: 'SHOP-482' }
        // parentMessage.message.content => [
        //   {
        //     type: 'tool_use',
        //     id: 'toolu_mcp_01',
        //     name: 'mcp__project-tracker__get_issue',
        //     input: { issueKey: 'SHOP-482' },
        //   },
        // ]
        // toolUseId => 'toolu_mcp_01'
        // meta => {
        //   'claudecode/toolUseId': 'toolu_mcp_01',
        // }

        const connectedClient = await ensureConnectedClient(client)
        // client.name => 'project-tracker'
        // connectedClient => {
        //   name: 'project-tracker',
        //   type: 'connected',
        //   config: { type: 'stdio', command: 'node' },
        // }

        const mcpResult = await callMCPToolWithUrlElicitationRetry({
          client: connectedClient,
          clientConnection: client,
          tool: tool.name,
          // tool.name => 'get_issue'
          args,
          // args => { issueKey: 'SHOP-482' }
          meta,
          // meta => {
          //   'claudecode/toolUseId': 'toolu_mcp_01',
          // }
          signal: context.abortController.signal,
          setAppState: context.setAppState,
          handleElicitation: context.handleElicitation,
        })
        // mcpResult => {
        //   content: [
        //     {
        //       type: 'text',
        //       text: 'SHOP-482：登录失败时缺少审计日志；负责人为 auth-team。',
        //     },
        //   ],
        // }

        const output = { data: mcpResult.content }
        // output => {
        //   data: [
        //     {
        //       type: 'text',
        //       text: 'SHOP-482：登录失败时缺少审计日志；负责人为 auth-team。',
        //     },
        //   ],
        // }
        return output
      },
    }))
  },
  client => client.name,
  MCP_FETCH_CACHE_SIZE,
)
```

到这里，名字转换终于闭合了：模型和内部执行器一直使用 `mcp__project-tracker__get_issue`，但 MCP 协议调用使用的是 Server 原本声明的 `get_issue`。

### 5.3 最后发出 MCP 协议的 `tools/call`

`callMCPToolWithUrlElicitationRetry()` 里还包了 URL elicitation 和重试，这里只看最里面真正调用 MCP SDK 的 `callMCPTool()`。它把原始工具名、参数和 `_meta` 组装成 MCP 的 `tools/call` 请求。

源码位置：`src/services/mcp/client.ts:3029-3170`

```javascript
// 函数体：src/services/mcp/client.ts::callMCPTool()
async function callMCPTool({ client: { client }, tool, args, meta, signal }) {
  // tool => 'get_issue'
  // args => { issueKey: 'SHOP-482' }
  // meta => {
  //   'claudecode/toolUseId': 'toolu_mcp_01',
  // }

  const result = await client.callTool(
    {
      name: tool,
      arguments: args,
      _meta: meta,
    },
    CallToolResultSchema,
    { signal },
  )
  // MCP Server 实际收到的 tools/call 请求体接近：
  // {
  //   name: 'get_issue',
  //   arguments: { issueKey: 'SHOP-482' },
  //   _meta: {
  //     'claudecode/toolUseId': 'toolu_mcp_01',
  //   },
  // }
  // result => {
  //   content: [
  //     {
  //       type: 'text',
  //       text: 'SHOP-482：登录失败时缺少审计日志；负责人为 auth-team。',
  //     },
  //   ],
  //   isError: false,
  // }

  const content = await processMCPResult(result, tool)
  // content => [
  //   {
  //     type: 'text',
  //     text: 'SHOP-482：登录失败时缺少审计日志；负责人为 auth-team。',
  //   },
  // ]

  return { content }
}
```

这一段把 MCP 的位置看得比较清楚：它替换的是 Tool 的具体实现。内置 `GrepTool.call()` 运行 ripgrep，MCP Tool 的 `call()` 发起 `tools/call`；外层的 `runToolUse()`、权限包装、取消信号、进度事件和 Tool Result 回写路径仍然相同。

连接在执行期间失效时，`callMCPToolWithUrlElicitationRetry()` 会重新取得连接并最多重试一次。它发生在 Tool 与参数已经确定之后，和第 1 节「还没有业务 Tool」的连接失败处在不同阶段。

## 小结

本篇追到的 MCP 路径可以收成三步：Server 通过 `.mcp.json` 被发现并连接；`tools/list` 返回的声明被适配成 Claude Code 内部 Tool，写入 MCP 状态；下一轮请求创建 Tool 快照后，模型才真正看得到 `mcp__project-tracker__get_issue`，并能通过它发起 `tools/call`。

这条路径里最值得保留的是两层隔离。外部 Server 只需要实现 MCP 协议，不必知道 Claude Code 的权限、取消和消息格式；Claude Code 也不需要知道工单系统的 HTTP 细节，只在统一 Tool 执行层处理调用和结果。连接结果先进入状态、再进入下一轮快照，则避免本轮模型请求中途改变可调用 Tool 集合。

## Skill 与 MCP 

追完 `get_issue` 的完整调用后，再对照第 7 篇的 Skill 路径，分界先出现在模型请求中。

模型收到的是两类不同的信息：Skill 的目录作为隐藏消息进入 `messages`，模型知道「有 `code-review` 可以展开」；MCP Tool 的名称、Schema 和描述则直接进入 `tools`，模型已经可以填写参数并请求调用。两条路径随后分别走向不同结果：

| 本轮模型看到的内容 | 模型可能返回的 Tool Use | Tool Result 后新增的内容 |
| --- | --- | --- |
| `code-review: 审查登录模块中的安全问题和错误处理` | `Skill({ skill: 'code-review', args: 'src/auth/login.ts' })` | 展开的 `SKILL.md` 正文，作为后续请求中的隐藏消息 |
| `mcp__project-tracker__get_issue` 的 Schema | `mcp__project-tracker__get_issue({ issueKey: 'SHOP-482' })` | MCP Server 返回的工单数据 |

源码位置：`src/screens/REPL.tsx:2390-2449`、`src/tools/SkillTool/SkillTool.ts:580-861`、`src/services/mcp/client.ts:1743-2014`

先看 Skill 这一侧。`skill_listing` 只放名称与描述；模型选中后，`SkillTool.call()` 通过 `processPromptSlashCommand()` 展开完整 `SKILL.md`，再把正文作为新消息放回会话。展开以后，真正读取文件、运行脚本或修改文件的仍是已有 `Read`、`Bash`、`Edit` 等 Tool。

因此，Skill 提供的不是一项新的外部动作，而是一段局部工作记忆：何时进行代码审查、先看哪些文件、检查哪些风险、必要时运行哪个脚本、结果怎样组织。比如 Skill 写下「运行 `scripts/check-login.sh`」，下一轮仍要由模型选择 `Bash`，再由 BashTool 执行脚本。

再看 MCP 这一侧。本篇走过的 `tools/list` 不是一段指导文本，而是把外部系统的一项动作变成了具体 Tool。模型不需要知道 `project-tracker` 是 Node、Python 还是远程 HTTP；只要 Schema 已经进入本轮 Tool 快照，就可以生成 `issueKey` 等参数。连接、命名、权限、取消、进度和结果包装留在 Claude Code，查询工单的实现细节留在 Server。

这样回到「排查线上登录失败」这条任务，就能看到两者可以同时出现。`code-review` 的正文要求检查失败分支、审计日志和测试覆盖；`mcp__project-tracker__get_issue` 取回 `SHOP-482` 当前状态、负责人和历史描述。前者把判断顺序补进上下文，后者把外部系统的真实状态带回会话。

顺着这两条路径，能力的落点也逐渐清楚：代码审查规范、发版 checklist、Incident 复盘流程、SQL 风格、仓库迁移步骤等，核心是让模型记住一套判断和已有 Tool 的使用顺序，适合进入 Skill；查询 Jira、读取 Notion、检索内部知识库、查数据库、触发部署、创建 Linear issue、读取监控指标等，核心是外部状态或动作，适合成为 MCP Tool。

### Skill 出现后，一部分早期 MCP 能力转成了 Skill

在 Skill 还没有成为常见接口时，想让 Agent 遵守一套流程、参考一份规范或按步骤排查问题，往往也只能通过 MCP 暴露出来：Server 提供一个「获取排查流程」或「加载团队规范」的 Tool，模型调用后拿到一大段说明文本。

这种做法能运行，但它把「知识和流程」伪装成了「每轮都可调用的外部动作」。Tool 的名称、描述和 Schema 会跟着 Tool 快照进入每次模型请求；当 Server 提供许多这类流程 Tool 时，不仅持续占用上下文，模型还需要在真正执行动作和「只想加载说明」的候选项之间做选择。

Skill 提供了更贴近这类能力的两级结构：首轮保留很短的名称和描述；只有任务匹配后，完整步骤、参考文件和脚本说明才进入会话。因此，原先只负责返回工作方法、操作手册或领域规范的一部分 MCP 能力，常会改成 Skill；而真正访问外部状态、产生副作用的接口仍保留为 MCP Tool。

| 原先容易被包装成 MCP 的内容 | Skill 出现后的更合适形态 | 原因 |
| --- | --- | --- |
| 「登录故障排查手册」 | `login-incident` Skill | 主体是判断顺序与检查清单，全文只在排查登录问题时需要 |
| 「SQL 审查规范」 | `sql-review` Skill | 主体是约束和示例，不需要独立的 API 调用协议 |
| 「查询工单 SHOP-482」 | `mcp__project-tracker__get_issue` Tool | 需要向外部系统传入参数并获得当前数据 |
| 「创建工单并写入负责人」 | `mcp__project-tracker__create_issue` Tool | 会产生外部副作用，需要 Schema、权限和结构化结果 |

「转成 Skill」指能力的接口形态发生调整，并不是把一个 MCP Tool 自动转换成 `SKILL.md`。如果原能力的核心仍然是调用某个远程系统，它保留为 MCP Tool 更合适；Skill 可以在正文中说明何时、按什么顺序调用这些 Tool。

### Sill 能否替代 MCP

把外部 API 藏进 Skill 的 Bash 示例中，也能临时执行 `curl`。但模型看到的只是 Bash 命令：参数结构没有成为 Tool Schema，鉴权和错误处理散在文本里，权限系统看到的是一条 Shell 命令而不是「查询工单」，结果也没有协议层的结构约束。能执行，不等于已经成为稳定的外部能力。

源码还留了一处交叉点：开启 `MCP_SKILLS` Feature Flag、并且 MCP Server 支持 resources 时，`client.ts` 会调用 `fetchMcpSkillsForClient()` 发现 `skill://` 资源；`SkillTool.ts` 中的 `getAllCommands()` 再把 `loadedFrom === 'mcp'` 的 Skill 合进 Commands 表。MCP 在这里提供的是 Skill 的运输渠道；文件被识别为 Skill 后，后续仍走 Skill 的正文展开路径，而不是 MCP Tool 的 `tools/call`。

两者可以出现在同一任务里，但没有互相替代：Skill 展开后继续组织已有 Tool 的使用，MCP 则在 Tool 表中增加新的外部动作。