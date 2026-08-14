---
title: "12、错误处理与自动恢复：让 Agent 稳定运行"
---

正常情况下，模型返回 Tool Use，Tool 执行后生成 Tool Result，结果写回 `messages`，下一轮模型请求再带上这些结果继续。

这条路径一旦出错，不能只用一个 `catch` 把所有情况重试。请求还没到模型、模型回答被截断、输入太长、用户中断，代码能看见的信息都不同。

这一篇沿着一次模型请求走一遍，先确定错误发生在哪个阶段，再看对应的恢复动作。

## 1. 先看全貌：错误在哪个阶段出现

`queryLoop()` 的返回值中有多种 `reason`，其中既有错误，也有正常完成和 `maxTurns` 这类停止边界。按调用阶段整理后，主线更清楚：

| 阶段 | 源码看到的情况 | 典型结果 | 自动动作 |
| --- | --- | --- | --- |
| 发起 API 请求时 | 还没有 Assistant Message | 429、529、网络临时故障 | `withRetry()` 等待并重发请求；部分连续 529 可切换备用模型 |
| 消费模型流后 | 已拿到 Assistant Message，但回答不能直接使用 | `max_output_tokens` | 满足升级条件时先用 64000 输出上限重发同一输入；仍截断时追加续写消息 |
| 消费模型流后 | 输入上下文或媒体超过限制 | `prompt_too_long`、`image_error` | 先尝试上下文替换或裁掉媒体，再重发 |
| Tool 执行时 | 某个 Tool 运行失败 | 带 `is_error` 的 Tool Result | 结果作为消息回给模型，由下一轮决定怎样处理 |
| 用户主动中断 | `abortController.signal.aborted` | `aborted_streaming`、`aborted_tools` | 停止，不自动重试 |
| 运行时代码抛出异常 | API 层没有正常产出消息 | `model_error` | 补齐缺失 Tool Result，交回真实错误 |

其中前 3 行是「自动恢复」的主体。后 3 行分别属于 Tool 协议、用户意图和程序错误，不能把它们当成网络问题偷偷再跑一次。

下面使用同一个任务作为运行示例：

```javascript
// 运行时值，不属于函数体：src/query.ts::queryLoop() 首轮请求的 messages。
[
  {
    type: 'user',
    uuid: 'user_01',
    message: {
      role: 'user',
      content: '检查 src/auth/login.ts 的登录逻辑',
    },
  },
]
```

## 2. 第一层：请求没有拿到回答，`withRetry()` 重发 API 请求

`queryLoop()` 不直接创建 API 客户端。它通过 `deps.callModel()` 调用生产实现 `queryModelWithStreaming()`；后者把创建流的动作交给 `withRetry()`。

源码位置：`src/query.ts:659-707`、`src/services/api/claude.ts:1778-1860`、`src/services/api/withRetry.ts:170-262`

```javascript
// 函数体：src/services/api/withRetry.ts::withRetry()
export async function* withRetry(getClient, operation, options) {
  const maxRetries = getMaxRetries(options) // => 10
  const retryContext = {
    model: options.model, // => 'claude-sonnet-4-6'
    thinkingConfig: options.thinkingConfig,
  }
  let client = null

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) {
      throw new APIUserAbortError()
    }

    try {
      if (client === null) {
        client = await getClient()
      }

      return await operation(client, attempt, retryContext)
      // => 成功时返回 Anthropic SDK 的模型事件流。
    } catch (error) {
      // ... 源码在这里排除不可重试错误，并处理 529 的备用模型分支。
      const retryAfter = getRetryAfter(error)
      const delayMs = getRetryDelay(attempt, retryAfter)
      // attempt => 1；基础等待从 500ms 开始，服务端给出 Retry-After 时优先使用它。

      logEvent('tengu_api_retry', {
        attempt,
        delayMs,
        status: error.status, // => 429 或 529
      })

      yield createSystemAPIErrorMessage(error, delayMs, attempt, maxRetries)
      await sleep(delayMs, options.signal, { abortError })
    }
  }
}
```

这里的「重发」不会改变 `messages`。请求失败时，模型还没有返回一条有效 Assistant Message，主循环没有新会话内容可以保存；它只需要等待，再把同样的请求发出去。

`withRetry()` 成功后才返回 `stream`。`queryModelWithStreaming()` 消费这个流，逐步产出文本和 Tool Use；之后发生的错误才进入 `queryLoop()` 的第二层处理。

