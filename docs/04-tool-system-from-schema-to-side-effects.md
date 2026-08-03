---
title: 4、Tool 工具系统：从 Schema 到真实执行
---

上一篇沿着模型流走到 `queryLoop()`，最后得到了一条完整的 Tool Use：

```javascript
{
  type: 'tool_use',
  id: 'toolu_01',
  name: 'Grep',
  input: {
    pattern: 'login|auth',
    path: 'src/remote',
  },
}
```

这只是模型表达的调用意图。模型没有执行 `Grep`，也没有直接调用 JavaScript 函数。

接下来 Claude Code 还要完成几件事：

1. 从当前工具池找到 `Grep`；
2. 检查参数结构和路径；
3. 执行 Hook 与权限判断；
4. 调用 `GrepTool` 执行搜索；
5. 把结果变成带有同一个 ID 的 Tool Result；
6. 将 Tool Result 放进 `messages`，交给下一轮模型请求。

本篇以这条正常执行链为主线，同时说明普通调度、并发调度和流式 Tool 调度之间的关系，最后再补充用户中断与流式 Fallback 的收尾方式。权限规则怎样匹配、Hook 怎样配置，会在各自的文章中单独展开；这里仅保留它们在执行链中的位置和返回值。

这条链路值得读，不是因为它调用了很多函数，而是因为它集中解决了一个 Agent 必须面对的问题：**怎样把模型生成的、不能直接信任的调用意图，变成可校验、可授权、可并发、可中断的真实操作。**

## 先看完整调用链

