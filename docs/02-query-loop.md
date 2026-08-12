---
title: 2、CC 的心脏：queryLoop Agent 主循环
---

上一篇最后停在 `launchRepl()` 和 `runHeadless()`：一次会话已经准备好了，模型、权限、Tools、Skills、Agents 和 MCP 也已经装进了运行环境。

这篇文章讲一个最核心的问题：假设用户只输入「检查登录模块」，Claude Code 为什么会自己搜索文件、读取源码，最后再给出答案？

答案就在 `src/query.ts` 的 `queryLoop()` 中。

它做的事情其实很朴素：

1. 把当前消息发给模型；
2. 模型如果要求调用 Tool，Claude Code 就执行 Tool；
3. 把 Tool Result 放进消息，再次请求模型；
4. 模型不再调用 Tool 时，结束循环。

![一次输入触发三轮模型请求](https://windliangblog.oss-cn-beijing.aliyuncs.com/02-query-loop-diagram-02.png)

图里的 `messages` 会逐轮累积，不是每轮重新创建一份只有新结果的消息：

```javascript
turnCount = 1
// messages.length => 1
// [用户问题]

turnCount = 2
// messages.length => 3
// [用户问题, Grep tool_use, Grep tool_result]

turnCount = 3
// messages.length => 5
// [用户问题,
//  Grep tool_use, Grep tool_result,
//  Read tool_use, Read tool_result]
```

这里最关键的一点是：

> 模型只会生成「我要调用 `Grep`」这样的 `tool_use`。真正搜索文件的是 Claude Code 进程，不是模型。

因此，一次用户输入不等于一次模型请求。

本文的例子中，用户只输入了一句话，但 `queryLoop()` 请求了三次模型。前两次模型要求使用 Tool，第三次才产生最终答案。

主循环可以精简成下面的伪代码：

```javascript
// 等价简版，用于理解主线，不是源码原文
async function* simplifiedQueryLoop(state) {
  while (true) {
    // 1. 用当前 messages 请求模型
    const assistantMessages = []

    for await (
      const message of callModel(state.messages)
    ) {
      yield message

      if (message.type === 'assistant') {
        assistantMessages.push(message)
      }
    }

    // 2. 找出模型真正返回的 Tool Use
    const toolUseBlocks =
      findToolUseBlocks(assistantMessages)

    // 3. 没有 Tool Use，任务结束
    if (toolUseBlocks.length === 0) {
      return {
        reason: 'completed',
      }
    }

    // 4. 执行 Tool，逐个收集 Tool Result
    const toolResults = []

    for await (
      const update of runTools(toolUseBlocks)
    ) {
      if (update.message) {
        toolResults.push(update.message)
      }
    }

    // 5. 把模型消息和 Tool Result 交给下一轮
    state = {
      ...state,
      messages: [
        ...state.messages,
        ...assistantMessages,
        ...toolResults,
      ],
      turnCount: state.turnCount + 1,
    }
  }
}
```

后面的大部分源码，都是在给这五步增加生产环境需要的能力，例如权限检查、流式输出、上下文压缩、Fallback、Hook 和中止处理。这一篇只看主循环，其他机制后面再展开。

这篇文章专注于主循环的流程，主要是三点：

1. 模型怎样产生 `tool_use`；
2. Claude Code 怎样执行 Tool 并生成 `tool_result`；
3. 新消息怎样进入下一轮，循环最后怎样结束。

## 循环入口

交互模式下，REPL 会把第一篇组装好的消息、Prompt 和 `ToolUseContext` 传给 `query()`：

```javascript
// src/screens/REPL.tsx:2793-2803
for await (
  const event of query({
    messages: messagesIncludingNewMessages,
    // => [{
    //   type: 'user',
    //   message: {
    //     role: 'user',
    //     content: '检查登录模块',
    //   },
    // }]

    systemPrompt,
    userContext,
    systemContext,
    canUseTool,

    toolUseContext,
    // => {
    //   options: {
    //     mainLoopModel: 'claude-sonnet-4-6',
    //     tools: [
    //       { name: 'Read', ... },
    //       { name: 'Edit', ... },
    //       { name: 'Grep', ... },
    //       { name: 'Glob', ... },
    //       { name: 'Bash', ... },
    //     ],
    //     commands: [...],
    //     thinkingConfig: { type: 'adaptive' },
    //   },
    //   abortController: AbortController,
    //   getAppState: () => AppState,
    //   setAppState: function,
    // }
    // 其中 getAppState().toolPermissionContext.mode => 'plan'

    querySource: getQuerySourceForREPL(),
    // => 'repl_main_thread'
  })
) {
  onQueryEvent(event)
}
```

`onQueryEvent(event)` 只负责把 `query()` 产生的事件更新到终端界面，例如显示流式文本或追加完整消息。它不调用模型、不执行 Tool，也不决定循环是否继续，因此这里不再展开。

看一下 `query()`，源码位置：`src/query.ts:219-239`

REPL、Print 或 SDK 最终会消费 `query()` 产生的事件。`query()` 本身很短：

```javascript
export async function* query(params) {
  const consumedCommandUuids = []

  const terminal =
    yield* queryLoop(params, consumedCommandUuids)

  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }

  return terminal
}
```

两个函数的分工如下：

| 函数          | 作用                                               |
| ------------- | -------------------------------------------------- |
| `query()`     | 包住一次查询的生命周期，并在 `queryLoop()` 返回后完成命令清理 |
| `queryLoop()` | 调模型、执行 Tool、更新状态并决定继续或结束        |

`yield*` 在这里同时做两件事：

1. `queryLoop()` 每次 `yield` 出来的模型文本、Tool Use 和 Tool Result，继续向上传给 REPL 或 SDK；
2. `queryLoop()` 最后 `return` 的结束原因，保存到 `terminal`。

接着看 `queryLoop()`，源码位置：`src/query.ts:241-321`

`query()` 执行 `yield* queryLoop(...)` 后，控制权就进入了 `queryLoop()`。这个函数先创建 `state`，然后才进入 `while (true)`：

```javascript
async function* queryLoop(params) {
  let state = {
    messages: params.messages,
    // => [{
    //   type: 'user',
    //   message: {
    //     role: 'user',
    //     content: '检查登录模块',
    //   },
    // }]

    toolUseContext: params.toolUseContext,
    // => 包含模型、Tools、权限状态和 abortController

    maxOutputTokensOverride:
      params.maxOutputTokensOverride,
    // 重试时临时提高模型输出上限

    autoCompactTracking: undefined,
    // 记录自动压缩后又运行了多少轮

    stopHookActive: undefined,
    // 标记当前是否由 Stop Hook 触发续行

    maxOutputTokensRecoveryCount: 0,
    // 限制输出截断后的自动续写次数

    hasAttemptedReactiveCompact: false,
    // 防止上下文溢出后反复压缩

    turnCount: 1,
    // => 当前是第 1 轮循环

    pendingToolUseSummary: undefined,
    // 保存后台生成的 Tool 摘要

    transition: undefined,
    // 记录上一轮为什么继续
    // => 第一轮还没有发生状态转换
  }

  while (true) {
    const {
      messages,
      turnCount,
    } = state

    // 整理消息、调用模型、执行 Tool……
  }
}
```

这里才第一次正式进入 `while (true)`。第一轮使用上面刚创建的 `state`；如果模型调用了 Tool，循环底部会把 AssistantMessage 和 Tool Result 写入新的 `state`。代码运行到 `while` 底部后，自然回到顶部开始下一轮，这条正常路径没有显式执行 `continue`。

接下来看 `while (true)` 内部具体发生了什么：

## 第一轮：把「想查什么」变成「查到了什么」

第一轮开始时只有用户问题；结束时新增一条包含 `tool_use` 的 AssistantMessage 和一条包含 `tool_result` 的 UserMessage。

源码位置：`src/query.ts:307`、`src/query.ts:650-845`、`src/query.ts:1360-1409`、`src/query.ts:1704-1728`

下面先按非流式 Tool 执行分支，省略错误恢复、压缩和 Hook，只看三步的嵌套关系：

```javascript
while (true) {
  const messagesForQuery = [
    ...getMessagesAfterCompactBoundary(
      state.messages,
    ),
  ]
  // => [{
  //   type: 'user',
  //   message: {
  //     role: 'user',
  //     content: '检查登录模块',
  //   },
  // }]

  const assistantMessages = []
  const toolUseBlocks = []
  const toolResults = []
  let needsFollowUp = false

  // 第一步：调用模型，开始消费这一次模型请求的输出流
  for await (
    const message of deps.callModel({
      messages: prependUserContext(
        messagesForQuery,
        userContext,
      ),
      systemPrompt: fullSystemPrompt,
      tools: toolUseContext.options.tools,
      // => [{ name: 'Read', ... }, { name: 'Grep', ... }, ...]

      options: {
        model: currentModel,
        // => 'claude-sonnet-4-6'
      },
      // 其他请求参数……
    })
  ) {
    yield message

    // 第二步：仍在 for await 内
    // 每拿到一条 message，就检查其中有没有 tool_use
    if (message.type === 'assistant') {
      assistantMessages.push(message)

      const blocks = message.message.content.filter(
        content => content.type === 'tool_use',
      )
      // 本轮模型决定搜索代码时：
      // => [{
      //   type: 'tool_use',
      //   id: 'toolu_01',
      //   name: 'Grep',
      //   input: {
      //     pattern: 'login|auth',
      //     // 在文件内容中匹配 login 或 auth
      //
      //     path: 'src',
      //     // 只搜索 src 目录
      //
      //     output_mode: 'files_with_matches',
      //     // 只返回匹配到的文件路径，不返回文件内容
      //   },
      // }]

      toolUseBlocks.push(...blocks)

      if (blocks.length > 0) {
        needsFollowUp = true
      }
    }
  } // 模型输出流到这里已经全部结束

  if (!needsFollowUp) {
    // 没有 tool_use：进入恢复和结束检查
    // 中间的恢复分支省略；正常情况最终返回：
    return { reason: 'completed' }
  }

  // 第三步：在 for await 外面
  // 只有发现 tool_use 才会执行 Tool
  // 这里的 Grep Tool 底层使用 ripgrep：
  // 在 src 中搜索内容匹配 login|auth 的文件。
  const toolUpdates = runTools(
    toolUseBlocks,
    // => [{ id: 'toolu_01', name: 'Grep', ... }]

    assistantMessages,
    canUseTool,
    toolUseContext,
  )

  for await (const update of toolUpdates) {
    if (update.message) {
      // runTools() 已经执行完 Grep。
      // normalizeMessagesForAPI() 不执行 Tool，
      // 只把结果整理成下一次模型请求需要的消息格式。
      toolResults.push(
        ...normalizeMessagesForAPI(
          [update.message],
          toolUseContext.options.tools,
        ).filter(message => message.type === 'user'),
      )
      // => [{
      //   type: 'user',
      //   message: {
      //     role: 'user',
      //     content: [{
      //       type: 'tool_result',
      //       tool_use_id: 'toolu_01',
      //       content: 'Found 1 file\nsrc/auth/login.ts',
      //     }],
      //   },
      // }]
    }
  }

  state = {
    ...state,
    messages: [
      ...messagesForQuery,
      ...assistantMessages,
      ...toolResults,
    ],
    // => 原问题
    //  + assistant 的 tool_use
    //  + user 的 tool_result

    turnCount: state.turnCount + 1,
    // 1 + 1 => 2

    transition: {
      reason: 'next_turn',
    },
  }

  // 到达 while 底部，开始下一轮
}
```

这里只需要知道：相同的 `id` 和 `tool_use_id` 表示「这是那次 Tool 调用的结果」。具体生成和异常修复后续再讲。

## 第二轮：不是新流程，而是同一个 `while` 再跑一次

下面省略第一轮已经讲过的参数和异常分支，只保留第二轮发生变化的值：

```javascript
while (true) {
  const {
    messages,
    turnCount,
  } = state

  // 第二轮刚开始
  // turnCount => 2
  // messages.length => 3
  // messages 中依次是：
  // 1. 用户输入「检查登录模块」
  // 2. 模型请求执行 Grep
  // 3. Grep 返回「src/auth/login.ts」

  const messagesForQuery = [
    ...getMessagesAfterCompactBoundary(messages),
  ]

  const assistantMessages = []
  const toolUseBlocks = []
  const toolResults = []

  for await (
    const message of deps.callModel({
      messages: prependUserContext(
        messagesForQuery,
        userContext,
      ),
      // => 这次发给模型的是上面的 3 条消息
      // 模型已经知道 Grep 找到了 src/auth/login.ts，
      // 但还没看到文件内容。

      // 其他参数……
    })
  ) {
    if (message.type === 'assistant') {
      const blocks = message.message.content.filter(
        block => block.type === 'tool_use',
      )
      // blocks => [{
      //   type: 'tool_use',
      //   id: 'toolu_02',
      //   name: 'Read',
      //   input: {
      //     file_path: 'src/auth/login.ts',
      //   },
      // }]

      toolUseBlocks.push(...blocks)
      assistantMessages.push(message)
    }
  }

  const toolUpdates = runTools(
    toolUseBlocks,
    assistantMessages,
    canUseTool,
    toolUseContext,
    // 其他参数……
  )
  // runTools() 此时真正执行 Read：
  // 打开 src/auth/login.ts，读取文件内容。

  for await (const update of toolUpdates) {
    if (update.message) {
      toolResults.push(
        ...normalizeMessagesForAPI(
          [update.message],
          toolUseContext.options.tools,
        ).filter(message => message.type === 'user'),
      )
      // toolResults => [{
      //   type: 'user',
      //   message: {
      //     role: 'user',
      //     content: [{
      //       type: 'tool_result',
      //       tool_use_id: 'toolu_02',
      //       content: 'export async function login(...) {\n  ...\n}',
      //     }],
      //   },
      // }]
    }
  }

  state = {
    ...state,
    messages: [
      ...messagesForQuery,  // 原来的 3 条
      ...assistantMessages, // 新增 Read Tool Use
      ...toolResults,       // 新增 Read Tool Result
    ],
    // messages.length => 3 + 1 + 1 => 5

    turnCount: turnCount + 1,
    // 2 + 1 => 3

    transition: {
      reason: 'next_turn',
    },
  }
}
```

这里真正值得注意的不是「第二轮又执行了一个 Tool」，而是源码里没有写死「Grep 后必须 Read」。第二轮把 Grep 的结果重新交给模型，由模型判断下一步需要读取文件，再生成 `Read` Tool Use。

**这也是它和传统程序最大的不同：执行步骤不必全部提前写死，一部分决策交给模型。**

第二轮结束时，模型生成的 Read Tool Use 和读取到的源码都已经进入 `state.messages`。第三次循环拿到这 5 条消息后，就可以基于源码给出结论。

## 第三轮：同一个 `while` 走到结束分支

源码位置：`src/query.ts:558-834`、`src/query.ts:1062-1357`

第三轮仍然执行同一段代码。不同的是，这次模型已经看过 `login.ts` 的源码，不再请求 Tool，而是直接回答。下面使用等价简版，只保留正常路径，省略流式回退和可恢复错误暂缓输出等分支：

```javascript
while (true) {
  const {
    messages,
    stopHookActive,
    turnCount,
  } = state

  // 第三轮刚开始
  // turnCount => 3
  // messages.length => 5
  // 相比第二轮，新增了 Read Tool Use 和 Read Tool Result。

  const messagesForQuery = [
    ...getMessagesAfterCompactBoundary(messages),
  ]

  const assistantMessages = []
  const toolUseBlocks = []
  let needsFollowUp = false

  for await (
    const message of deps.callModel({
      messages: prependUserContext(
        messagesForQuery,
        userContext,
      ),
      // => 5 条消息，最后一条包含 login.ts 的源码

      // 其他参数……
    })
  ) {
    yield message
    // 正常路径下，最终文本立即交给 REPL 或 Print 层显示。

    if (message.type === 'assistant') {
      assistantMessages.push(message)
      // assistantMessages => [{
      //   type: 'assistant',
      //   message: {
      //     role: 'assistant',
      //     content: [{
      //       type: 'text',
      //       text: '登录模块先校验凭证，然后创建会话……',
      //     }],
      //   },
      // }]

      const blocks = message.message.content.filter(
        content => content.type === 'tool_use',
      )
      // blocks => []

      if (blocks.length > 0) {
        toolUseBlocks.push(...blocks)
        needsFollowUp = true
      }
      // blocks.length > 0 => false
      // needsFollowUp 仍然是 false
    }
  }

  if (!needsFollowUp) {
    // => true，因此不会进入后面的 runTools()

    const lastMessage = assistantMessages.at(-1)
    // => 上面的最终文本消息，不是 API 错误

    // 这里还有上下文溢出和输出截断等恢复分支。
    // 本文这次运行没有触发，继续向下执行。

    const stopHookResult = yield* handleStopHooks(
      messagesForQuery,
      assistantMessages,
      systemPrompt,
      userContext,
      systemContext,
      toolUseContext,
      querySource,
      stopHookActive,
    )
    // stopHookResult.preventContinuation => false
    // stopHookResult.blockingErrors => []
    // 因此不会进入 Stop Hook 的中止或续行分支。

    // Token Budget 还可能要求继续。
    // 本文示例也没有触发这条分支。

    return {
      reason: 'completed',
    }
  }

  // 只有 needsFollowUp 为 true，代码才会走到这里执行 Tool。
  const toolUpdates = runTools(/* ... */)
}
```

注意，模型生成的最终文本已经在 `for await` 中被 `yield` 给上层。最后的 `{ reason: 'completed' }` 不是模型答案，而是 `queryLoop()` 返回给 `query()` 的结束状态。

因此，「没有 Tool Use」只表示可以尝试结束。上下文恢复、输出恢复、Stop Hook 和 Token Budget 都放行后，循环才会真正返回 `completed`。

到这里，`queryLoop()` 的正常主线就走完了：

> 它不断把「模型的 Tool Use」变成「真实的 Tool Result」，再把结果交还给模型；当模型不再调用 Tool，并且结束检查全部放行时，返回 `completed`。

再回头看完整流程图，左边的恢复分支暂时可以忽略。

![queryLoop 完整主流程](https://windliangblog.oss-cn-beijing.aliyuncs.com/02-query-loop-diagram-01.png)

## 循环什么时候结束

### 1. 模型不再调用 Tool，正常结束

源码位置：`src/query.ts:554-558`、`src/query.ts:826-835`、`src/query.ts:1062`

`needsFollowUp` 不是模型返回的字段，而是 `queryLoop()` 自己维护的局部变量。每次请求模型前，它先被初始化为 `false`：

```javascript
// src/query.ts:554-558
// stop_reason === 'tool_use' 并不可靠，
// 它不一定每次都被正确设置。
let needsFollowUp = false
```

源码里没有写下面这种判断：

```javascript
if (message.message.stop_reason === 'tool_use') {
  needsFollowUp = true
}
```

实际使用的是 `src/query.ts:826-835`：代码在模型流中检查每一条 AssistantMessage，直接查找其中的 `tool_use` 内容块：

```javascript
// src/query.ts:826-835
const msgToolUseBlocks =
  message.message.content.filter(
    content => content.type === 'tool_use',
  )

if (msgToolUseBlocks.length > 0) {
  toolUseBlocks.push(...msgToolUseBlocks)
  needsFollowUp = true
}
```

第三轮模型只返回文本：

```javascript
msgToolUseBlocks
// => []

needsFollowUp
// => false
```

因为没有进入赋值为 `true` 的分支，`needsFollowUp` 保持初始值 `false`。模型流结束后，代码便进入正常结束判断：

```javascript
if (!needsFollowUp) {
  // needsFollowUp => false
  // 恢复机制和 Stop Hook 均未要求继续

  return {
    reason: 'completed',
  }
}
```

结束检查全部放行后，`return` 会直接跳出 `while (true)`，同时结束 `queryLoop()`。

### 2. 达到调用方设置的 `maxTurns`

源码位置：

- `src/query.ts:252-260`：从 `query()` 传入的参数中取出 `maxTurns`；
- `src/query.ts:1679-1728`：Tool 执行结束后、创建下一轮 `State` 之前检查它。

前面的主框架为了突出 Tool 循环，省略了这段限制代码。把它放回原来的位置，关系如下：

```javascript
async function* queryLoop(params) {
  const {
    maxTurns,
    // 其他参数……
  } = params
  // Print、SDK 或子 Agent 可以传入这个值。
  // 例如：maxTurns => 3

  // ...

  while (true) {
    // 1. 请求模型
    // 2. 收集 Tool Use
    // 3. 执行 Tool，得到 toolResults

    // Tool 已经执行完，准备进入下一轮
    const nextTurnCount = turnCount + 1
    // turnCount => 3
    // nextTurnCount => 4

    if (maxTurns && nextTurnCount > maxTurns) {
      // maxTurns => 3
      // 4 > 3 => true

      yield createAttachmentMessage({
        type: 'max_turns_reached',
        maxTurns,
        turnCount: nextTurnCount,
      })

      return {
        reason: 'max_turns',
        turnCount: nextTurnCount,
      }
    }

    // 没超过上限，才会创建下一轮 State
    const next = {
      messages: [
        ...messagesForQuery,
        ...assistantMessages,
        ...toolResults,
      ],
      turnCount: nextTurnCount,
      // 其他字段……
    }

    state = next
  }
}
```

它检查的不是「当前已经执行了几轮」，而是「是否还允许进入下一轮」。例如 `maxTurns = 3`，当前已经是第 3 轮，模型又请求了 Tool，`nextTurnCount` 就是 `4`，源码会阻止第 4 次模型请求。

但 `maxTurns` 是可选参数。交互模式没有设置它时：

```javascript
maxTurns
// => undefined

if (maxTurns && nextTurnCount > maxTurns) {
  // 不会进入
}
```

因此源码没有为普通 Tool 循环设置一个统一的硬上限。

### 3. 用户或调用方主动中止

`ToolUseContext` 中保存了 `AbortController`。用户在交互界面中按下中断键，或者 SDK 主动取消任务后：

```javascript
toolUseContext.abortController.signal.aborted
// => true
```

模型流或 Tool 执行分支检测到这个值后，会停止当前工作并返回对应的中止原因。

另外，即使模型没有继续调用 Tool，Claude Code 也不一定立即结束：上下文恢复、输出截断恢复或 Stop Hook 仍可能要求进入下一轮。这些机制将在后续文章中展开。

## 小结

Claude Code 的 Agent 主循环可以压缩成下面这段：

```javascript
while (true) {
  const assistantMessages = []

  for await (
    const message of callModel(state.messages)
  ) {
    yield message

    if (message.type === 'assistant') {
      assistantMessages.push(message)
    }
  }

  const toolUseBlocks =
    findToolUseBlocks(assistantMessages)

  if (toolUseBlocks.length === 0) {
    // 生产代码还会执行恢复与 Stop Hook 检查
    return {
      reason: 'completed',
    }
  }

  const toolResults = []

  for await (
    const update of runTools(toolUseBlocks)
  ) {
    if (update.message) {
      toolResults.push(update.message)
    }
  }

  const next = {
    messages: [
      ...state.messages,
      ...assistantMessages,
      ...toolResults,
    ],
    toolUseContext: state.toolUseContext,
    turnCount: state.turnCount + 1,
    transition: {
      reason: 'next_turn',
    },
  }

  state = next
}
```

真正需要记住的是四点：

1. `query()` 调用 `queryLoop()`、透传它产生的事件，并在结束后完成 Command 状态清理；`queryLoop()` 才负责模型与 Tool 的多轮循环；
2. 模型提出 Tool Use，Claude Code 执行后把 Tool Result 放回消息；
3. 没有新的 Tool Use，并且结束检查放行后，循环返回 `completed`；
4. `State` 把消息、工具上下文和轮次一起交给下一轮。

## 附录：看懂 `function*`、`yield` 和 `await`

生成器函数平常用的不多，这里也补充下。

阅读 `query()` 和 `queryLoop()` 时，最容易混淆的是下面几种写法：

```javascript
function* generator() {}
async function asyncFunction() {}
async function* asyncGenerator() {}
```

先记住一句话：

> 普通函数一次返回一个结果；生成器可以暂停多次，每次返回一部分结果。

### 普通函数和 `function*` 有什么区别

普通函数从头执行到 `return`，一次性结束：

```javascript
function getNumbers() {
  return [1, 2, 3]
}

const numbers = getNumbers()
// => [1, 2, 3]
```

函数名旁边多一个 `*`，表示它是生成器函数：

```javascript
function* getNumbers() {
  yield 1
  yield 2
  return 3
}
```

调用生成器函数时，不会立刻执行完整函数，而是先得到一个迭代器：

```javascript
const iterator = getNumbers()

iterator.next()
// => { value: 1, done: false }

iterator.next()
// => { value: 2, done: false }

iterator.next()
// => { value: 3, done: true }
```

每次调用 `next()`，函数都会从上次暂停的位置继续运行：

- `yield 1`：交出 `1`，函数暂停；
- 再次调用 `next()`：从 `yield 1` 后面继续；
- `return 3`：函数彻底结束，`done` 变成 `true`。

所以 `yield` 和 `return` 的区别是：

| 语法 | 作用 |
| --- | --- |
| `yield value` | 交出一个中间结果，但函数还可以继续 |
| `return value` | 交出最终结果，并结束函数 |

### `async function*` 又多了什么

`queryLoop()` 不仅要分多次产生结果，还要等待模型和 Tool，因此它同时需要 `async` 和 `*`：

```javascript
async function* queryLoop() {
  const message = await requestModel()

  yield message

  return {
    reason: 'completed',
  }
}
```

两部分分别表示：

- `async`：函数内部可以使用 `await` 等待异步操作；
- `*`：函数可以多次 `yield`，逐步向外发送结果。

因此，`async function*` 可以理解为「异步的分批返回函数」。

### `await` 等待的是什么

`await` 等待的是 Promise：

```javascript
const file = await readFileAsync()
```

执行到这里时，当前函数先暂停；Promise 完成后，函数再从这一行继续。它暂停的是当前异步函数，不会阻塞整个 JavaScript 进程。

普通 `async function` 最终返回一个 Promise：

```javascript
async function getAnswer() {
  return 42
}

const answer = await getAnswer()
// => 42
```

而 `async function*` 返回的不是一个最终 Promise，而是 AsyncGenerator：

```javascript
const stream = queryLoop()
// => AsyncGenerator
```

所以不能用一次 `await queryLoop()` 取得全部消息。需要不断向生成器索要下一条结果。

### 为什么是 `for await...of`

异步生成器的每次 `next()` 都返回 Promise：

```javascript
const iterator = queryLoop()

await iterator.next()
// => { value: 第一条事件, done: false }

await iterator.next()
// => { value: 第二条事件, done: false }
```

`for await...of` 就是把「反复调用 `next()`，并等待每个 Promise」写成循环：

```javascript
for await (const event of queryLoop()) {
  console.log(event)
}
```

它大致相当于：

```javascript
const iterator = queryLoop()

while (true) {
  const item = await iterator.next()

  if (item.done) {
    break
  }

  const event = item.value
  console.log(event)
}
```

因此：

- `for...of` 用来遍历同步数据；
- `for await...of` 用来遍历异步产生的数据；
- 这里的 `await` 表示每一轮都要等待下一条事件到达。

模型的文本、Tool Use 和 Tool Result 不是同时产生的，所以 `queryLoop()` 很适合用这种方式逐条输出。

### `yield*` 为什么又多一个 `*`

`yield*` 表示「把另一个生成器产生的内容全部转交出去」。

先看一个简化例子：

```javascript
async function* child() {
  yield '第一条消息'
  yield '第二条消息'

  return 'child 已结束'
}

async function* parent() {
  const result = yield* child()

  console.log(result)
  // => 'child 已结束'
}
```

`parent()` 做了两件事：

1. `child()` 每次 `yield` 的消息，都继续成为 `parent()` 的输出；
2. `child()` 最后的 `return` 值，保存到 `result`。

这正是 `query()` 中的写法：

```javascript
const terminal =
  yield* queryLoop(params, consumedCommandUuids)
```

对应关系是：

- `queryLoop()` 产生的文本、Tool Use 和 Tool Result，继续由 `query()` 向上输出；
- `queryLoop()` 最后返回的 `{ reason: 'completed' }`，保存到 `terminal`；
- `query()` 完成 Command 状态清理后，再 `return terminal`。

### 把这些语法放回本文

```javascript
export async function* query(params) {
  const terminal =
    yield* queryLoop(params)

  return terminal
}

for await (const event of query(params)) {
  render(event)
}
```

可以按下面的顺序理解：

1. `async function* query()`：这是一个会异步、分批产生事件的函数；
2. `yield* queryLoop()`：把主循环产生的事件原样向上传；
3. `for await...of`：上层等待并逐条消费这些事件；
4. `yield`：产生一条过程事件；
5. `return`：生成器结束，并返回最终状态。

最后注意一个细节：`for await...of` 只能遍历 `yield` 出来的过程值，不会把生成器最后的 `return` 值赋给循环变量。需要取得最终 `return` 值时，要像 `query()` 一样使用 `yield*`，或者手动读取 `iterator.next()` 返回的 `{ value, done }`。