## 3. 第二层：模型调用已产生消息，但这条消息先不交给界面

模型流结束后，`queryLoop()` 已经收集到了本轮的 Assistant Message。对于 `max_output_tokens`、上下文过长和媒体过大，源码先把消息放进 `assistantMessages`，同时暂不 `yield` 给 REPL。

源码位置：`src/query.ts:800-834`、`src/query.ts:1063-1085`

```javascript
// 函数体：src/query.ts::queryLoop()
async function* queryLoop(params, consumedCommandUuids) {
  while (true) {
    // ...
    for await (const message of deps.callModel(/* ... */)) {
      let withheld = false

      if (isWithheldMaxOutputTokens(message)) {
        withheld = true
      }
      // ... 上下文过长和媒体过大也会把 withheld 设为 true。

      if (!withheld) {
        yield message
      }

      if (message.type === 'assistant') {
        assistantMessages.push(message)
        // => [{ type: 'assistant', apiError: 'max_output_tokens', message: { role: 'assistant', content: [...] } }]
      }
    }

    const lastMessage = assistantMessages.at(-1)
    // => 本轮最后一条 Assistant Message；后面的恢复分支检查它。
    // ...
  }
}
```

`withheld` 的作用不是丢弃消息，而是给恢复分支一个机会。恢复成功后，新的消息或新的上下文会被重新 `yield`；恢复耗尽时，原错误才会显示并结束。

接下来的第 4 节和第 5 节都从 `lastMessage` 开始判断：第 4 节处理 `max_output_tokens`；第 5 节处理 `prompt_too_long` 与媒体大小错误。

## 4. 输出截断：一条路径里的三个出口

输出截断不代表模型完全没有结果。当前源码把它分成三种处理结果：

- 输出上限不够且升级条件满足时，先把上限提高到 64000，争取一次生成完整回答；
- 仍然截断时，保留已经生成的内容，让模型从断点继续，避免从头重复；
- 续写次数耗尽时，交回截断错误，不再假装能够自动恢复。

源码位置：`src/query.ts:1188-1258`、`src/utils/context.ts:148-151`

```javascript
// 函数体：src/query.ts::queryLoop()
async function* queryLoop(params, consumedCommandUuids) {
  while (true) {
    // ... lastMessage.apiError => 'max_output_tokens'
    if (isWithheldMaxOutputTokens(lastMessage)) {
      const capEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
        'tengu_otk_slot_v1',
        false,
      ) // => true

      if (
        capEnabled &&
        maxOutputTokensOverride === undefined &&
        !process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
      ) {
        state = {
          messages: messagesForQuery,
          // => 仍是 ['检查 src/auth/login.ts 的登录逻辑']；不带半截回答
          toolUseContext,
          maxOutputTokensOverride: ESCALATED_MAX_TOKENS, // => 64000
          maxOutputTokensRecoveryCount, // => 0
          hasAttemptedReactiveCompact,
          turnCount,
          transition: { reason: 'max_output_tokens_escalate' },
          // ...
        }
        continue
      }

      if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
        const recoveryMessage = createUserMessage({
          content:
            'Output token limit hit. Resume directly — no apology, no recap of what you were doing. ' +
            'Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.',
          isMeta: true,
        })

        state = {
          messages: [
            ...messagesForQuery,
            ...assistantMessages,
            // => 半截回答：'登录校验入口位于 src/auth/login.ts，失败分支目前……'
            recoveryMessage,
            // => 隐藏 User Message：要求模型从中断处继续。
          ],
          toolUseContext,
          maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1, // => 1
          maxOutputTokensOverride: undefined,
          hasAttemptedReactiveCompact,
          turnCount,
          transition: {
            reason: 'max_output_tokens_recovery',
            attempt: maxOutputTokensRecoveryCount + 1, // => 1
          },
          // ...
        }
        continue
      }

      yield lastMessage
    }

    if (lastMessage?.isApiErrorMessage) {
      return { reason: 'completed' }
    }
    // ...
  }
}
```

第一种状态只会在 `tengu_otk_slot_v1` 开关开启、尚未设置 `maxOutputTokensOverride`、且未设置 `CLAUDE_CODE_MAX_OUTPUT_TOKENS` 时发生。它只修改 `maxOutputTokensOverride`，`messages` 仍是原请求；因此它的作用是重新生成，而不是接着半截文本说下去。