![图 1：从 Tool Use 到下一轮模型请求](https://windliangblog.oss-cn-beijing.aliyuncs.com/diagram-01.png)

整条链路可以分成三层：

| 层次 | 关键代码 | 负责什么 |
| --- | --- | --- |
| 主循环 | `src/query.ts` | 收集 Tool Use，选择调度器，接收 Tool Result |
| 调度层 | `toolOrchestration.ts`、`StreamingToolExecutor.ts` | 决定何时执行、能否并发、何时产出结果 |
| 单次执行层 | `toolExecution.ts` | 查找 Tool、校验、Hook、权限、调用与结果封装 |

普通调度和流式调度只是启动 Tool 的时机不同：

- 普通调度等模型回答结束，再调用 `runTools()`；
- 流式调度在一个完整的 Tool Use 内容块到达后，立即交给 `StreamingToolExecutor`；
- 两条路径最终都会调用同一个 `runToolUse()`，Tool 的校验、权限和实际执行没有两套实现。

**这里的设计重点是把「何时执行」和「怎样执行」分开。** `runTools()` 和 `StreamingToolExecutor` 只优化调度时机，`runToolUse()` 才定义一次 Tool 调用必须经过的规则。

## `queryLoop()` 先选择调度路径

源码位置：`src/query.ts:551-568`、`src/query.ts:826-862`、`src/query.ts:1360-1408`

下面保持源码的执行顺序，省略与 Tool 调度无关的恢复分支：

```javascript
async function* queryLoop(/* ... */) {
  const assistantMessages = []
  const toolResults = []
  const toolUseBlocks = []

  const useStreamingToolExecution =
    config.gates.streamingToolExecution
  // => true 或 false，由运行配置决定

  let streamingToolExecutor =
    useStreamingToolExecution
      ? new StreamingToolExecutor(
          toolUseContext.options.tools,
          canUseTool,
          toolUseContext,
        )
      : null

  for await (
    const message of deps.callModel(/* ... */)
  ) {
    yield message

    if (message.type === 'assistant') {
      assistantMessages.push(message)

      const msgToolUseBlocks =
        message.message.content.filter(
          content => content.type === 'tool_use',
        )
      // 本文这一刻：
      // => [{
      //      id: 'toolu_01',
      //      name: 'Grep',
      //      input: {
      //        pattern: 'login|auth',
      //        path: 'src/remote',
      //      },
      //    }]

      if (msgToolUseBlocks.length > 0) {
        toolUseBlocks.push(...msgToolUseBlocks)
        needsFollowUp = true
        // => 本轮出现了 Tool Use，
        //    Tool 结果回写后还要继续下一轮
      }

      if (
        streamingToolExecutor &&
        !toolUseContext.abortController
          .signal.aborted
      ) {
        for (const toolBlock of msgToolUseBlocks) {
          streamingToolExecutor.addTool(
            toolBlock,
            message,
          )
          // addTool() 会把 Tool 加入队列，
          // 然后在内部触发 processQueue()。
          // 如果当前允许执行，后续路径是：
          // processQueue()
          //   -> executeTool()
          //   -> runToolUse()
          //
          // 下面的 getCompletedResults()
          // 只负责取走进度和已完成结果，
          // 不负责启动 Tool。
        }
      }
    }

    if (
      streamingToolExecutor &&
      !toolUseContext.abortController
        .signal.aborted
    ) {
      for (
        const result of
          streamingToolExecutor.getCompletedResults()
      ) {
        if (result.message) {
          yield result.message

          toolResults.push(
            ...normalizeMessagesForAPI(
              [result.message],
              toolUseContext.options.tools,
            ).filter(
              message =>
                message.type === 'user',
            ),
          )
        }
      }
    }
  }

  const toolUpdates = streamingToolExecutor
    ? streamingToolExecutor.getRemainingResults()
    : runTools( // 非流式在这里执行工具
        toolUseBlocks,
        assistantMessages,
        canUseTool,
        toolUseContext,
      )

  for await (const update of toolUpdates) {
    if (update.message) {
      yield update.message

      toolResults.push(
        ...normalizeMessagesForAPI(
          [update.message],
          toolUseContext.options.tools,
        ).filter(message => message.type === 'user'),
      )
    }
  }

  // 后面把 assistantMessages 和 toolResults
  // 一起写入下一轮 State
}
```

这里有两个不能忽略的条件：

- `needsFollowUp = true` 记录本轮出现了 Tool Use，后面需要把 Tool Result 带入下一轮；
- `!abortController.signal.aborted` 确保用户已经中断时，不再把新 Tool 加入流式执行队列，也不再取队列中的完成结果。

`streamingToolExecutor.addTool(toolBlock, message)` 这个调用本身没有省略其他参数。`addTool()` 内部怎样校验参数、判断并发安全性并加入队列，会在后面的流式 Tool 执行部分展开。

## Tool 不是一个函数，而是一份扩展协议

源码位置：`src/Tool.ts:321-336`、`src/Tool.ts:362-560`

如果 Tool 只是一个函数，定义可能只有：

```javascript
async function grep(input) {
  // ...
}
```

Claude Code 中的 `Tool` 还要描述输入、权限、并发、结果格式和界面表现。下面从真实 `Tool` 类型中截取本篇会经过的字段：

```javascript
export type Tool = {
  name: string
  inputSchema: ZodSchema
  maxResultSizeChars: number

  isConcurrencySafe(input): boolean
  isReadOnly(input): boolean
  validateInput?(input, context): Promise<ValidationResult>
  checkPermissions(input, context): Promise<PermissionResult>

  call(
    input,
    context,
    canUseTool,
    parentMessage,
    onProgress,
  ): Promise<ToolResult>

  mapToolResultToToolResultBlockParam(
    output,
    toolUseID,
  ): ToolResultBlockParam

  prompt(options): Promise<string>

  // 终端显示相关方法……
}
```

这份协议同时服务三个方向：

- 发请求前，`prompt()` 和 `inputSchema` 告诉模型 Tool 怎么调用；
- 执行时，`validateInput()`、`checkPermissions()` 和 `call()` 控制真实行为；
- 执行后，`mapToolResultToToolResultBlockParam()` 把内部返回值转换成模型能接收的 Tool Result。

`ToolResult` 本身也不只有结果数据：

```javascript
export type ToolResult = {
  data: unknown
  newMessages?: Message[]
  contextModifier?: (
    context,
  ) => ToolUseContext
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
}
```

普通 `Grep` 主要返回 `data`。有些 Tool 还会追加消息、修改后续执行上下文，或者携带 MCP 元数据。

**这份 `Tool` 类型实际上是一份扩展协议。** 新增 Tool 时，它需要提供「怎样向模型介绍自己」、「能否执行」、「真正做什么」和「怎样返回结果」。主循环和调度器只依赖这份协议，不需要知道 `Grep`、`Read` 或 `Edit` 各自的内部实现。

## Schema 既告诉模型怎么调用，也检查模型返回的参数

`GrepTool` 使用 Zod 定义输入。

> Zod 是 JavaScript/TypeScript 的数据校验库，这里可以把它理解成 Tool 的「参数说明书」：例如 `pattern` 必须是字符串，`path` 可以不传，但传了也必须是字符串。模型生成的参数不符合这份说明时，校验会失败，不会继续执行搜索。

同一份 `inputSchema` 有两个关键用途：

1. **请求模型前：** 转成 API 的 `tools[].input_schema`，让模型知道 `Grep` 有哪些参数、哪些必填；
2. **执行 Tool 前：** 使用 `safeParse(toolUse.input)` 检查模型真正返回的参数。

下面分别看这两个位置。

源码位置：`src/tools/GrepTool/GrepTool.ts:33-90`

```javascript
const inputSchema = lazySchema(() =>
  z.strictObject({
    pattern: z.string(),
    path: z.string().optional(),
    glob: z.string().optional(),
    output_mode: z
      .enum([
        'content',
        'files_with_matches',
        'count',
      ])
      .optional(),
    '-i': semanticBoolean(
      z.boolean().optional(),
    ),
    head_limit: semanticNumber(
      z.number().optional(),
    ),
    // 其他搜索参数……
  }),
)
```

### 请求模型前，Schema 会变成 API 工具定义

源码位置：`src/query.ts:659-690`、`src/services/api/claude.ts:1235-1247`、`src/services/api/claude.ts:1704-1712`、`src/utils/api.ts:119-178`

这一步发生在每轮请求模型时：

```javascript
queryLoop()
  -> callModel()
  -> queryModel()
  -> anthropic.beta.messages.create()
```

`queryLoop()` 把当前的 `messages` 和 `tools` 交给 `queryModel()`。`queryModel()` 在真正发请求前，调用 `toolToAPISchema()` 把每个 Tool 转成 API 格式。

```javascript
export async function toolToAPISchema(
  tool,
  options,
) {
  const input_schema =
    tool.inputJSONSchema ??
    zodToJsonSchema(tool.inputSchema)

  return {
    name: tool.name,
    description: await tool.prompt({
      getToolPermissionContext:
        options.getToolPermissionContext,
      tools: options.tools,
      agents: options.agents,
      allowedAgentTypes:
        options.allowedAgentTypes,
    }),
    input_schema,
  }
}
```

`Grep` 的定义会和本轮消息一起放进 API 请求：

```javascript
{
  messages: [
    {
      role: 'user',
      content: '检查登录模块',
    },
  ],
  tools: [
    // 下面的 Grep 定义
  ],
}
```

`tools` 和 `messages` 是同一次请求中的两个字段。`Grep` 放进 `tools` 的数据大致是：

```javascript
{
  name: 'Grep',
  description:
    'Search file contents with a regular expression...',
  input_schema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
      },
      path: {
        type: 'string',
      },
      output_mode: {
        enum: [
          'content',
          'files_with_matches',
          'count',
        ],
      },
      // 其他字段……
    },
    required: ['pattern'],
    additionalProperties: false,
  },
}
```

模型看到这份定义后，才知道可以生成：

```javascript
{
  type: 'tool_use',
  id: 'toolu_01',
  name: 'Grep',
  input: {
    pattern: 'login|auth',
    path: 'src/remote',
  },
}
```

### 执行 Tool 前，同一份 Schema 再校验一次

模型已经看过 Schema，不代表生成的参数一定合法。运行时仍会调用：

```javascript
tool.inputSchema.safeParse(toolUse.input)
```

两次使用解决的是不同问题：

- API 中的 `input_schema` 用来约束模型输出；
- 本地 `safeParse()` 用来保护真正的执行入口。

**这是「单一事实源」的用法。** 如果 API 的 Tool 说明和本地校验各写一份，新增参数时就容易只改其中一处：模型以为可以传，运行时却拒绝，或者本地支持了新参数，模型却永远不知道。这里由同一份 `inputSchema` 生成 API Schema，并在执行前再校验，两端不容易漂移。

## `buildTool()` 把协议的各部分接到一起

这里的 `GrepTool` 不是一个导出后就会自动执行的函数，而是 `buildTool()` 创建的 **Tool 对象**。它先被注册进内置工具池，之后才有两个使用者：发送模型请求的代码读取它的说明和 Schema；执行 Tool Use 的代码再按名称把它取出来。

先看注册过程。下面从源码中抽出了与 `GrepTool` 有关的主线。

源码位置：`src/tools.ts:59`、`src/tools.ts:193-203`、`src/tools.ts:271-324`

```javascript
// src/tools.ts
import {
  GrepTool,
} from './tools/GrepTool/GrepTool.js'

export function getAllBaseTools() {
  return [
    AgentTool,
    BashTool,

    // 本文讨论的运行环境没有内嵌搜索工具，
    // 因此把 GlobTool 和 GrepTool 加入内置工具池。
    ...(hasEmbeddedSearchTools()
      ? []
      : [GlobTool, GrepTool]),

    FileReadTool,
    FileEditTool,
    // 其他 Tool……
  ]
}

export const getTools = permissionContext => {
  const tools = getAllBaseTools()

  // 再根据权限规则和 isEnabled() 过滤。
  const allowedTools = filterToolsByDenyRules(
    tools,
    permissionContext,
  )

  return allowedTools.filter(tool => tool.isEnabled())
}
```

启动会话时，`main.tsx` 或 `REPL.tsx` 调用 `getTools()`，得到本次会话可用的 Tool。随后这组对象会进入 `toolUseContext.options.tools`。

源码位置：`src/main.tsx:1868`、`src/screens/REPL.tsx:696-811`

```javascript
// src/main.tsx
const tools = getTools(toolPermissionContext)
// => [AgentTool, BashTool, GrepTool,
//     FileReadTool, FileEditTool, ...]

// src/screens/REPL.tsx
const getToolUseContext = () => {
  return {
    options: {
      tools: computeTools(),
      // => [AgentTool, BashTool, GrepTool,
      //     FileReadTool, FileEditTool, ...]
    },
    // 其他会话数据……
  }
}
```

这组 Tool 有两个去向。

源码位置：`src/services/api/claude.ts:1234-1244`、`src/services/tools/toolExecution.ts:337-345`

```javascript
// src/services/api/claude.ts
// 请求模型前：把 GrepTool 的名称、说明和 inputSchema
// 转成 API 能识别的 Tool Schema。
const toolSchemas = await Promise.all(
  tools.map(tool => toolToAPISchema(tool, options)),
)

// src/services/tools/toolExecution.ts
// 模型返回 { name: 'Grep', ... } 后：
// 从同一组 Tool 中取回 GrepTool 对象。
const tool = findToolByName(
  toolUseContext.options.tools,
  toolUse.name,
  // => 'Grep'
)
// => GrepTool
```

所以，`GrepTool.ts` 负责定义 Tool，`tools.ts` 负责注册 Tool；请求模型时通过 `toolToAPISchema()` 读取它，执行 Tool Use 时通过 `findToolByName()` 取回它。后面的校验、权限检查、`call()` 和结果转换，调用的都是这个 `GrepTool` 对象上的方法。

下面再看这个对象具体提供了哪些字段。

源码位置：`src/tools/GrepTool/GrepTool.ts:160-240`、`src/tools/GrepTool/GrepTool.ts:254-328`

下面只保留执行链会访问的字段，每一项都来自同一个 `buildTool()` 定义：

```javascript
export const GrepTool = buildTool({
  name: GREP_TOOL_NAME,
  // => 'Grep'
  maxResultSizeChars: 20_000,
  strict: true,

  get inputSchema() {
    return inputSchema()
  },

  isConcurrencySafe() {
    return true
  },

  isReadOnly() {
    return true
  },

  async validateInput({ path }) {
    if (path) {
      const absolutePath = expandPath(path)
      // 本文：
      // => '/Users/windliang/others-project/'
      //    + 'claude-code-analysis/src/remote'

      try {
        await getFsImplementation().stat(
          absolutePath,
        )
      } catch (error) {
        if (isENOENT(error)) {
          return {
            result: false,
            message:
              `Path does not exist: ${path}`,
            errorCode: 1,
          }
        }
        throw error
      }
    }

    return {
      result: true,
    }
    // 本文 => { result: true }
  },

  async checkPermissions(input, context) {
    const appState = context.getAppState()

    return checkReadPermissionForTool(
      GrepTool,
      input,
      appState.toolPermissionContext,
    )
    // 本文假设当前目录允许读取：
    // => {
    //      behavior: 'allow',
    //      updatedInput: {
    //        pattern: 'login|auth',
    //        path: 'src/remote',
    //      },
    //    }
  },

  async call(input, context) {
    // 后面单独展开
  },

  mapToolResultToToolResultBlockParam(
    output,
    toolUseID,
  ) {
    // 后面单独展开
  },

  // UI 渲染字段……
})
```

`isReadOnly()` 和 `isConcurrencySafe()` 是两份独立声明：

- `isReadOnly()` 描述这次调用是否只读，权限界面会据此显示「Read」或「Edit」，部分受限场景也会用它判断是否允许执行；
- `isConcurrencySafe()` 描述这次调用能否与其他并发安全的 Tool 同时运行，普通和流式 Tool 调度器都读取这个值。

`GrepTool` 的两个值都是 `true`，但「只读」不能自动推出「可以并发」。例如，一个 Tool 虽然只查询数据，却可能使用不能并发访问的共享连接，此时应返回 `isReadOnly() === true`、`isConcurrencySafe() === false`。

这两个字段也说明，**Tool 不只提供行为，还要声明行为的性质。** 调度器不需要根据 Tool 名称猜测它能否并发；安全性由最了解自己的 Tool 声明，框架只负责执行这份声明。

到这里只是定义了 `GrepTool` 能做什么，它还没有开始执行。前面的 `queryLoop()` 收到 Tool Use 后，会根据是否启用流式 Tool 执行，走下面两条调度路径之一：

```javascript
// 普通调度
queryLoop()
  -> runTools()
  -> runToolsSerially()
     或 runToolsConcurrently()
  -> runToolUse()

// 流式调度
queryLoop()
  -> StreamingToolExecutor.addTool()
  -> processQueue()
  -> executeTool()
  -> runToolUse()
```

源码位置：`src/query.ts:1360-1408`、`src/services/tools/toolOrchestration.ts:130-169`、`src/services/tools/StreamingToolExecutor.ts:320-347`

两条路径只是调度时机不同，最后都会进入 `runToolUse()`。`runToolUse()` 再根据 Tool Use 中的 `name: 'Grep'` 找到 `GrepTool`，开始统一的校验和执行流程。

## `runToolUse()` 统一收口：安全检查不能靠 Tool 自觉

源码位置：`src/services/tools/toolExecution.ts:337-570`、`src/services/tools/toolExecution.ts:599-1588`

完整函数很长，先看按源码顺序抽出的主干：

![图 2：runToolUse 的固定执行流水线](https://windliangblog.oss-cn-beijing.aliyuncs.com/diagram-02.png)

这里实际有三层函数：

- `runToolUse()` 是调度器看到的入口，先根据名称找到 Tool；
- `streamedCheckPermissionsAndCallTool()` 是流式包装层，把进度消息和最终结果放进同一个异步流；
- `checkPermissionsAndCallTool()` 才负责第 2～7 步：校验、Hook、权限、调用 Tool 和封装结果。

调用关系是：

```javascript
runToolUse()
  -> streamedCheckPermissionsAndCallTool()
  -> checkPermissionsAndCallTool()
```

对应代码框架如下。每个步骤后面都会代入本文的运行值：

```javascript
export async function* runToolUse(
  toolUse,
  assistantMessage,
  canUseTool,
  toolUseContext,
) {
  // 1. 根据名称找到 Tool
  const tool = findToolByName(
    toolUseContext.options.tools,
    toolUse.name,
  )

  // 转交给流式包装层，
  // 持续向上转发进度消息和最终结果
  for await (
    const update of
      streamedCheckPermissionsAndCallTool(
        tool,
        toolUse.id,
        toolUse.input,
        toolUseContext,
        canUseTool,
        assistantMessage,
        // 追踪参数……
      )
  ) {
    yield update
  }
}

function streamedCheckPermissionsAndCallTool(
  tool,
  toolUseID,
  input,
  toolUseContext,
  canUseTool,
  assistantMessage,
  // 追踪参数……
) {
  const stream = new Stream()

  checkPermissionsAndCallTool(
    tool,
    toolUseID,
    input,
    toolUseContext,
    canUseTool,
    assistantMessage,
    // 追踪参数……
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
      for (const result of results) {
        stream.enqueue(result)
      }
    })
    .catch(error => stream.error(error))
    .finally(() => stream.done())

  return stream
}

async function checkPermissionsAndCallTool(
  tool,
  toolUseID,
  input,
  toolUseContext,
  canUseTool,
  assistantMessage,
  // 追踪参数……
  onToolProgress,
) {
  // 2. Schema 校验
  const parsedInput =
    tool.inputSchema.safeParse(input)

  // 3. Tool 自己的语义校验
  await tool.validateInput?.(
    parsedInput.data,
    toolUseContext,
  )

  // 4. PreToolUse Hook
  for await (
    const result of runPreToolUseHooks(/* ... */)
  ) {
    // Hook 可以追加上下文、修改输入或停止执行
  }

  // 第 4 步继续：合并 Hook 和通用权限结果
  const resolved =
    await resolveHookPermissionDecision(
      /* ... */
    )

  // 5. 真正调用 Tool
  const result = await tool.call(
    resolved.input,
    {
      ...toolUseContext,
      toolUseId: toolUseID,
    },
    canUseTool,
    assistantMessage,
    progress => onToolProgress(progress),
  )

  // 6. 转换成 Tool Result
  const mappedToolResultBlock =
    tool.mapToolResultToToolResultBlockParam(
      result.data,
      toolUseID,
    )

  // 7. PostToolUse Hook、消息封装……
}
```

`streamedCheckPermissionsAndCallTool()` 这层包装主要涉及两个点。

### 1. Tool 没执行完，也能先显示进度

`tool.call()` 返回 Promise。如果只等待 Promise，界面必须等 Tool 完全结束以后才能收到消息。对于运行十几秒的 Bash 命令，这段时间看起来就像卡住了。

因此 Tool 还可以调用 `onProgress`。每次上报都会立即放进 Stream，最终 Promise 完成后，再把正式 Tool Result 放进去：

```javascript
// Bash 执行过程中
onProgress(...)
// => Stream 收到 { message: { type: 'progress', ... } }
// => 界面立即更新当前输出

// Bash 执行完成
return finalResult
// => Stream 收到包含 tool_result 的 user message
// => stream.done()
```

`runToolUse()` 使用一个 `for await`，就能依次转发「若干条进度 + 最终结果」。`GrepTool` 不上报进度，所以通常只会转发最终结果。

### 2. 这里的 `streamed` 不表示「提前启动 Tool」

前面讲的 `StreamingToolExecutor` 决定 **Tool 什么时候开始执行**：模型的 Tool Use 内容块刚完整，就可以提前启动。

这里的 `streamedCheckPermissionsAndCallTool()` 决定 **Tool 开始以后，消息怎样返回**：把执行进度和最终结果陆续交给上层。

所以两者解决的问题不同：一个优化启动时机，一个负责显示执行过程。

## 逐步代入一次 `Grep`

### 1. 根据 `name` 找到 Tool：工具池就是能力边界

源码位置：`src/services/tools/toolExecution.ts:337-411`

```javascript
export async function* runToolUse(
  toolUse,
  assistantMessage,
  canUseTool,
  toolUseContext,
) {
  const toolName = toolUse.name
  // => 'Grep'

  const tool = findToolByName(
    toolUseContext.options.tools,
    toolName,
  )
  // => GrepTool

  if (!tool) {
    yield createUserMessage({
      content: [{
        type: 'tool_result',
        tool_use_id: toolUse.id,
        is_error: true,
        content:
          'Error: No such tool available: Grep',
      }],
    })
    return
  }

  // 继续执行……
}
```

查找范围是当前会话的 `toolUseContext.options.tools`，不是任意导入的 Tool。第一篇组装好的工具池在这里真正被使用。

如果模型生成了当前会话中不存在的 Tool，Claude Code 不会直接抛出并丢失本轮状态，而是返回同 ID 的错误 Tool Result，让模型在下一轮看到失败原因。

这里的工具池也是一条能力边界。代码库中已经实现某个 Tool，不代表当前会话就能使用它；只有被放入 `toolUseContext.options.tools` 的能力才会被查找到。这比根据模型返回的名称动态加载任意实现更容易控制。

### 2. Schema 校验参数结构：先快速失败

源码位置：`src/services/tools/toolExecution.ts:599-680`

```javascript
async function checkPermissionsAndCallTool(
  tool,
  toolUseID,
  input,
  toolUseContext,
  canUseTool,
  assistantMessage,
  // ...
) {
  const parsedInput =
    tool.inputSchema.safeParse(input)

  // 本文：
  // parsedInput.success => true
  // parsedInput.data => {
  //   pattern: 'login|auth',
  //   path: 'src/remote',
  // }

  if (!parsedInput.success) {
    return [{
      message: createUserMessage({
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseID,
          is_error: true,
          content:
            '<tool_use_error>' +
            'InputValidationError: ...' +
            '</tool_use_error>',
        }],
      }),
    }]
  }

  // 继续执行……
}
```

例如模型把 `pattern` 漏掉，或额外生成了严格 Schema 不允许的字段，就会在这里结束，不会进入 `GrepTool.call()` 执行搜索。

这一层只检查「数据长得对不对」。它不读文件系统，也不做权限判断，所以可以在执行链前部快速失败。

### 3. `validateInput()` 校验参数语义：结构正确不等于可执行

源码位置：`src/services/tools/toolExecution.ts:682-733`

从第 3 步到第 7 步，主线始终都在 `checkPermissionsAndCallTool()` 中；只有第 5 步调用 `tool.call()` 时，才会暂时进入 `GrepTool.call()`。下面每段代码都会保留所在函数。

Schema 校验通过后，紧接着执行语义校验：

```javascript
async function checkPermissionsAndCallTool(
  tool,
  toolUseID,
  input,
  toolUseContext,
  // 其他参数……
) {
  // 第 2 步：Schema 校验已经通过
  const parsedInput =
    tool.inputSchema.safeParse(input)

  if (!parsedInput.success) {
    return /* Schema 错误 Tool Result */
  }

  // 第 3 步：继续校验参数语义
  const isValidCall = await tool.validateInput?.(
    parsedInput.data,
    toolUseContext,
  )

  // 本文 => { result: true }

  if (isValidCall?.result === false) {
    return [{
      message: createUserMessage({
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseID,
          is_error: true,
          content:
            `<tool_use_error>` +
            `${isValidCall.message}` +
            `</tool_use_error>`,
        }],
      }),
    }]
  }

  // 第 4 步：继续执行 Hook 和权限检查
  // ...
}
```

Schema 只能确认 `path` 是字符串，不能确认路径真的存在。`GrepTool.validateInput()` 负责第二层语义校验。

因此：

```javascript
{
  pattern: 'login|auth',
  path: 42,
}
// => Schema 校验失败

{
  pattern: 'login|auth',
  path: 'not-exists',
}
// => Schema 通过，validateInput() 失败
```

**结构校验和语义校验分开，是这条执行链中很实用的分层。** Schema 可以复用于 API 描述和本地类型检查；`validateInput()` 则由各个 Tool 处理「路径是否存在」这类需要业务知识或外部状态的问题。

### 4. Hook 和权限：把策略从副作用中拆出来

源码位置：`src/services/tools/toolExecution.ts:795-862`、`src/services/tools/toolExecution.ts:916-1037`

下面仍然是同一个 `checkPermissionsAndCallTool()`。前两层校验通过后，`parsedInput.data` 才会进入 Hook 和权限流程：

```javascript
async function checkPermissionsAndCallTool(
  tool,
  toolUseID,
  input,
  toolUseContext,
  canUseTool,
  assistantMessage,
  onToolProgress,
) {
  // 第 2、3 步已经得到合法的 parsedInput
  // ...

  // 第 4 步：Hook 可以观察、修改或阻止输入
  let processedInput = parsedInput.data
  // => {
  //      pattern: 'login|auth',
  //      path: 'src/remote',
  //    }

  let hookPermissionResult

  for await (
    const result of runPreToolUseHooks(
      toolUseContext,
      tool,
      processedInput,
      toolUseID,
      assistantMessage.message.id,
      // 其他参数……
    )
  ) {
    if (result.type === 'hookUpdatedInput') {
      processedInput = result.updatedInput
    }

    if (result.type === 'hookPermissionResult') {
      hookPermissionResult =
        result.hookPermissionResult
    }

    if (result.type === 'stop') {
      return /* Hook 生成的错误 Tool Result */
    }
  }

  // 综合 Hook、权限规则和用户确认结果
  const resolved = await resolveHookPermissionDecision(
    hookPermissionResult,
    tool,
    processedInput,
    toolUseContext,
    canUseTool,
    assistantMessage,
    toolUseID,
  )

  const permissionDecision = resolved.decision
  processedInput = resolved.input

  // 本文假设没有 Hook 修改输入，
  // 当前目录也允许 Grep：
  //
  // processedInput => {
  //   pattern: 'login|auth',
  //   path: 'src/remote',
  // }
  //
  // permissionDecision => {
  //   behavior: 'allow',
  //   updatedInput: {
  //     pattern: 'login|auth',
  //     path: 'src/remote',
  //   },
  //   decisionReason: {
  //     type: 'mode',
  //     mode: 'default',
  //   },
  // }

  if (permissionDecision.behavior !== 'allow') {
    return /* 拒绝执行的错误 Tool Result */
  }

  // 第 5 步：继续调用 tool.call()
  // ...
}
```

这里先保留两个结论：

- Hook 可以在 Tool 执行前观察、修改或阻止这次调用；
- 权限结果不是简单的 `true`/`false`，还可能带回修改后的输入和决策原因。

权限规则如何从 `permissionMode`、CLI 参数和项目配置中得到，会在权限系统文章展开。本篇只需要确认：只有 `behavior === 'allow'` 才会继续走到 `tool.call()`。

**这一层把「Tool 会做什么」和「这一次是否允许做」分开了。** `GrepTool.call()` 专心完成搜索，Hook 和权限系统则根据当前会话、目录和模式作出决定。这样同一个 `GrepTool` 可以在不同权限模式下复用，而不用把会话策略写死在搜索代码里。

### 5. `GrepTool.call()`：把真实副作用收敛在一处

源码位置：`src/services/tools/toolExecution.ts:1178-1223`、`src/tools/GrepTool/GrepTool.ts:310-475`、`src/tools/GrepTool/GrepTool.ts:526-575`

通过权限检查后，`checkPermissionsAndCallTool()` 才调用刚才找到的 `GrepTool`：

```javascript
async function checkPermissionsAndCallTool(
  tool,
  toolUseID,
  input,
  toolUseContext,
  canUseTool,
  assistantMessage,
  onToolProgress,
) {
  // 第 2～4 步已经完成校验、Hook 和权限检查
  // processedInput => {
  //   pattern: 'login|auth',
  //   path: 'src/remote',
  // }

  // 第 5 步：真正调用 GrepTool.call()
  const result = await tool.call(
    processedInput,
    {
      ...toolUseContext,
      toolUseId: toolUseID,
    },
    canUseTool,
    assistantMessage,
    progress => {
      onToolProgress({
        toolUseID: progress.toolUseID,
        data: progress.data,
      })
    },
  )

  // 第 6 步：继续映射 Tool Result
  // ...
}
```

现在才进入 `GrepTool.call()`：

```javascript
export const GrepTool = buildTool({
  // ...

  async call(
    {
      pattern,
      path,
      output_mode = 'files_with_matches',
      '-i': caseInsensitive = false,
      head_limit: headLimit,
      offset = 0,
      // 其他参数……
    },
    {
      abortController,
      getAppState,
    },
  ) {
    const absolutePath = path
      ? expandPath(path)
      : getCwd()
    // => '/Users/windliang/others-project/'
    //    + 'claude-code-analysis/src/remote'

    const args = ['--hidden']

    for (
      const directory of
        VCS_DIRECTORIES_TO_EXCLUDE
    ) {
      args.push('--glob', `!${directory}`)
    }

    args.push('--max-columns', '500')

    if (output_mode === 'files_with_matches') {
      args.push('-l')
    }

    args.push(pattern)

    // 没有额外 ignore 规则时，核心参数相当于：
    // => [
    //      '--hidden',
    //      '--glob', '!.git',
    //      '--glob', '!.svn',
    //      '--glob', '!.hg',
    //      '--glob', '!.bzr',
    //      '--glob', '!.jj',
    //      '--glob', '!.sl',
    //      '--max-columns', '500',
    //      '-l',
    //      'login|auth',
    //    ]

    const results = await ripGrep(
      args,
      absolutePath,
      abortController.signal,
    )
    // 本文项目中的实际匹配：
    // => [
    //      '/Users/windliang/others-project/'
    //        + 'claude-code-analysis/src/remote/'
    //        + 'SessionsWebSocket.ts',
    //      '/Users/windliang/others-project/'
    //        + 'claude-code-analysis/src/remote/'
    //        + 'sdkMessageAdapter.ts',
    //    ]

    const stats = await Promise.allSettled(
      results.map(
        file =>
          getFsImplementation().stat(file),
      ),
    )

    const sortedMatches = results
      .map((file, index) => {
        const stat = stats[index]

        return [
          file,
          stat.status === 'fulfilled'
            ? stat.value.mtimeMs ?? 0
            : 0,
        ]
      })
      .sort(
        (left, right) =>
          right[1] - left[1] ||
          left[0].localeCompare(right[0]),
      )
      .map(([file]) => file)

    const {
      items: finalMatches,
    } = applyHeadLimit(
      sortedMatches,
      headLimit,
      offset,
    )
    // headLimit => undefined
    // 默认最多保留 250 个结果
    // 本文只有 2 个结果，不会截断

    const relativeMatches =
      finalMatches.map(toRelativePath)
    // => [
    //      'src/remote/SessionsWebSocket.ts',
    //      'src/remote/sdkMessageAdapter.ts',
    //    ]

    return {
      data: {
        mode: 'files_with_matches',
        filenames: relativeMatches,
        numFiles: relativeMatches.length,
      },
    }
    // => {
    //      data: {
    //        mode: 'files_with_matches',
    //        filenames: [
    //          'src/remote/SessionsWebSocket.ts',
    //          'src/remote/sdkMessageAdapter.ts',
    //        ],
    //        numFiles: 2,
    //      },
    //    }
  },
})
```

`GrepTool.call()` 才是真实操作发生的位置。对于 `Grep`，这里会启动子进程并读取文件；换成 `Edit`、`Write` 或 `Bash`，这里还可能修改文件或运行命令，产生更明显的外部副作用。

前面的 Schema、Hook 和权限流水线，就是为了在到达这一行之前把调用变得可控。

这也给阅读其他 Tool 提供了一个快速方法：先找 `tool.call()` 确认真实操作，再向上看它经过了哪些校验和授权。把外部操作收敛在明确边界内，代码审查、中断处理和测试都会更容易定位。

### 6. 映射 Tool Result：内部数据不直接绑定 API 协议

源码位置：`src/tools/GrepTool/GrepTool.ts:254-308`、`src/services/tools/toolExecution.ts:1290-1295`

`tool.call()` 返回的是 `GrepTool` 自己定义的内部数据：

```javascript
{
  data: {
    mode: 'files_with_matches',
    filenames: [
      'src/remote/SessionsWebSocket.ts',
      'src/remote/sdkMessageAdapter.ts',
    ],
    numFiles: 2,
  },
}
```

这个 `result` 仍然留在 `checkPermissionsAndCallTool()` 中。紧接着，执行层把内部数据交给 Tool 自己转换：

```javascript
async function checkPermissionsAndCallTool(
  tool,
  toolUseID,
  input,
  toolUseContext,
  canUseTool,
  assistantMessage,
  onToolProgress,
) {
  // 第 2～4 步已经得到 processedInput
  // ...

  // 第 5 步：tool.call() 返回内部结果
  const result = await tool.call(
    processedInput,
    {
      ...toolUseContext,
      toolUseId: toolUseID,
    },
    canUseTool,
    assistantMessage,
    progress => {
      onToolProgress({
        toolUseID: progress.toolUseID,
        data: progress.data,
      })
    },
  )

  // 第 6 步：转换成模型 API 的 Tool Result
  const mappedToolResultBlock =
    tool.mapToolResultToToolResultBlockParam(
    result.data,
    toolUseID,
  )
  // toolUseID => 'toolu_01'

  // 第 7 步：继续包装 UserMessage
  // ...
}
```

`GrepTool` 的转换代码是：

```javascript
export const GrepTool = buildTool({
  // GrepTool 的其他字段……

  mapToolResultToToolResultBlockParam(
    {
      mode = 'files_with_matches',
      numFiles,
      filenames,
      appliedLimit,
      appliedOffset,
    },
    toolUseID,
  ) {
    const result =
      `Found ${numFiles} files\n` +
      filenames.join('\n')

    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: result,
    }
  },
})
```

本文得到：

```javascript
{
  type: 'tool_result',
  tool_use_id: 'toolu_01',
  content:
    'Found 2 files\n' +
    'src/remote/SessionsWebSocket.ts\n' +
    'src/remote/sdkMessageAdapter.ts',
}
```

`toolu_01` 不是 Claude Code 在这里重新生成的。它来自模型返回的 `tool_use.id`，随后沿调用链传给 `runToolUse()`、`tool.call()` 和结果映射函数。

最终：

```javascript
tool_use.id
// => 'toolu_01'

tool_result.tool_use_id
// => 'toolu_01'
```

模型下一轮看到这两个字段，才能知道这段搜索结果对应哪一次 Tool Use。同一轮包含多个 Tool Use 时，ID 的作用更加明显。

这里有两个可复用的设计。

第一，`GrepTool.call()` 返回适合内部处理的结构化数据，`mapToolResultToToolResultBlockParam()` 再负责转成模型 API 协议。搜索实现不需要混入 `role: 'user'`、`tool_use_id` 这些传输层细节。

第二，`tool_use.id` 像一个关联键。即使同一轮并发了多个 Tool，结果到达顺序不同，也不需要依赖数组下标猜测哪个结果属于哪次调用。

### 7. 包装 `UserMessage`：限制结果对上下文的占用

源码位置：`src/services/tools/toolExecution.ts:1403-1473`

最后仍在 `checkPermissionsAndCallTool()` 中，通过内部函数 `addToolResult()` 把内容块放进 `UserMessage`：

```javascript
async function checkPermissionsAndCallTool(
  tool,
  toolUseID,
  input,
  toolUseContext,
  canUseTool,
  assistantMessage,
  onToolProgress,
) {
  const resultingMessages = []

  // 第 2～4 步已经得到 processedInput
  // ...

  // 第 5 步：执行 Tool
  const result = await tool.call(
    processedInput,
    {
      ...toolUseContext,
      toolUseId: toolUseID,
    },
    canUseTool,
    assistantMessage,
    progress => {
      onToolProgress({
        toolUseID: progress.toolUseID,
        data: progress.data,
      })
    },
  )

  // 第 6 步：映射 Tool Result
  const mappedToolResultBlock =
    tool.mapToolResultToToolResultBlockParam(
      result.data,
      toolUseID,
    )

  async function addToolResult(
    toolUseResult,
    preMappedBlock,
  ) {
    const toolResultBlock =
      await processPreMappedToolResultBlock(
      preMappedBlock,
      tool.name,
      tool.maxResultSizeChars,
    )

    resultingMessages.push({
      message: createUserMessage({
        content: [toolResultBlock],
        toolUseResult,
        sourceToolAssistantUUID:
          assistantMessage.uuid,
      }),
    })
  }

  // 第 7 步：传入第 6 步映射好的内容块
  await addToolResult(
    result.data,
    mappedToolResultBlock,
  )

  return resultingMessages
}
```

只展开会送进模型的核心字段后，结果是：

```javascript
{
  type: 'user',
  message: {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'toolu_01',
      content:
        'Found 2 files\n' +
        'src/remote/SessionsWebSocket.ts\n' +
        'src/remote/sdkMessageAdapter.ts',
    }],
  },
}
```

Tool Result 使用 `role: 'user'` 不是在伪装真人输入，而是遵守模型 API 的消息协议：Assistant 发出 Tool Use，随后由 User 消息携带对应的 Tool Result。

结果过大时，`processPreMappedToolResultBlock()` 还会根据 `maxResultSizeChars` 处理持久化和预览。`GrepTool` 设置的阈值是 `20_000` 个字符。本例结果很短，不会触发这一分支。

如果 Grep 返回了 `31_842` 个字符，处理过程不是简单截断，而是分成两步：完整结果写入磁盘，Tool Result 中只保留文件地址和前 `2_000` 个字符的预览。

源码位置：`src/utils/toolResultStorage.ts:131-214`、`src/utils/toolResultStorage.ts:232-333`

沿着上一段的 `processPreMappedToolResultBlock()` 继续往下看，主线可以简化成：

```javascript
export async function processPreMappedToolResultBlock(
  toolResultBlock,
  toolName,
  maxResultSizeChars,
) {
  return maybePersistLargeToolResult(
    toolResultBlock,
    toolName,
    getPersistenceThreshold(toolName, maxResultSizeChars),
    // => Grep 的有效阈值通常是 20_000
  )
}

async function maybePersistLargeToolResult(
  toolResultBlock,
  toolName,
  persistenceThreshold,
) {
  const content = toolResultBlock.content
  const size = contentSize(content)
  // => 31_842

  if (size <= persistenceThreshold) {
    return toolResultBlock
  }

  const result = await persistToolResult(
    content,
    toolResultBlock.tool_use_id,
    // => 'toolu_01'
  )
  // => {
  //   filepath: '<会话目录>/tool-results/toolu_01.txt',
  //   originalSize: 31_842,
  //   preview: '前约 2_000 个字符……',
  //   hasMore: true,
  // }

  if (isPersistError(result)) {
    return toolResultBlock
    // => 写文件失败时不丢结果，仍返回原始 Tool Result
  }

  return {
    ...toolResultBlock,
    content: buildLargeToolResultMessage(result),
  }
}
```

对于 Grep 这种字符串结果，完整内容会保存为 `<会话目录>/tool-results/toolu_01.txt`。文件名来自本次调用的 `tool_use_id`，因此同一次 Tool Use 重放时仍能定位同一个文件。

最终进入 `messages` 的不再是全部 `31_842` 个字符，而是下面这样的 Tool Result：

```javascript
{
  type: 'tool_result',
  tool_use_id: 'toolu_01',
  content:
    '<persisted-output>\n' +
    'Output too large (31.1KB). Full output saved to: ' +
    '<会话目录>/tool-results/toolu_01.txt\n\n' +
    'Preview (first 2KB):\n' +
    '前约 2_000 个字符……\n' +
    '...\n' +
    '</persisted-output>',
}
```

模型由此可以先根据预览判断结果是否相关；确实需要后半部分时，再使用 Read Tool 读取文件。完整结果没有丢失，但不会一次性挤进下一轮上下文。`tool_use_id` 也没有改变，Tool Use 与 Tool Result 的对应关系仍然成立。

## Tool Result 进入下一轮：Tool 不推进主循环

源码位置：`src/query.ts:1380-1408`、`src/query.ts:1673-1725`

执行器产出的消息先由 `queryLoop()` 收集：

```javascript
for await (const update of toolUpdates) {
  if (update.message) {
    yield update.message

    toolResults.push(
      ...normalizeMessagesForAPI(
        [update.message],
        toolUseContext.options.tools,
      ).filter(message => message.type === 'user'),
    )
  }
}

// 本文：
// assistantMessages.length => 1
// toolResults.length => 1
```

Tool 全部结束后，`queryLoop()` 生成下一轮 State：

```javascript
const nextTurnCount = turnCount + 1
// => 1 + 1
// => 2

const next = {
  messages: [
    ...messagesForQuery,
    ...assistantMessages,
    ...toolResults,
  ],
  toolUseContext:
    toolUseContextWithQueryTracking,
  turnCount: nextTurnCount,
  transition: {
    reason: 'next_turn',
  },
  // 恢复相关字段……
}
```

只展开下一次 API 请求真正使用的 `message` 字段后，消息顺序变成：

```javascript
next.messages
// => [
//   {
//     role: 'user',
//     content: '检查登录模块',
//   },
//   {
//     role: 'assistant',
//     content: [{
//       type: 'tool_use',
//       id: 'toolu_01',
//       name: 'Grep',
//       input: {
//         pattern: 'login|auth',
//         path: 'src/remote',
//       },
//     }],
//   },
//   {
//     role: 'user',
//     content: [{
//       type: 'tool_result',
//       tool_use_id: 'toolu_01',
//       content:
//         'Found 2 files\n' +
//         'src/remote/SessionsWebSocket.ts\n' +
//         'src/remote/sdkMessageAdapter.ts',
//     }],
//   },
// ]
```

第二篇中的「Tool Result 怎样带进下一轮」，到这里已经落到了具体代码：不是 Tool 自己再次调用模型，而是 `queryLoop()` 把两类消息按协议顺序拼进 `next.messages`，然后同一个主循环开始下一轮。

**Tool 只负责产生结果，主循环才负责推进会话状态。** 这个边界避免了每个 Tool 都能自己开启下一轮模型请求，轮次、消息顺序和恢复逻辑仍然由 `queryLoop()` 统一管理。

## 多个 Tool Use：并发执行，按顺序提交状态

普通调度路径进入 `runTools()` 后，不会直接对所有 Tool 使用 `Promise.all()`。

源码位置：`src/services/tools/toolOrchestration.ts:19-116`

```javascript
export async function* runTools(
  toolUseMessages,
  assistantMessages,
  canUseTool,
  toolUseContext,
) {
  let currentContext = toolUseContext

  const batches = partitionToolCalls(
    toolUseMessages,
    currentContext,
  )

  // batches 中的分组仍保持模型给出的先后顺序
  for (const { isConcurrencySafe, blocks } of batches) {
    if (isConcurrencySafe) {
      // 同一批 Tool 可以并发执行，完成顺序不确定。
      // 因此先暂存它们产生的上下文修改，不立即应用。
      const queuedContextModifiers = {}

      const updates = runToolsConcurrently(
        blocks,
        assistantMessages,
        canUseTool,
        currentContext,
      )

      for await (const update of updates) {
        if (update.contextModifier) {
          const { toolUseID, modifyContext } =
            update.contextModifier

          queuedContextModifiers[toolUseID] ??= []
          queuedContextModifiers[toolUseID].push(
            modifyContext,
          )
        }

        // 消息可以实时上交，但此时的 Context 还没有改变。
        yield {
          message: update.message,
          newContext: currentContext,
        }
      }

      // 全批结束后，按原始 blocks 顺序提交状态。
      // 这样不会因为某个 Tool 先完成，就改变最终状态顺序。
      for (const block of blocks) {
        const modifiers =
          queuedContextModifiers[block.id]

        for (
          const modifier of
            modifiers ?? []
        ) {
          currentContext =
            modifier(currentContext)
        }
      }

      // 整批状态按顺序应用完，再提交新的 Context。
      yield { newContext: currentContext }
    } else {
      // 不确定是否安全时保持串行，执行完一个再更新状态。
      const updates = runToolsSerially(
        blocks,
        assistantMessages,
        canUseTool,
        currentContext,
      )

      for await (const update of updates) {
        currentContext =
          update.newContext ??
          currentContext

        yield {
          message: update.message,
          newContext: currentContext,
        }
      }
    }
  }
}
```

`runTools()` 只负责分组和选择调度方式，所以没有直接调用 `runToolUse()`。真正的一对一调用位于下面两个内部函数。

源码位置：`src/services/tools/toolOrchestration.ts:118-169`

```javascript
async function* runToolsSerially(
  toolUseMessages,
  assistantMessages,
  canUseTool,
  toolUseContext,
) {
  let currentContext = toolUseContext

  // 串行路径：一个 Tool 完成后，才执行下一个。
  for (const toolUse of toolUseMessages) {
    const assistantMessage = assistantMessages.find(
      message => message.message.content.some(
        block => block.type === 'tool_use' &&
          block.id === toolUse.id,
      ),
    )

    for await (const update of runToolUse(
      toolUse,
      assistantMessage,
      canUseTool,
      currentContext,
    )) {
      if (update.contextModifier) {
        currentContext =
          update.contextModifier.modifyContext(currentContext)
      }

      yield {
        message: update.message,
        newContext: currentContext,
      }
    }
  }
}

async function* runToolsConcurrently(
  toolUseMessages,
  assistantMessages,
  canUseTool,
  toolUseContext,
) {
  // 并发路径：每个 Tool Use 都创建一个 runToolUse()；
  // all() 同时消费这些异步生成器，并限制最大并发数。
  yield* all(
    toolUseMessages.map(async function* (toolUse) {
      const assistantMessage = assistantMessages.find(
        message => message.message.content.some(
          block => block.type === 'tool_use' &&
            block.id === toolUse.id,
        ),
      )

      yield* runToolUse(
        toolUse,
        assistantMessage,
        canUseTool,
        toolUseContext,
      )
    }),
    getMaxToolUseConcurrency(),
  )
}
```

所以普通调度的完整关系是：`runTools()` 先分组，再进入串行或并发函数，最后每个 Tool Use 都单独调用一次 `runToolUse()`。

假设模型一次返回：

```javascript
[
  {
    id: 'toolu_01',
    name: 'Grep',
    input: {
      pattern: 'login',
      path: 'src',
    },
  },
  {
    id: 'toolu_02',
    name: 'Read',
    input: {
      file_path: 'src/auth.ts',
    },
  },
  {
    id: 'toolu_03',
    name: 'Edit',
    input: {
      file_path: 'src/auth.ts',
      old_string: 'timeout = 10',
      new_string: 'timeout = 30',
    },
  },
  {
    id: 'toolu_04',
    name: 'Grep',
    input: {
      pattern: 'timeout',
      path: 'src',
    },
  },
]
```

`partitionToolCalls()` 会先解析参数，再调用每个 Tool 的 `isConcurrencySafe()`：

```javascript
function partitionToolCalls(
  toolUseMessages,
  toolUseContext,
) {
  return toolUseMessages.reduce(
    (batches, toolUse) => {
      // 先找到 Tool，并用 Schema 解析本次输入。
      // isConcurrencySafe() 可能依赖具体参数。
      const tool = findToolByName(
        toolUseContext.options.tools,
        toolUse.name,
      )

      const parsedInput =
        tool?.inputSchema.safeParse(
          toolUse.input,
        )

      const isConcurrencySafe =
        parsedInput?.success
          ? (() => {
              try {
                return Boolean(
                  tool?.isConcurrencySafe(
                    parsedInput.data,
                  ),
                )
              } catch {
                return false
              }
            })()
          : false

      const previousBatch = batches.at(-1)

      if (
        isConcurrencySafe &&
        previousBatch?.isConcurrencySafe
      ) {
        // 相邻的并发安全 Tool 合并为同一批。
        previousBatch.blocks.push(toolUse)
      } else {
        // 非并发安全 Tool 单独成批；
        // 后面的安全 Tool 也不能跨过它提前执行。
        batches.push({
          isConcurrencySafe,
          blocks: [toolUse],
        })
      }

      return batches
    },
    [],
  )
}
```

分组结果是：

```javascript
[
  {
    isConcurrencySafe: true,
    blocks: [
      'toolu_01: Grep',
      'toolu_02: Read',
    ],
  },
  {
    isConcurrencySafe: false,
    blocks: [
      'toolu_03: Edit',
    ],
  },
  {
    isConcurrencySafe: true,
    blocks: [
      'toolu_04: Grep',
    ],
  },
]
```

执行顺序是：

1. 第一个 `Grep` 与 `Read` 可以并发；
2. 等它们结束后，`Edit` 独占执行；
3. `Edit` 完成后，最后一个 `Grep` 才开始。

这样能避免最后一个 `Grep` 在文件修改完成前读到旧内容。并发上限默认是 `10`，也可以通过 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 调整。

这里采用的是 Tool 自己声明的 `isConcurrencySafe()`，而不是框架根据名称猜测。新 Tool 如果没有显式实现，`buildTool()` 的默认值是 `false`，会按不可并发处理。

这个调度器没有在「全部串行」和「全部 `Promise.all()`」之间二选一，而是保留模型给出的顺序，把相邻的并发安全 Tool 合成一批。这是一种保守优化：能确认安全的地方才并发，不确定时默认串行。

还有一个容易忽略的细节：并发 Tool 返回的 `contextModifier` 不会在完成的瞬间立即修改共享上下文。代码先按 `toolUseID` 收集它们，等整批执行完，再按原始 `blocks` 顺序依次应用。因此「工作可以并发」，但「共享状态怎样变化」仍然是确定的，不会取决于哪个 Promise 先返回。

## 流式 Tool 执行：只优化时机，不改变规则

上一小节讲的是普通路径：`queryLoop()` 先等模型流全部结束，收集本轮所有 Tool Use，再调用 `runTools()`；`runTools()` 选择串行或并发调度，最后为每个 Tool Use 调用 `runToolUse()`。

源码位置：`src/query.ts:562-568`、`src/query.ts:650-862`、`src/query.ts:1380-1384`

```javascript
async function* queryLoop(/* ... */) {
  const allToolUseBlocks = []

  let streamingToolExecutor =
    useStreamingToolExecution
      ? new StreamingToolExecutor(
          toolUseContext.options.tools,
          canUseTool,
          toolUseContext,
        )
      : null

  for await (const message of callModel(/* ... */)) {
    if (message.type !== 'assistant') {
      continue
    }

    const messageToolUseBlocks = message.message.content.filter(
      block => block.type === 'tool_use',
    )
    allToolUseBlocks.push(...messageToolUseBlocks)

    if (streamingToolExecutor) {
      // 流式路径：一个完整 Tool Use 到达后立即入队，
      // 不再等待模型的其他内容块。
      for (const block of messageToolUseBlocks) {
        streamingToolExecutor.addTool(block, message)
      }

      // 模型还在输出时，顺手取走已经完成的结果。
      for (
        const result of
          streamingToolExecutor.getCompletedResults()
      ) {
        if (result.message) {
          yield result.message
        }
      }
    }
  }

  const toolUpdates = streamingToolExecutor
    // 流式路径：Tool 已经在前面的模型循环中启动，
    // 这里只等待尚未结束的 Tool 收尾。
    ? streamingToolExecutor.getRemainingResults()
    // 普通路径：到这里才开始调度本轮所有 Tool。
    : runTools(
        allToolUseBlocks,
        assistantMessages,
        canUseTool,
        toolUseContext,
      )

  // 后续统一消费 toolUpdates……
}
```

接下来要看的就是上面的流式分支：`addTool()` 怎样把 Tool 放进队列、`processQueue()` 怎样决定何时启动，以及它最终怎样复用同一个 `runToolUse()`。

![图 3：普通调度与流式 Tool 调度的时间差](https://windliangblog.oss-cn-beijing.aliyuncs.com/diagram-03.png)

源码位置：`src/services/tools/StreamingToolExecutor.ts:34-150`

执行器为每个 Tool 保存四种状态：

```javascript
type ToolStatus =
  | 'queued'
  | 'executing'
  | 'completed'
  | 'yielded'
```

`addTool()` 会完成第一次调度判断：

```javascript
class StreamingToolExecutor {
  addTool(block, assistantMessage) {
    const toolDefinition =
      findToolByName(
        this.toolDefinitions,
        block.name,
      )
    // 本文 => GrepTool

    const parsedInput =
      toolDefinition.inputSchema.safeParse(
        block.input,
      )
    // => {
    //      success: true,
    //      data: {
    //        pattern: 'login|auth',
    //        path: 'src/remote',
    //      },
    //    }

    const isConcurrencySafe =
      parsedInput.success
        ? toolDefinition.isConcurrencySafe(
            parsedInput.data,
          )
        : false
    // => true

    this.tools.push({
      id: block.id,
      block,
      assistantMessage,
      status: 'queued',
      isConcurrencySafe,
      pendingProgress: [],
    })

    void this.processQueue()
  }
}
```

`processQueue()` 仍然遵守同一条并发规则：

源码位置：`src/services/tools/StreamingToolExecutor.ts:126-150`、`src/services/tools/StreamingToolExecutor.ts:263-404`

```javascript
class StreamingToolExecutor {
  private canExecuteTool(isConcurrencySafe) {
    const executingTools = this.tools.filter(
      tool => tool.status === 'executing',
    )

    // 当前没有 Tool 在运行，可以启动；
    // 或者当前 Tool 和正在运行的 Tool 全都允许并发。
    return (
      executingTools.length === 0 ||
      (
        isConcurrencySafe &&
        executingTools.every(
          tool => tool.isConcurrencySafe,
        )
      )
    )
  }

  private async processQueue() {
    // 按 Tool Use 到达顺序扫描队列。
    for (const tool of this.tools) {
      if (tool.status !== 'queued') {
        continue
      }

      if (this.canExecuteTool(tool.isConcurrencySafe)) {
        // executeTool() 会把状态改成 executing，
        // 并在内部启动 runToolUse()。
        await this.executeTool(tool)
      } else if (!tool.isConcurrencySafe) {
        // 不可并发 Tool 还不能启动时立即停下，
        // 后面的 Tool 不能越过它提前执行。
        break
      }
    }
  }

  private async executeTool(tool) {
    tool.status = 'executing'

    const messages = []
    const contextModifiers = []

    const collectResults = async () => {
      const toolAbortController =
        createChildAbortController(
          this.siblingAbortController,
        )

      const generator = runToolUse(
        tool.block,
        tool.assistantMessage,
        this.canUseTool,
        {
          ...this.toolUseContext,
          abortController: toolAbortController,
        },
      )

      for await (const update of generator) {
        if (update.message?.type === 'progress') {
          tool.pendingProgress.push(update.message)
        } else if (update.message) {
          messages.push(update.message)
        }

        if (update.contextModifier) {
          contextModifiers.push(
            update.contextModifier.modifyContext,
          )
        }
      }

      tool.results = messages
      tool.contextModifiers = contextModifiers
      tool.status = 'completed'
    }

    // 不在这里等待执行完成，否则安全 Tool 之间无法并发。
    tool.promise = collectResults()

    // 一个 Tool 结束后再次扫描，启动刚刚被阻塞的 Tool。
    void tool.promise.finally(() => {
      void this.processQueue()
    })
  }
}
```

所以 `processQueue()` 本身不执行 Tool 的业务逻辑。它只决定哪个 `queued` Tool 现在可以启动；`executeTool()` 才把状态改成 `executing`，并调用统一入口 `runToolUse()`。

至此，两条路径已经完整对上：普通调度由 `queryLoop()` 调用 `runTools()`，再通过串行或并发函数进入 `runToolUse()`；流式调度由 `queryLoop()` 调用 `addTool()`，经过 `processQueue()` 和 `executeTool()` 后进入同一个 `runToolUse()`。

流式执行并没有在参数还是半截 JSON 时启动 Tool。上一篇已经看到，只有 `content_block_stop` 才会生成正式的 Tool Use `AssistantMessage`；`queryLoop()` 收到这条完整消息后才调用 `addTool()`。

**流式 Tool 执行优化的是等待时间，不是执行规则。** 它把「等整条模型流结束」改成「等当前 Tool Use 完整」，但后面仍然复用 `runToolUse()`。这样性能优化不会悄悄绕过权限或改变 Tool Result 格式。

## 实时返回与最终收尾是两种语义

源码位置：`src/services/tools/StreamingToolExecutor.ts:407-490`

模型仍在返回后续内容块时，`queryLoop()` 会调用非阻塞的：

```javascript
streamingToolExecutor.getCompletedResults()
```

它只拿走已经完成的 Tool 和当前 Progress Message，不会停下来等待仍在执行的 Tool。

模型流结束后，`queryLoop()` 改用：

```javascript
streamingToolExecutor.getRemainingResults()
```

这个函数会等待队列中的 Tool 收尾：

```javascript
async *getRemainingResults() {
  if (this.discarded) {
    return
  }

  while (this.hasUnfinishedTools()) {
    await this.processQueue()

    for (
      const result of
        this.getCompletedResults()
    ) {
      yield result
    }

    if (
      this.hasExecutingTools() &&
      !this.hasCompletedResults() &&
      !this.hasPendingProgress()
    ) {
      const executingPromises =
        this.tools
          .filter(
            tool =>
              tool.status === 'executing' &&
              tool.promise,
          )
          .map(tool => tool.promise)

      const progressPromise =
        new Promise(resolve => {
          this.progressAvailableResolve =
            resolve
        })

      if (executingPromises.length > 0) {
        await Promise.race([
          ...executingPromises,
          progressPromise,
        ])
      }
    }
  }

  for (
    const result of
      this.getCompletedResults()
  ) {
    yield result
  }
}
```

两者对应两个时机：

| 函数 | 是否等待 | 使用时机 |
| --- | --- | --- |
| `getCompletedResults()` | 否 | 模型还在流式返回，顺手取走已完成结果 |
| `getRemainingResults()` | 是 | 模型流已经结束，等待 Tool 队列完全收尾 |

这也解释了后面的用户中断分支为什么调用 `getRemainingResults()`：它不是重新执行全部 Tool，而是让执行器把已经开始的队列收成完整结果。

拆成两个方法，是因为「实时返回已完成内容」和「离开前确保队列收尾」是两种不同的语义。如果只有一个会等待全部结果的方法，模型流每到一条消息都可能被 Tool 阻塞；如果只有非阻塞读取，结束时又容易遗漏仍在执行的结果。

## 中断时仍要生成结果：协议完整性优先

前面走的是正常路径：`queryLoop()` 收到完整 Tool Use 后，把它交给普通调度器或流式执行器。模型流消费结束、准备进入正常收尾时，`queryLoop()` 还会先检查用户是否已经中断本轮请求。

先看上层分支，后面的两条收尾路径都从这里进入。

源码位置：`src/query.ts:1011-1051`

```javascript
async function* queryLoop(/* ... */) {
  // 前面已经消费完模型流。
  // 此时 assistantMessages 里可能已经有完整的 Tool Use。
  // ...

  if (toolUseContext.abortController.signal.aborted) {
    if (streamingToolExecutor) {
      // 路径一：Tool 已经进入流式执行器。
      // 等待执行器交回已完成结果，并为被中断的 Tool 生成错误结果。
      for await (
        const update of
          streamingToolExecutor.getRemainingResults()
      ) {
        if (update.message) {
          yield update.message
        }
      }
    } else {
      // 路径二：Tool 尚未进入执行器。
      // 直接为已经出现的 Tool Use 补错误 Tool Result。
      yield* yieldMissingToolResultBlocks(
        assistantMessages,
        'Interrupted by user',
      )
    }

    return {
      reason: 'aborted_streaming',
    }
  }

  // 没有中断，才继续正常调度 Tool。
  // ...
}
```

这里的选择条件不是「Tool 成功还是失败」，而是「当前有没有 `streamingToolExecutor`」。两条路径都在处理同一个问题：模型已经产生 Tool Use，但用户在 Tool 流程收尾前中断了。

Tool Use 与 Tool Result 是成对协议。假设模型已经生成：

```javascript
{
  type: 'tool_use',
  id: 'toolu_01',
  name: 'Grep',
  input: {
    pattern: 'login|auth',
    path: 'src/remote',
  },
}
```

即使用户此时中断，也不能只留下这一个内容块。

### 没有流式执行器时，调用共享的补全函数

源码位置：`src/query.ts:123-149`

```javascript
function* yieldMissingToolResultBlocks(
  assistantMessages,
  errorMessage,
) {
  for (
    const assistantMessage of
      assistantMessages
  ) {
    const toolUseBlocks =
      assistantMessage.message.content.filter(
        content =>
          content.type === 'tool_use',
      )

    for (const toolUse of toolUseBlocks) {
      yield createUserMessage({
        content: [{
          type: 'tool_result',
          content: errorMessage,
          is_error: true,
          tool_use_id: toolUse.id,
        }],
        toolUseResult: errorMessage,
        sourceToolAssistantUUID:
          assistantMessage.uuid,
      })
    }
  }
}
```

这就是上层 `else` 分支调用的辅助生成器。`yield*` 会把它产生的每条消息继续交给 `queryLoop()` 的调用方。

它放在 `queryLoop()` 外部，是因为源码在三个异常出口复用了它：

- 切换备用模型前，为旧模型已经产生的 Tool Use 补结果；
- 模型调用或运行时代码意外抛错时，补齐已经产生的 Tool Use；
- 用户中断且没有流式执行器时，补齐尚未执行的 Tool Use。

三个调用点分别位于 `src/query.ts:900`、`src/query.ts:984` 和 `src/query.ts:1025`。当前这一节跟踪的是第三个调用点；前两个调用点传入的错误文案不同，但补全方式相同。

在这个分支里，Tool 尚未进入执行器，也没有正常结果。函数遍历本轮 `assistantMessages`，为其中每一个 Tool Use 生成错误 Tool Result：

```javascript
{
  type: 'tool_result',
  tool_use_id: 'toolu_01',
  is_error: true,
  content: 'Interrupted by user',
}
```

函数名中虽然有 `Missing`，实现本身没有再拿一个结果集合逐个比对；它依赖调用位置保证这些 Tool Use 尚未产生正常 Tool Result。

### 使用流式执行器时，由执行器收尾

这对应上层 `if (streamingToolExecutor)` 分支。Tool 可能已经处于 `queued`、`executing` 或 `completed`，所以不能再由 `queryLoop()` 不加区分地补一条错误结果。

`getRemainingResults()` 会消费执行器的收尾结果：已经完成的 Tool 保留真实结果；尚未完成的 Tool 则由 `executeTool()` 在检测到中断后生成带原 ID 的错误结果。

这里的「交回」不是让模型继续下一轮，而是在 `queryLoop()` 返回 `aborted_streaming` 之前，把本轮已经发生的事实收完整：

- Tool 在用户中断前已经执行完成：保留真实结果，因为对应的读取、修改或命令确实已经发生；
- Tool 尚未完成并被中断：生成错误 Tool Result，明确记录它没有正常完成。

例如，模型同时调用 `Grep` 和 `Bash`。用户按下中断键时，`Grep` 已经完成，`Bash` 仍在执行，那么收尾结果大致是：

```javascript
[
  {
    type: 'tool_result',
    tool_use_id: 'toolu_grep_01',
    content: 'Found 1 file\nsrc/login.ts',
  },
  {
    type: 'tool_result',
    tool_use_id: 'toolu_bash_01',
    is_error: true,
    content:
      "The user doesn't want to proceed with this tool use. " +
      'The tool use was rejected (eg. if it was a file edit, ' +
      'the new_string was NOT written to the file). ' +
      'STOP what you are doing ' +
      'and wait for the user to tell you how to proceed.',
  },
]

// 上面的结果交给调用方后，本轮直接结束：
// return { reason: 'aborted_streaming' }
```

如果把已经完成的 `Grep` 也改成「被中断」，会丢失真实执行状态；如果完全不交回结果，又会留下只有 Tool Use、没有 Tool Result 的不完整消息。

两条路径的共同目标不是强行完成 Tool，而是保证已经出现的 Tool Use 都有明确结果：成功、失败或被中断。

这里优先保护的是协议完整性，而不是「每个 Tool 必须执行成功」。一条 Tool Use 如果没有对应结果，后续代码无法区分它是仍在执行、执行失败，还是消息丢失。显式补一条带原 ID 的错误结果，状态机才能收敛到确定状态。

## 流式 Fallback：清理内部状态不等于回滚副作用

上一小节处理的是「用户主动中断」。第二个异常出口仍在 `queryLoop()` 中，但触发原因变成了「流式模型请求失败，`callModel()` 改用非流式请求」。

`queryLoop()` 把 `onStreamingFallback` 回调传给 `callModel()`。Fallback 发生时，回调先把 `streamingFallbackOccured` 设为 `true`；当非流式请求的新消息返回到同一个 `for await` 时，循环先清理旧流留下的状态，再处理新消息。

源码位置：`src/query.ts:709-740`、`src/services/tools/StreamingToolExecutor.ts:64-71`

```javascript
async function* queryLoop(/* ... */) {
  let streamingFallbackOccured = false

  for await (
    const message of deps.callModel({
      // ...
      options: {
        // ...
        onStreamingFallback: () => {
          streamingFallbackOccured = true
        },
      },
    })
  ) {
    if (streamingFallbackOccured) {
      for (const oldMessage of assistantMessages) {
        yield {
          type: 'tombstone',
          message: oldMessage,
        }
      }

      assistantMessages.length = 0
      toolResults.length = 0
      toolUseBlocks.length = 0
      needsFollowUp = false

      if (streamingToolExecutor) {
        streamingToolExecutor.discard()

        streamingToolExecutor =
          new StreamingToolExecutor(
            toolUseContext.options.tools,
            canUseTool,
            toolUseContext,
          )
      }
    }

    // 从这里开始，只处理 Fallback 后返回的新 message。
    // ...
  }
}
```

这里同时清理两条旧路径：

- Tombstone 让上层移除旧流已经展示或保存的 AssistantMessage；
- `discard()` 让旧执行器不再产出旧 Tool Use 对应的结果。

然后新的非流式回答使用一个全新的执行器继续处理。这样不会把旧 `tool_use.id` 的结果混进新回答。

`discard()` 发生时，三种 Tool 状态的处理并不相同：

- 尚在排队：后续不会再调用 `tool.call()`；
- 正在执行：`discard()` 不会撤销已经发出的文件操作或 Shell 命令，旧执行器只是不再向正式会话提交结果；
- 已经完成：执行产生的副作用保留，但旧 Tool Result 会被丢弃。

因此，Tool 如果已经修改文件或执行命令，当前实现不会自动回滚，也没有补偿操作。新的非流式请求如果再次返回同一个 Tool Use，确实存在重复执行的风险。

源码为此提供了 `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` 和 Feature Flag。开关启用后，流式请求出错会直接向上抛出，不再改用非流式请求，从而避免同一个 Tool 被第二次执行。这里采用的是整体关闭 Fallback，并没有动态判断某个 Tool 是否已经产生副作用。

Tombstone 和 `discard()` 解决的是旧消息、旧队列不能混进新回答的问题，不是事务回滚。

## Tool 失败：把异常变成可继续处理的数据

前两节都是 `queryLoop()` 层面的异常出口：用户中断整轮请求，或模型请求发生 Fallback。还有一类更局部的错误，发生在单个 Tool 的执行流水线中。

这类错误仍沿用前面已经讲过的调用链：

```javascript
runTools()
// 或 StreamingToolExecutor
  -> runToolUse()
    -> streamedCheckPermissionsAndCallTool()
      -> checkPermissionsAndCallTool()
        -> tool.call()
```

因此这里不再引入新的上层入口。沿着 `runToolUse()` 进入内部校验和执行函数，下面这些失败最终都会变成 Tool Result：

| 失败位置 | 是否执行 `tool.call()` | 返回给下一轮的核心内容 |
| --- | --- | --- |
| 找不到 Tool | 否 | `No such tool available` |
| Schema 校验失败 | 否 | `InputValidationError` |
| `validateInput()` 失败 | 否 | Tool 自己生成的语义错误 |
| Hook 阻止 | 否 | Hook 的停止原因 |
| 权限拒绝 | 否 | 拒绝原因 |
| `tool.call()` 抛错 | 已尝试 | `Error calling tool` |
| 用户中断 | 视中断时机而定 | `Interrupted by user` 或执行器生成的中断结果 |

它们都保留原来的：

```javascript
tool_result.tool_use_id
// => tool_use.id
```

对主循环而言，Tool 执行失败不等于进程崩溃。普通的 Tool 失败会成为一条结构化消息，模型可以在下一轮调整参数、换用其他 Tool，或者向用户说明无法继续；如果用户主动中断，本轮会直接结束，但错误 Tool Result 仍会保留下来，保证消息协议完整。

这里并不是隐藏错误，而是把异常统一转换成 Tool 协议中的失败值。框架层可以继续保持消息顺序和 ID 对应，模型层也能根据错误内容决定下一步。这比让不同 Tool 把各种异常直接泄漏给主循环更容易组合。

## 把普通函数或 API 封装成 Agent Tool

前面沿着 `GrepTool` 看完了一个 Tool 从参数定义到结果返回的完整过程。

如果要自己编写 Tool，把普通函数或 API 接入 Agent，也需要完成同样几件事：定义模型可以传入的参数、执行实际操作、整理返回结果，并声明权限和并发规则。

下面把这套结构应用到一个常见的业务接口。假设项目管理系统提供了搜索工单的 HTTP API：

```javascript
// GET /v1/issues
//   ?query=login
//   &state=open
//   &page=1
//   &pageSize=20
```

把它封装成 Tool，不是把 URL、HTTP 方法、鉴权 Token 和全部分页参数都交给模型。模型关心的是「搜索什么工单」，而不是这个 API 怎样传输数据。

一个简化后的 Tool 可以设计成：

```javascript
const searchIssuesInput = z.strictObject({
  query: z.string().min(1),
  state: z
    .enum(['open', 'closed', 'all'])
    .optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional(),
})

const SearchIssuesTool = buildTool({
  name: 'SearchIssues',
  strict: true,
  maxResultSizeChars: 10_000,

  get inputSchema() {
    return searchIssuesInput
  },

  async prompt() {
    return (
      '按关键词搜索项目工单。' +
      '适合查找与某个功能或故障相关的工单。'
    )
  },

  isReadOnly() {
    return true
  },

  isConcurrencySafe() {
    return true
  },

  async validateInput({ query }) {
    if (query.trim().length < 2) {
      return {
        result: false,
        message: '搜索关键词至少需要 2 个字符',
      }
    }

    return { result: true }
  },

  // 本例没有专属权限规则。
  // buildTool() 默认返回 allow，
  // PreToolUse Hook 等公共流程仍由 runToolUse() 统一执行。

  async call(
    {
      query,
      state = 'open',
      limit = 10,
    },
    { abortController },
  ) {
    const response = await issueApi.search(
      {
        query,
        state,
        page: 1,
        pageSize: limit,
      },
      {
        signal: abortController.signal,
      },
    )

    return {
      data: {
        issues: response.items.map(issue => ({
          id: issue.id,
          title: issue.title,
          state: issue.state,
        })),
        hasMore: response.hasMore,
      },
    }
  },

  mapToolResultToToolResultBlockParam(
    data,
    toolUseID,
  ) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: JSON.stringify(data),
    }
  },

  // UI 展示字段……
})
```

这个封装做了几次转换：

| 外部 API 细节 | Tool 怎样处理 |
| --- | --- |
| URL、HTTP 方法、鉴权 Token | 留在 `issueApi` 内部，不让模型生成 |
| `page`、`pageSize` | 对模型只暴露有业务含义的 `limit` |
| 任意查询参数 | 用严格 Schema 收敛为 `query`、`state`、`limit` |
| 原始响应对象 | 只保留模型后续判断需要的字段 |
| 长时间 HTTP 请求 | 传入 `abortController.signal`，允许用户中断 |
| 执行结果 | 转成带原 `toolUseID` 的 Tool Result |

从这个例子可以提炼出一个简单标准：**好的 Tool 是 Agent 面向业务的能力接口，不是外部 API 的透传层。**

封装时可以按下面的顺序检查：

1. **先定义一个清楚动作。** `SearchIssues` 只搜索工单，不要变成既能搜索、又能创建、还能删除的万能 Tool。
2. **输入使用业务语言。** 隐藏 Token、URL、分页游标和重试次数等传输细节。
3. **把模型输入当成不可信数据。** Schema 检查结构，`validateInput()` 检查业务语义，副作用发生前再经过权限系统。
4. **如实声明行为性质。** 搜索是只读操作；只有当多次搜索之间没有共享状态冲突，并且 API 允许并发请求时，才应把 `isConcurrencySafe()` 设为 `true`。创建、修改或删除数据的 Tool 通常需要更严格的权限和调度策略。
5. **为中断和输出预算留接口。** 把 `AbortSignal` 传给底层请求，并限制结果条数和文本大小。
6. **返回模型能继续使用的信息。** 保留标识、状态和关键摘要，不要把几百个字段的原始响应全部塞进上下文。

## 小结

本文从下面这条模型输出开始：

```javascript
{
  type: 'tool_use',
  id: 'toolu_01',
  name: 'Grep',
  input: {
    pattern: 'login|auth',
    path: 'src/remote',
  },
}
```

最后得到：

```javascript
{
  type: 'tool_result',
  tool_use_id: 'toolu_01',
  content:
    'Found 2 files\n' +
    'src/remote/SessionsWebSocket.ts\n' +
    'src/remote/sdkMessageAdapter.ts',
}
```

中间经过的主链是：

```javascript
queryLoop()
  -> runTools()
     或 StreamingToolExecutor
  -> runToolUse()
  -> inputSchema.safeParse()
  -> validateInput()
  -> PreToolUse Hook
  -> 权限判断
  -> tool.call()
  -> mapToolResultToToolResultBlockParam()
  -> toolResults
  -> next.messages
```

走完这条链，值得带走的不是函数名，而是下面几个设计：

- **协议单一来源：** 同一份 `inputSchema` 既描述给模型，也保护本地执行入口；
- **校验分层：** Schema 检查结构，`validateInput()` 检查业务语义，Hook 和权限再根据当前会话决定是否放行；
- **调度与执行分离：** 普通调度和流式调度只决定何时开始，真正执行都经过 `runToolUse()`；
- **保守并发：** Tool 自己声明并发安全性，不确定时默认串行，并发任务对共享上下文的修改仍按原顺序提交；
- **内部数据与 API 协议分离：** `tool.call()` 返回内部结果，映射函数再负责加上 `tool_use_id` 并转成 Tool Result；
- **Tool 不是 API 透传层：** 对模型暴露业务动作，把鉴权、传输、分页和原始响应留在实现内部；
- **失败也是协议的一部分：** 调用失败或被中断时，仍为已经出现的 Tool Use 生成同 ID 的结果，不把主循环留在半截状态。

这些都不是 Agent 独有的神秘算法。平常业务开发中，API 参数校验、权限中间件、任务队列、并发控制和失败收尾同样需要考虑。Agent 的特殊之处是输入由模型生成，一个任务可能连续调用多个 Tool，`Edit` 和 `Bash` 还会对外部世界产生副作用。这使得原本分散在各层的工程问题，都集中到了一次 Tool 调用周围。

> 系列文更新中：[cc.windliang.wang](https://cc.windliang.wang/)