第二种状态把 `assistantMessages` 与 `recoveryMessage` 一起加入 `messages`。它的作用是保存已花掉的输出：模型能看到「已经说到哪里」，只补剩余内容。`maxOutputTokensRecoveryCount` 从 0 变成 1，最多允许 3 次续写。

最后一种状态不再更新 `state`。`yield lastMessage` 把暂存的截断错误交给 REPL，随后结束查询。自动恢复的边界在这里，而不是无限要求模型继续。

## 5. 输入太长或媒体太大：替换输入后再请求

这一节只追一次被服务端拒绝的请求。假设本轮准备发送的 `messagesForQuery` 中既有当前问题，也有很多历史 Tool Result；服务端可能返回两种错误：整段消息过长，或其中一张图片、PDF 等媒体过大。

主循环不会立刻把这条错误显示给 REPL。它先留住错误，检查能否构造一份更小的输入；能构造就重发，不能构造才结束。

整条路径可以先压成四步：

1. 模型流返回输入错误；
2. 错误先进入 `assistantMessages`，但不 `yield`；
3. 文本过长优先采用已有的局部替换，否则文本和媒体都交给 `tryReactiveCompact()` 产生新的消息数组；
4. 新数组写入新建 `state` 对象的 `messages` 字段后 `continue` 重发；没有新数组才把原错误交给 REPL。

### 1. 先留下错误，不立即显示

源码位置：`src/query.ts:800-834`

```javascript
// 函数体：src/query.ts::queryLoop()
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
) {
  // ...
  while (true) {
    // ... 本轮通过 deps.callModel() 请求模型。
    for await (const message of deps.callModel(/* ... */)) {
      let withheld = false

      if (reactiveCompact?.isWithheldPromptTooLong(message)) {
        withheld = true
      }

      if (
        mediaRecoveryEnabled &&
        reactiveCompact?.isWithheldMediaSizeError(message)
      ) {
        withheld = true
      }

      if (!withheld) {
        yield message
      }

      if (message.type === 'assistant') {
        assistantMessages.push(message)
      }
    }
  }
  // ...
}
```

以「输入过长」为例，`message` 的运行值是一条 API 错误消息；`withheld` 最终为 `true`，所以它不会先显示在界面上，但仍留在 `assistantMessages` 里供后面的恢复代码判断。

```javascript
// 运行时值，不属于函数体：src/query.ts::queryLoop() 中的模型流消息。
const message = {
  type: 'assistant',
  isApiErrorMessage: true,
  message: {
    role: 'assistant',
    content: 'Prompt is too long',
  },
}
```

### 2. 根据错误类型选择替换来源

模型流结束后，`lastMessage` 就是刚才暂存的错误。这里先区分「文本过长」和「媒体过大」，但两者最终都需要得到新的 `messages`。

源码位置：`src/query.ts:1063-1182`

```javascript
// 函数体：src/query.ts::queryLoop()
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
) {
  while (true) {
    // ... 已消费本轮模型流。
    const lastMessage = assistantMessages.at(-1)
    // => {
    //      type: 'assistant',
    //      isApiErrorMessage: true,
    //      message: { role: 'assistant', content: 'Prompt is too long' },
    //    }

    const isWithheld413 =
      lastMessage?.type === 'assistant' &&
      lastMessage.isApiErrorMessage &&
      isPromptTooLongMessage(lastMessage)
    // => true

    const isWithheldMedia =
      mediaRecoveryEnabled &&
      reactiveCompact?.isWithheldMediaSizeError(lastMessage)
    // => false

    if (
      isWithheld413 &&
      feature('CONTEXT_COLLAPSE') &&
      contextCollapse &&
      state.transition?.reason !== 'collapse_drain_retry'
    ) {
      const drained = contextCollapse.recoverFromOverflow(
        messagesForQuery,
        querySource,
      )
      // => { committed: 0, messages: messagesForQuery }

      if (drained.committed > 0) {
        state = {
          messages: drained.messages,
          toolUseContext,
          turnCount,
          transition: {
            reason: 'collapse_drain_retry',
            committed: drained.committed,
          },
          // ...
        }
        continue
      }
    }

    if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
      const compacted = await reactiveCompact.tryReactiveCompact({
        hasAttempted: hasAttemptedReactiveCompact, // => false
        messages: messagesForQuery,
        // => [
        //      { type: 'user', message: { role: 'user', content: '检查 src/auth/login.ts' } },
        //      { type: 'user', message: { role: 'user', content: '此前 125 条历史消息和 Tool Result' } },
        //    ]
        querySource, // => 'repl_main_thread'
        aborted: toolUseContext.abortController.signal.aborted, // => false
        cacheSafeParams: {
          systemPrompt,
          userContext,
          systemContext,
          toolUseContext,
          forkContextMessages: messagesForQuery,
        },
      })

      if (compacted) {
        const postCompactMessages = buildPostCompactMessages(compacted)
        // => [
        //      { type: 'user', message: { role: 'user', content: '<summary>此前历史的摘要</summary>' } },
        //      { type: 'user', message: { role: 'user', content: '检查 src/auth/login.ts' } },
        //    ]

        for (const message of postCompactMessages) {
          yield message
        }

        state = {
          messages: postCompactMessages,
          toolUseContext,
          hasAttemptedReactiveCompact: true,
          turnCount,
          transition: { reason: 'reactive_compact_retry' },
          // ...
        }
        continue
      }

      yield lastMessage
      return {
        reason: isWithheldMedia ? 'image_error' : 'prompt_too_long',
      }
    }
    // ...
  }
}
```

文本过长时，`recoverFromOverflow()` 有机会返回已经准备好的局部替换；上面的运行值 `committed: 0` 表示本次没有可直接采用的结果，于是继续调用 `tryReactiveCompact()`。

媒体过大时，运行值则是 `isWithheld413 === false`、`isWithheldMedia === true`。它跳过 `recoverFromOverflow()`，直接进入同一个 `tryReactiveCompact()`。`src/query.ts` 的源码注释把这条媒体恢复称为「strip-retry」：尝试去除超限的图片、PDF 或其他媒体，再形成新的输入重发。

`tryReactiveCompact()` 的内部模块由 Feature Flag 动态加载，当前源码包没有展开。当前调用点能够确认的输入输出只有两种：成功时交回可重发的 `compacted`，失败时交回空值。主循环并不关心它如何缩短文本或移除媒体，只根据是否拿到新的 `messages` 决定重发还是报错。

### 3. 新输入回到循环，原错误只在恢复失败后出现

恢复的落点是新建一个 `state` 对象，其中 `messages` 字段取 `postCompactMessages`，再通过 `state = { ... }` 整体替换旧状态。下一次 `while` 从这份较小的数组重新请求模型；`hasAttemptedReactiveCompact` 随之设为 `true`，避免同一种恢复反复执行。

这里的 `while (true)` 是主循环，不表示这条恢复会无限重试。文本分支第一次采用 `recoverFromOverflow()` 后，`transition.reason` 会变成 `collapse_drain_retry`；下一次仍然收到同样的输入过长错误时，条件 `state.transition?.reason !== 'collapse_drain_retry'` 不再成立，不会再走这次局部替换。

响应式分支则把 `hasAttemptedReactiveCompact` 从 `false` 改为 `true` 传回 `tryReactiveCompact()`；`src/query.ts` 的源码注释说明它用于阻止再次压缩后仍超限时形成循环。恢复函数无法给出新消息数组时，下面的 `yield lastMessage` 与 `return` 会直接结束本次查询。

如果没有得到 `compacted`，`yield lastMessage` 才把原始错误显示出来：文本错误对应 `prompt_too_long`，媒体错误对应 `image_error`。请求前主动缩短历史是另一条路径；这里专门处理服务端已经明确拒绝输入后的补救。

## 6. 恢复路径怎样留下可验证的痕迹

第 4 节和第 5 节里都出现了 `continue`。单看这一句，只能知道循环又开始了，却看不出它是「提高输出上限」「追加续写指令」，还是「替换过长上下文」后重新开始。

`queryLoop()` 把每次继续之前的完整状态放进 `state`，并在其中记录 `transition`。下一轮循环从这个 `state` 读取输入和恢复标记，因此恢复不是散落在局部变量里的临时行为。

源码位置：`src/query.ts:241-310`

```javascript
// 函数体：src/query.ts::queryLoop()
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
) {
  let state: State = {
    messages: params.messages,
    // => [{ type: 'user', message: { role: 'user', content: '检查 src/auth/login.ts 的登录逻辑' } }]
    toolUseContext: params.toolUseContext,
    maxOutputTokensOverride: undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    turnCount: 1,
    transition: undefined,
    // ...
  }

  while (true) {
    const {
      messages,
      maxOutputTokensRecoveryCount,
      hasAttemptedReactiveCompact,
      maxOutputTokensOverride,
      turnCount,
    } = state
    // ... 使用这份状态发起本轮模型请求。
  }
}
```

以「输出截断后续写」为例，恢复分支写回的状态与首轮相比，只有本轮需要的字段发生变化：

| 字段 | 首轮值 | 续写重试后的值 | 下一轮如何使用 |
| --- | --- | --- | --- |
| `messages` | 只有用户问题 | 用户问题、半截 Assistant Message、隐藏续写指令 | 模型据此从中断处继续 |
| `maxOutputTokensRecoveryCount` | `0` | `1` | 限制最多续写 3 次 |
| `maxOutputTokensOverride` | `undefined` | `undefined` | 这次不再是提高上限的重发 |
| `transition.reason` | `undefined` | `max_output_tokens_recovery` | 标记本次循环为何继续 |

`transition` 不只是日志标签。第 5 节的 Context Collapse 已经直接读取前一轮的值，避免同一份局部替换结果被重复提交：

源码位置：`src/query.ts:1087-1095`

```javascript
// 函数体：src/query.ts::queryLoop()
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
) {
  // ...
  if (isWithheld413) {
    // isWithheld413 => true，表示本轮收到 prompt_too_long。
    if (
      feature('CONTEXT_COLLAPSE') &&
      contextCollapse &&
      state.transition?.reason !== 'collapse_drain_retry'
      // => 首次处理时 transition 是 undefined，可以进入。
      // => 重试后 transition.reason 是 'collapse_drain_retry'，跳过这条分支。
    ) {
      // ...
    }
  }
}
```

源码中 `State` 的注释也明确说明：`transition` 描述上一轮为什么继续，测试可以据此断言恢复路径是否触发。这里看到的实际作用是，状态既保存下一轮要带的消息，也保存这份消息为什么会变成现在这样。

### 不访问真实 API，也能复现恢复分支

恢复路径最难直接测试的部分是模型请求：真实 API 会带来网络、等待时间和不稳定结果。`queryLoop()` 没有在函数内部写死模型实现，而是优先读取 `params.deps`；生产环境未传入时，才使用 `productionDeps()`。

源码位置：`src/query.ts:263`、`src/query.ts:659-707`、`src/query/deps.ts:16-40`

```javascript
// 函数体：src/query.ts::queryLoop()
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
) {
  const deps = params.deps ?? productionDeps()

  // ...
  for await (const message of deps.callModel({
    messages: prependUserContext(messagesForQuery, userContext),
    systemPrompt: fullSystemPrompt,
    tools: toolUseContext.options.tools,
    // ...
  })) {
    yield message
  }
  // ...
}

// 函数体：src/query/deps.ts::productionDeps()
export function productionDeps(): QueryDeps {
  return {
    callModel: queryModelWithStreaming,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: randomUUID,
  }
}
```

生产运行时，`deps.callModel` 是 `queryModelWithStreaming`；测试传入自己的 `deps.callModel`，就可以稳定产出「输出截断」或「输入过长」这类 Assistant Message。随后检查下一次调用拿到的 `messages`、恢复计数和 `transition.reason`，即可验证恢复是否按预期重建状态，而不必真的等待 API 返回或制造超长上下文。

## 小结

这条源码把「失败后怎么办」拆成了四种不同的状态：

| 当前已经拿到什么 | 主循环改变什么 | 代表路径 |
| --- | --- | --- |
| 还没有有效模型回答 | 不改消息，只重发同一请求 | `withRetry()` 处理临时 API 故障 |
| 回答碰到默认输出上限，且满足升级条件 | 不改消息，把本次输出上限提高到 64000 后重发 | `max_output_tokens_escalate` |
| 提高上限后仍只有半截回答 | 保留半截回答，再加入续写指令 | `max_output_tokens_recovery` |
| 服务端拒绝整份输入 | 用更短的消息数组替换原输入 | `prompt_too_long`、媒体过大恢复 |

因此恢复动作不是由「发生了错误」统一决定的，而是由当前保留的数据决定的：没有可用回答时可以原样重发；回答只是碰到默认输出上限且升级条件满足时可以先放宽上限；已经生成的内容不能丢；输入本身装不下时只能换输入。每次恢复都通过新的 `state` 进入下一轮，并用计数或 `transition` 留下停止条件和路径标记。
