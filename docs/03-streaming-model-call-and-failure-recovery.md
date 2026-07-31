---
title: 3、一次模型回答如何流进 Agent
---

上一篇读到 `queryLoop()` 时，停在了这段代码：

```javascript
// src/query.ts
async function* queryLoop(/* ... */) {
  // ...

  for await (
    const message of deps.callModel(/* ... */)
  ) {
    yield message

    if (message.type === 'assistant') {
      assistantMessages.push(message)
    }
  }

  // ...
}
```

当时只需要知道 `callModel()` 会不断返回消息，没有继续追消息是怎样产生的。

现在沿着 `callModel()` 往下走。前半篇使用
`Grep({ pattern: 'login|auth', path: 'src' })` 这个例子，跟踪一次正常的模型请求：API 返回的网络碎片怎样变成终端上的实时内容，以及 Agent 可以使用的完整消息。

正常链路走完后，后半篇继续看三种异常处理：流式请求失败后改用非流式请求、模型持续过载后切换备用模型，以及用户主动中断。

途中会碰到两类输出：

- `StreamEvent`：尚未完整也可以发出，供终端实时显示；
- `AssistantMessage`：一个内容块组装完成后才发出，供 `queryLoop()` 判断是否调用 Tool。

如果连接中途断开，已经发出的 `AssistantMessage` 还涉及撤销和重试。这是正常路径走完以后再处理的问题。

## 调用链

![图 1：一次模型回答的两条输出路径](https://windliangblog.oss-cn-beijing.aliyuncs.com/diagram-01.png)

主线只有三步：`queryLoop()` 发起调用，`queryModel()` 组装 API 碎片，结果分别交给 REPL 和 `queryLoop()`。下面直接进入这三个位置。

## `deps.callModel()` 是谁

源码位置：`src/query/deps.ts:7-39`、`src/query.ts:198`、`src/query.ts:263`

```javascript
// QueryParams 允许传入 deps，供测试直接注入 fake，
// 避免反复对各个模块使用 spyOn。
export type QueryDeps = {
  callModel: typeof queryModelWithStreaming
  // ...
}

export function productionDeps() {
  return {
    callModel: queryModelWithStreaming,
    // => 正常运行时，deps.callModel
    //    就是 queryModelWithStreaming

    // ...
  }
}

async function* queryLoop(params, /* ... */) {
  const deps =
    params.deps ?? productionDeps()
  // 正常运行：使用 productionDeps()
  // 测试：可以通过 params.deps 替换 callModel

  // ...
}
```

正常运行时，`deps.callModel` 是 `queryModelWithStreaming`；测试传入 `params.deps` 后，可以换成假的模型函数，不必访问 API。

`queryModelWithStreaming()` 继续把工作交给内部的 `queryModel()`。

源码位置：`src/services/api/claude.ts:752-780`

```javascript
export async function* queryModelWithStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}) {
  return yield* withStreamingVCR(
    messages,
    async function* () {
      yield* queryModel(
        messages,
        systemPrompt,
        thinkingConfig,
        tools,
        signal,
        options,
      )
    },
  )
}
```

`withStreamingVCR()` 用于录制和回放模型流。这里暂时不继续追它，因为真正请求 API、处理流事件的是 `queryModel()`。

## 进入 `queryModel()`，模型请求是怎样发出的

源码位置：`src/services/api/claude.ts:1776-1857`

```javascript
// src/services/api/claude.ts
async function* queryModel(
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
) {
  let stream

  // 前面先把 messages、systemPrompt 和 tools
  // 整理成 API 需要的 params
  // ...

  const generator = withRetry(
    () => getAnthropicClient(/* ... */),

    async anthropic => {
      const result = await anthropic.beta.messages
        .create(
          {
            ...params,
            stream: true,
            // => 开启流式返回
          },
          {
            signal,
            // => 用户中断时可以终止请求
          },
        )
        .withResponse()

      streamRequestId = result.request_id
      // => 'req_01ABC...'

      return result.data
      // => Anthropic SDK 创建的原始事件流
    },

    // 重试配置……
  )

  let step
  do {
    step = await generator.next()
    // withRetry() 中途 yield 消息时：
    // step => { done: false, value: API 错误消息 }
    //
    // withRetry() 最后 return 原始流时：
    // step => { done: true, value: result.data }

    if (!('controller' in step.value)) {
      yield step.value
      // => withRetry() 途中产生的 API 错误消息
    }
  } while (!step.done)

  stream = step.value
  // => 循环结束说明 step.done === true
  // => 此时 step.value 才是 result.data

  // 后面通过 for await 逐个读取 stream 中的事件
}
```

设置 `stream: true` 后，API 不会一次返回完整回答，而是持续返回事件。

对于 Tool Use，`content_block_start` 先给出 Tool 名称和 ID，参数随后通过多个 `input_json_delta` 分段到达。只有参数拼接成完整 JSON 后，才能构造可执行的 `Grep` 调用。

## 顺着 `for await` 看它怎样拼回完整消息

上边代码最终得到的 `stream` 的类型是 `Stream<BetaRawMessageStreamEvent>`。它不是一个已经装好所有数据的数组，而是一串陆续到达的事件。`for await` 每次取出的 `part` 只代表其中一个事件。

一次回答通常按下面的顺序到达：

```javascript
async function* queryModel(/* ... */) {
  for await (const part of stream) {
    // part 依次可能是：
    //
    // { type: 'message_start', message: { ... } }
    //
    // 文字内容块开始时：
    // {
    //   type: 'content_block_start',
    //   index: 0,
    //   content_block: {
    //     type: 'text',
    //     text: '',
    //   },
    // }
    //
    // Grep 内容块开始时：
    // {
    //   type: 'content_block_start',
    //   index: 1,
    //   content_block: {
    //     type: 'tool_use',
    //     id: 'toolu_01',
    //     name: 'Grep',
    //     input: {},
    //   },
    // }
    //
    // Grep 参数到达时：
    // {
    //   type: 'content_block_delta',
    //   index: 1,
    //   delta: {
    //     type: 'input_json_delta',
    //     partial_json: '{"pattern":"login',
    //   },
    // }
    //
    // { type: 'content_block_stop', index: 1 }
    //
    // 此处省略了 index: 0 的文字块事件；
    // 不同内容块通过 index 区分。
    //
    // { type: 'message_stop' }
  }
}
```

`message_start` 和 `message_stop` 管整条回答；中间三个 `content_block_*` 事件负责一块具体内容。`index` 表示事件属于哪一块内容。

这三个事件携带的字段并不相同：

```javascript
// 内容块刚开始，带 content_block
{
  type: 'content_block_start',
  index: 1,
  content_block: { /* ... */ },
}

// 内容增量到达，带 delta
{
  type: 'content_block_delta',
  index: 1,
  delta: { /* ... */ },
}

// 内容块结束，只需要指出哪个 index 结束
{
  type: 'content_block_stop',
  index: 1,
}
```

本文假设模型先输出一段文字，再调用 `Grep`，因此文字块的 `index` 是 `0`，`Grep` 块的 `index` 是 `1`。`contentBlocks` 用来暂存这些事件携带的碎片，下面依次看开始、增量和结束三个分支。

### `content_block_start`：先创建一个空壳

源码位置：`src/services/api/claude.ts:1995-2052`

```javascript
// src/services/api/claude.ts
async function* queryModel(/* ... */) {
  const contentBlocks = []

  // 上一节中：
  // stream = step.value
  //        = result.data

  for await (const part of stream) {
    switch (part.type) {
      case 'content_block_start': {
        switch (part.content_block.type) {
          case 'tool_use':
            contentBlocks[part.index] = {
              ...part.content_block,
              // 这次运行此时的 part.content_block：
              // {
              //   type: 'tool_use',
              //   id: 'toolu_01',
              //   name: 'Grep',
              //   input: {},
              // }

              input: '',
              // => 参数还没收完，
              //    改用字符串累积
            }
            break

          case 'text':
            contentBlocks[part.index] = {
              ...part.content_block,
              text: '',
            }
            break
        }

        break
      }

      // 其他事件由后面的 case 处理
      // ...
    }
  }
}
```

执行完这个分支后，当前 `queryModel()` 中的 `contentBlocks[1]` 变成 `{ type: 'tool_use', id: 'toolu_01', name: 'Grep', input: '' }`。

这时只能知道模型准备调用 `Grep`，参数仍然是空的，它还不是一个可以执行的 Tool Use。

### `content_block_delta`：把参数一段段接起来

源码位置：`src/services/api/claude.ts:2053-2169`

```javascript
// src/services/api/claude.ts
async function* queryModel(/* ... */) {
  const contentBlocks = []

  // content_block_start 已经创建内容块
  // ...

  for await (const part of stream) {
    switch (part.type) {
      // ...

      case 'content_block_delta': {
        const contentBlock =
          contentBlocks[part.index]

        if (part.delta.type === 'text_delta') {
          contentBlock.text += part.delta.text
        }

        if (
          part.delta.type ===
          'input_json_delta'
        ) {
          contentBlock.input +=
            part.delta.partial_json

          // 这次运行三次执行到这里以后：
          // 第 1 次
          // => '{"pattern":"login'
          //
          // 第 2 次
          // => '{"pattern":"login|auth","path":"'
          //
          // 第 3 次
          // => '{"pattern":"login|auth","path":"src"}'
        }

        break
      }

      // ...
    }
  }
}
```

到第三段为止，`input` 才成为完整 JSON。

文本块也是同样的过程：`contentBlocks[0].text` 会从「我先」变成「我先搜索登录」，最后变成「我先搜索登录相关代码。」。

### `content_block_stop`：这时才生成正式消息

源码位置：`src/services/api/claude.ts:2171-2211`

```javascript
// src/services/api/claude.ts
async function* queryModel(/* ... */) {
  const newMessages = []
  const contentBlocks = []

  // 前面已经处理 start 和 delta
  // ...

  for await (const part of stream) {
    switch (part.type) {
      // ...

      case 'content_block_stop': {
        const contentBlock =
          contentBlocks[part.index]

        const message = {
          message: {
            ...partialMessage,

            content: normalizeContentFromAPI(
              [contentBlock],
              tools,
              options.agentId,
            ),
          },
          type: 'assistant',
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
        }

        newMessages.push(message)
        yield message
        // => 内容块完整以后，
        //    才产出 AssistantMessage

        break
      }

      // ...
    }
  }
}
```

把运行值代进去，文本块结束时第一次产出：

```javascript
{
  type: 'assistant',
  uuid: 'assistant_text_01',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: '我先搜索登录相关代码。',
      },
    ],
  },
}
```

Tool 块结束时第二次产出：

```javascript
{
  type: 'assistant',
  uuid: 'assistant_tool_01',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_01',
        name: 'Grep',
        input: {
          pattern: 'login|auth',
          path: 'src',
        },
      },
    ],
  },
}
```

一次模型回答可以包含多个内容块，Claude Code 会在每个内容块完成时分别产出一条 `AssistantMessage`。因此 `queryLoop()` 使用 `assistantMessages` 数组保存 `deps.callModel()` 返回的所有 `assistant` 消息。

```javascript
async function* queryLoop(/* ... */) {
  const assistantMessages = []

  // 中间省略请求参数的准备
  // ...

  for await (
    const message of deps.callModel(/* ... */)
  ) {
    if (message.type === 'assistant') {
      assistantMessages.push(message)

      // 文本块结束后第一次执行：
      // assistantMessages
      // => [文本 AssistantMessage]
      //
      // Grep 块结束后第二次执行：
      // assistantMessages
      // => [
      //   文本 AssistantMessage,
      //   Grep AssistantMessage,
      // ]
    }
  }
}
```

## 终端为什么在内容块结束前就有输出

至此，完整 `AssistantMessage` 已经找到了。但这条路径必须等到 `content_block_stop`，仍然解释不了终端为什么可以逐字输出。

继续看 `for await` 的末尾，会发现每处理完一个原始 API 事件，`queryModel()` 还会原样转发一次。

源码位置：`src/services/api/claude.ts:2295-2303`

```javascript
// src/services/api/claude.ts
async function* queryModel(/* ... */) {
  // ...

  for await (const part of stream) {
    switch (part.type) {
      // 先在这里更新 contentBlocks，
      // 完整时还会 yield AssistantMessage
      // ...
    }

    // 无论是哪一种原始事件，
    // 最后都会再包装成 StreamEvent 向上转发
    yield {
      type: 'stream_event',
      event: part,

      ...(part.type === 'message_start'
        ? { ttftMs }
        : undefined),
    }
  }
}
```

以第一段文本为例，向上返回的是：

```javascript
{
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'text_delta',
      text: '我先',
    },
  },
}
```

以第一段 Tool 参数为例：

```javascript
{
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 1,
    delta: {
      type: 'input_json_delta',
      partial_json: '{"pattern":"login',
    },
  },
}
```

到这里，同一个 `input_json_delta` 的两条去路就对上了：它先追加到 `contentBlocks[1].input`，然后又被包装成 `StreamEvent` 向上转发。

所谓「一条 API 流，两种用途」，就是在这个位置分开的。

### 两种结果先回到 `queryLoop()`

`queryModel()` 产出的结果经过 `queryModelWithStreaming()`，回到 `queryLoop()`：

```javascript
// src/query.ts:659、817-828
async function* queryLoop(/* ... */) {
  for await (
    const message of deps.callModel(/* ... */)
  ) {
    yield message
    // => StreamEvent 和 AssistantMessage
    //    都继续向 query() 的调用方转发

    if (message.type === 'assistant') {
      assistantMessages.push(message)
      // => queryLoop() 只把完整消息
      //    保存到本轮正式状态
    }
  }
}
```

`query()` 使用 `yield*` 原样转发 `queryLoop()` 的输出。交互模式下，REPL 才是 `query()` 的调用方：

```javascript
// src/query.ts:219-232
export async function* query(params) {
  const consumedCommandUuids = []

  const terminal = yield* queryLoop(
    params,
    consumedCommandUuids,
  )

  // 中间处理 Command 生命周期
  // ...

  return terminal
}

// src/screens/REPL.tsx:2584-2585、2793-2802
export function REPL(/* ... */) {
  const onQueryEvent = useCallback(event => {
    handleMessageFromStream(
      event,
      /* ... */
    )
  }, [/* ... */])

  const onQueryImpl = useCallback(async (
    /* ... */
  ) => {
    for await (
      const event of query(/* ... */)
    ) {
      onQueryEvent(event)
    }
  }, [/* ... */])
}
```

因此完整路径是：`queryModel()` 产出事件，`queryLoop()` 接收并向上转发，REPL 从 `query()` 读到事件后，才调用 `handleMessageFromStream()`。

### REPL 拿走 `StreamEvent`

源码位置：`src/screens/REPL.tsx:2584-2585、2793-2802`、`src/utils/messages.ts:3001-3085`

现在才进入 `handleMessageFromStream()`。下面只保留这次运行会经过的 `text_delta` 和 `input_json_delta` 两个分支：

```javascript
// src/utils/messages.ts
export function handleMessageFromStream(
  message,
  onMessage,
  onUpdateLength,
  onSetStreamMode,
  onStreamingToolUses,
  onTombstone,
  onStreamingThinking,
  onApiMetrics,
  onStreamingText,
) {
  // 完整 AssistantMessage 在前面的分支中
  // 直接交给 onMessage()
  // ...

  switch (message.event.type) {
    // ...

    case 'content_block_delta': {
      if (
        message.event.delta.type ===
        'text_delta'
      ) {
        const deltaText =
          message.event.delta.text
        // => '我先'

        onStreamingText(
          text => (text ?? '') + deltaText,
        )
        // => 终端立刻多显示两个字
      }

      if (
        message.event.delta.type ===
        'input_json_delta'
      ) {
        const delta =
          message.event.delta.partial_json
        // => '{"pattern":"login'

        const index = message.event.index

        onStreamingToolUses(items => {
          const current = items.find(
            item => item.index === index,
          )

          if (!current) {
            return items
          }

          return [
            ...items.filter(
              item => item !== current,
            ),
            {
              ...current,
              unparsedToolInput:
                current.unparsedToolInput +
                delta,
              // 第 1 次
              // => '{"pattern":"login'
              //
              // 第 3 次
              // => '{"pattern":"login|auth","path":"src"}'
            },
          ]
        })
      }

      return
    }

    // ...
  }
}
```

三个增量都处理完后，REPL 中的 `streamingText` 是「我先搜索登录相关代码。」，`streamingToolUses[0].unparsedToolInput` 是 `{"pattern":"login|auth","path":"src"}`。

这两个值只服务于终端显示，并不会被当成下一步模型消息。

另一边，前面已经看到 `queryLoop()` 只把 `AssistantMessage` 加入 `assistantMessages`，后面再从中找出 Tool Use。两类数据的边界如下：

| 数据               | 可能是半截吗           | 保存在哪里                    | 用来做什么                |
| ------------------ | ---------------------- | ----------------------------- | ------------------------- |
| `StreamEvent`      | 是                     | REPL 临时状态                 | 逐字显示文本和 Tool 参数  |
| `AssistantMessage` | 否，一个内容块已经完成 | `assistantMessages`、会话记录 | 识别 Tool Use、推进 Agent |

## 把刚才追过的路径串起来

把刚才分散在三个函数中的代码画到一张时序图里。为了突出 Tool Use 的组装过程，图中省略了前面的文本内容块，只跟踪 `Grep` 从 `content_block_start` 到完整 `AssistantMessage` 的过程。

![图 2：正常流式过程](https://windliangblog.oss-cn-beijing.aliyuncs.com/diagram-02.png)

现在回看正常路径，实际发生的是：

1. API 返回一个增量；
2. `queryModel()` 把增量累积到 `contentBlocks`；
3. 同一个增量被包装成 `StreamEvent`，由 `queryLoop()` 转发给 REPL；
4. 内容块结束后，`queryModel()` 产出完整 `AssistantMessage`；
5. `queryLoop()` 从完整消息中找出 Tool Use。

正常流式路径到这里已经走完。

## 流式连接中断后的回滚

正常路径对上以后，继续看异常分支，仍然使用同一个例子。

假设 API 已经完成了两个内容块：

```javascript
assistantMessages
// => [
//   {
//     type: 'assistant',
//     uuid: 'assistant_text_01',
//     message: {
//       role: 'assistant',
//       content: [
//         {
//           type: 'text',
//           text: '我先搜索登录相关代码。',
//         },
//       ],
//     },
//   },
//   {
//     type: 'assistant',
//     uuid: 'assistant_tool_01',
//     message: {
//       role: 'assistant',
//       content: [
//         {
//           type: 'tool_use',
//           id: 'toolu_01',
//           name: 'Grep',
//           input: {
//             pattern: 'login|auth',
//             path: 'src',
//           },
//         },
//       ],
//     },
//   },
// ]
```

REPL 已经显示了它们，`queryLoop()` 也已经把它们放进 `assistantMessages`。

但在 `message_stop` 到达之前，连接断开了。

Claude Code 改用非流式方式重新请求以后，会一次得到包含两个内容块的完整消息：

```javascript
{
  type: 'assistant',
  uuid: 'assistant_retry_01',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: '我先搜索登录相关代码。',
      },
      {
        type: 'tool_use',
        id: 'toolu_retry_01',
        name: 'Grep',
        input: {
          pattern: 'login|auth',
          path: 'src',
        },
      },
    ],
  },
}
```

如果只是把新结果追加进去，会变成：

```javascript
assistantMessages
// => [
//   {
//     type: 'assistant',
//     uuid: 'assistant_text_01',
//     message: {
//       role: 'assistant',
//       content: [
//         {
//           type: 'text',
//           text: '我先搜索登录相关代码。',
//         },
//       ],
//     },
//   },
//   {
//     type: 'assistant',
//     uuid: 'assistant_tool_01',
//     message: {
//       role: 'assistant',
//       content: [
//         {
//           type: 'tool_use',
//           id: 'toolu_01',
//           name: 'Grep',
//           input: {
//             pattern: 'login|auth',
//             path: 'src',
//           },
//         },
//       ],
//     },
//   },
//   {
//     type: 'assistant',
//     uuid: 'assistant_retry_01',
//     message: {
//       role: 'assistant',
//       content: [
//         {
//           type: 'text',
//           text: '我先搜索登录相关代码。',
//         },
//         {
//           type: 'tool_use',
//           id: 'toolu_retry_01',
//           name: 'Grep',
//           input: {
//             pattern: 'login|auth',
//             path: 'src',
//           },
//         },
//       ],
//     },
//   },
// ]
```

把两次结果放在一起后，问题马上出现了：

1. 用户看到两遍相同内容；
2. `Grep` 可能被执行两次；
3. 两次 Tool Use 的 ID 不同，后续 Tool Result 可能和错误的调用配对。

所以这里的失败恢复不能只是捕获错误后再请求一次，它还必须撤销第一次请求已经交付的结果。

## 源码先尝试同模型的非流式请求

其他流式错误进入 Streaming Fallback 后，模型保持不变，只把传输方式从 `streaming` 改成 `non-streaming`。

把这个分支放回 `queryModel()` 后，主干如下。

源码位置：`src/services/api/claude.ts:2320-2584`

```javascript
// src/services/api/claude.ts
async function* queryModel(
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
) {
  // 前面创建 stream
  // ...

  try {
    for await (const part of stream) {
      // 正常处理流事件……
    }
  } catch (streamingError) {
    if (streamingError instanceof APIUserAbortError) {
      if (signal.aborted) {
        throw streamingError
        // => 调用方主动中断，不自动恢复
      }

      throw new APIConnectionTimeoutError({
        message: 'Request timed out',
      })
      // => SDK 自身超时，不进入下面的非流式 Fallback
    }

    // When the flag is enabled, skip the non-streaming fallback and let the
    // error propagate to withRetry. The mid-stream fallback causes double tool
    // execution when streaming tool execution is active: the partial stream
    // starts a tool, then the non-streaming retry produces the same tool_use
    // and runs it again. See inc-4258.
    const disableFallback =
      isEnvTruthy(
        process.env
          .CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK,
      ) ||
      getFeatureValue_CACHED_MAY_BE_STALE(
        'tengu_disable_streaming_to_non_streaming_fallback',
        false,
      )

    // 例如：
    // CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK
    // => undefined
    //
    // Feature Flag
    // => false
    //
    // disableFallback
    // => false，继续执行非流式 Fallback

    if (disableFallback) {
      throw streamingError
      // => 不执行 executeNonStreamingRequest()
    }

    didFallBackToNonStreaming = true

    options.onStreamingFallback?.()
    // => 回调 queryLoop()：
    //    前一次流式结果需要撤销

    const result =
      yield* executeNonStreamingRequest(
        {
          model: options.model,
          // => 仍是 'claude-sonnet-4-6'
        },
        // ...
      )

    const message = {
      type: 'assistant',
      message: {
        ...result,
        content: normalizeContentFromAPI(
          result.content,
          tools,
          options.agentId,
        ),
      },
      uuid: randomUUID(),
    }

    yield message
    // => 非流式请求一次返回完整结果
  }

  // 后面记录用量并释放资源
  // ...
}
```

`disableFallback` 控制的是其他流式错误能否改用非流式请求。开启后，错误会直接向上抛出，不再发起非流式请求。

## `queryLoop()` 发出 Tombstone（墓碑标记）

前面的流式消息同时进入了两个地方：一份已经 `yield` 给 REPL，用于界面显示和会话记录；另一份保存在 `queryLoop()` 的 `assistantMessages`、`toolResults` 和 `toolUseBlocks` 中。切换到非流式请求时，这两个地方都要清理：

- 对外发出 Tombstone，让 REPL 删除已经显示和记录的旧消息；
- 在 `queryLoop()` 内清空失败流式路径留下的消息和 Tool 状态。

看上边的代码，`queryModel()` 失败时会调用 `options.onStreamingFallback?.()`，再看下边的代码，其实就是将 `streamingFallbackOccured` 标记为 `true`。

源码位置：`src/query.ts:657-728`

```javascript
// src/query.ts
async function* queryLoop(/* ... */) {
  const assistantMessages = []
  // 保存本次模型请求产生的 AssistantMessage

  const toolResults = []
  // 保存已经返回的 Tool Result

  const toolUseBlocks = []
  // 保存从 AssistantMessage 中提取出的 tool_use

  let needsFollowUp = false
  // 是否需要带着 Tool Result 再请求一次模型

  let streamingFallbackOccured = false

  // ...

  for await (const message of deps.callModel({
    // ...
    options: {
      model: currentModel,
      // => 'claude-sonnet-4-6'

      onStreamingFallback: () => {
        streamingFallbackOccured = true
      },
    },
  })) {
    if (streamingFallbackOccured) {
      for (const oldMessage of assistantMessages) {
        yield {
          type: 'tombstone',
          message: oldMessage,
        }
        // => 通知上层删除旧消息
      }

      assistantMessages.length = 0
      // => 删除失败流式路径的模型消息

      toolResults.length = 0
      // => 删除这条路径的 Tool Result

      toolUseBlocks.length = 0
      // => 删除这条路径请求执行的 Tool

      needsFollowUp = false
      // => 不再拿这条路径的 Tool Result 请求模型
    }

    // 接下来再处理非流式请求的新 message
    // ...
  }
}
```

这里同时存在「失败的流式结果」和「随后返回的非流式结果」两条路径。

这几行把前一条路径留下的状态原地清空，接下来循环只处理新的非流式 `message`。数组使用 `.length = 0`，是为了清空原数组，而不是创建一个新数组。

`streamingFallbackOccured` 为 `true` 后会依次产出两条 Tombstone：

```javascript
[
  {
    type: 'tombstone',
    message: {
      type: 'assistant',
      uuid: 'assistant_text_01',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '我先搜索登录相关代码。',
          },
        ],
      },
    },
  },
  {
    type: 'tombstone',
    message: {
      type: 'assistant',
      uuid: 'assistant_tool_01',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_01',
            name: 'Grep',
            input: {
              pattern: 'login|auth',
              path: 'src',
            },
          },
        ],
      },
    },
  },
]
```

每条 Tombstone 都携带一条需要作废的原消息。REPL 收到后删除对应消息。

```javascript
// src/utils/messages.ts:2930-2958
export function handleMessageFromStream(
  message,
  // ...
  onTombstone,
) {
  if (message.type === 'tombstone') {
    onTombstone?.(message.message)
    return
  }

  // 继续处理 StreamEvent 和普通消息
  // ...
}

// src/screens/REPL.tsx:2584-2652
const onQueryEvent = useCallback(event => {
  handleMessageFromStream(
    event,
    newMessage => {
      // 处理普通消息
      setMessages(oldMessages => [...oldMessages, newMessage])
    },
    newContent => {
      // 处理流式文本长度
      setResponseLength(length => length + newContent.length)
    },
    setStreamMode,
    setStreamingToolUses,
    tombstonedMessage => {
      setMessages(oldMessages =>
        oldMessages.filter(message => message !== tombstonedMessage),
      )
      void removeTranscriptMessage(tombstonedMessage.uuid)
    },
  )
}, [])
```

`onTombstone` 是 REPL 传给 `handleMessageFromStream()` 的回调函数，不是一个全局函数。

收到 Tombstone 后，REPL 会通过 `uuid` 把原消息从界面状态和会话记录中移除。

Fallback 的完整流程是：重新请求、撤销旧结果、清空旧的 Tool 状态，最后接收新结果。

![图 3：流式失败后的回滚](https://windliangblog.oss-cn-beijing.aliyuncs.com/diagram-03.png)

## 模型 Fallback 是另一件事

如果同一个模型持续返回 `529` 过载错误，改变流式传输也解决不了问题。满足模型 Fallback 的启用条件，并且已经配置 `fallbackModel` 时，Claude Code 才会切换备用模型。

源码位置：`src/services/api/withRetry.ts:170-178、318-350`

```javascript
// src/services/api/withRetry.ts
export async function* withRetry(
  getClient,
  operation,
  options,
) {
  const maxRetries = getMaxRetries(options)
  const retryContext = {
    model: options.model,
    thinkingConfig: options.thinkingConfig,
  }
  let client = null
  let consecutive529Errors = 0

  for (
    let attempt = 1;
    attempt <= maxRetries + 1;
    attempt++
  ) {
    try {
      client ??= await getClient()
      return await operation(
        client,
        attempt,
        retryContext,
      )
    } catch (error) {
      // 其他错误和重试规则
      // ...

      if (
        is529Error(error) &&
        !shouldRetry529(options.querySource)
      ) {
        throw new CannotRetryError(
          error,
          retryContext,
        )
        // => 非前台调用不在这里继续重试
      }

      if (
        is529Error(error) &&
        (
          process.env
            .FALLBACK_FOR_ALL_PRIMARY_MODELS ||
          (
            !isClaudeAISubscriber() &&
            isNonCustomOpusModel(options.model)
          )
        )
      ) {
        consecutive529Errors++
        // => 1、2、3

        if (
          consecutive529Errors >=
            MAX_529_RETRIES &&
          options.fallbackModel
        ) {
          throw new FallbackTriggeredError(
            options.model,
            // => 'claude-opus-4-6'

            options.fallbackModel,
            // => 'claude-sonnet-4-6'
          )
        }
      }
    }
  }
}
```

因此，不是所有 `529` 都会触发模型 Fallback：非前台调用的这次请求会直接结束；前台调用还要通过模型范围判断，连续达到三次，并且配置了 `fallbackModel`。

`queryLoop()` 捕获这个专用错误后修改 `currentModel`，清空失败尝试的本轮结果，再重做当前请求。

源码位置：`src/query.ts:650-708、893-950`

```javascript
// src/query.ts
async function* queryLoop(/* ... */) {
  let attemptWithFallback = true

  while (attemptWithFallback) {
    attemptWithFallback = false

    try {
      for await (const message of deps.callModel(/* ... */)) {
        // 正常处理模型消息
        // ...
      }
    } catch (innerError) {
      if (
        innerError instanceof FallbackTriggeredError &&
        fallbackModel
      ) {
        currentModel = fallbackModel
        // => 'claude-sonnet-4-6'

        attemptWithFallback = true

        yield* yieldMissingToolResultBlocks(
          assistantMessages,
          'Model fallback triggered',
        )
        // => 补齐可能缺失的 Tool Result

        assistantMessages.length = 0
        toolResults.length = 0
        toolUseBlocks.length = 0
        needsFollowUp = false
        // => 清空当前失败尝试的临时状态

        if (streamingToolExecutor) {
          streamingToolExecutor.discard()
          streamingToolExecutor = new StreamingToolExecutor(
            toolUseContext.options.tools,
            canUseTool,
            toolUseContext,
          )
        }
        // => 丢弃失败尝试的 Tool 队列

        continue
        // => 回到当前 while 顶部，
        //    用备用模型重做当前请求
      }

      throw innerError
    }
  }

  // 后面才决定是否执行 Tool
  // ...
}
```

模型 Fallback 也会清理数据，但只清理当前失败尝试产生的 `assistantMessages`、Tool 状态和执行队列。原始会话历史 `messagesForQuery` 会保留，备用模型仍要根据同一段上下文重新回答。

这个分支不需要发 Tombstone。它由 `withRetry()` 连续收到 `529` 后触发，此时请求还没有建立出可消费的模型结果，REPL 中通常没有需要撤回的内容；Streaming Fallback 则可能已经向 REPL 产出消息，所以才需要 Tombstone。

两种 Fallback 处理的问题不同：

| 情况               | 模型         | 传输方式       | 目的                   |
| ------------------ | ------------ | -------------- | ---------------------- |
| Streaming Fallback | 不变         | 流式改为非流式 | 绕过流连接或流端点故障 |
| Model Fallback     | 切换备用模型 | 重新发起请求   | 绕过当前模型持续过载   |

这两种情况都在重做当前轮，因此不会增加 `turnCount`。

```javascript
turnCount
// Fallback 前 => 1
// Fallback 后 => 1
```

只有模型成功调用 Tool、Claude Code 得到 Tool Result 并进入下一轮时，`turnCount` 才会增加。

## 用户中断

一次查询只共享一个 `AbortSignal`，但触发它的不只 Esc。REPL 中可以直接看到三种主要的 `reason`：

- `user-cancel`：用户按 Esc 或取消当前任务；
- `interrupt`：新输入需要立即接管，先结束正在运行的这一轮；
- `background`：按 Ctrl+B，把前台任务交给后台会话继续。

本节只展开最常见的 `user-cancel`。另外，`StreamingToolExecutor` 内部还有 `sibling_error` 和 `streaming_fallback` 等 Tool 取消原因，它们不等于用户中断，会在工具系统中解释。

下面以「模型正在输出时按下 Esc」为例。这个信号从 REPL 一直传到模型请求和 Tool 执行器。

### 1. 请求开始时创建中断信号

REPL 创建一个 `AbortController`，并把同一个 Controller 交给 `onQuery()`。`queryLoop()` 再把它的 `signal` 传给 `queryModel()`，最终交给 Anthropic SDK：

```javascript
// src/screens/REPL.tsx
const controller = createAbortController()
setAbortController(controller)
void onQuery(
  [initialMsg.message],
  controller,
  true, // shouldQuery
  [], // additionalAllowedTools
  mainLoopModel,
)

// src/query.ts
for await (const message of deps.callModel({
  signal: toolUseContext.abortController.signal,
  // 其他参数……
})) {
  // 消费模型消息
}

// src/services/api/claude.ts
const result = await anthropic.beta.messages
  .create(
    {
      // ...
      stream: true,
    },
    { signal },
  )
  .withResponse()

const stream = result.data

controller.signal.aborted
// => false
```

`AbortController` 可以理解成开关，`signal` 是这个开关的只读状态。各层拿到的是同一个 `signal`。

### 2. 用户按 Esc，REPL 改变信号

```javascript
// src/screens/REPL.tsx:2106-2150
function onCancel() {
  // ...
  abortController?.abort('user-cancel')
}

abortController.signal.aborted
// => true

abortController.signal.reason
// => 'user-cancel'
```

`signal.aborted` 不是网络错误，而是 REPL 明确发出的停止命令。

### 3. 模型流停止，但不执行 Fallback

SDK 正在通过 `for await` 返回流事件。`abort()` 以后，SDK 会终止流并抛出 `APIUserAbortError`：

```javascript
// src/services/api/claude.ts:2434-2451
async function* queryModel(/* ..., signal, ... */) {
  try {
    for await (const part of stream) {
      // 处理流事件
      // ...
    }
  } catch (streamingError) {
    if (streamingError instanceof APIUserAbortError) {
      if (signal.aborted) {
        throw streamingError
        // => 调用方主动中断，不执行 Fallback
      }

      throw new APIConnectionTimeoutError({
        message: 'Request timed out',
      })
      // => SDK 自身超时，转换错误类型后向上抛出
    }

    // 其他流式错误才会走到这里，
    // 再根据 disableFallback 决定是否改用非流式请求
    // ...
  }
}
```

这里不能只根据 `APIUserAbortError` 判断用户是否主动中断，还要检查传入的 `signal`：

- `signal.aborted === true`：调用方主动结束当前请求，直接向上抛出；
- `signal.aborted === false`：源码将它视为 SDK 自身的超时，转换成 `APIConnectionTimeoutError` 后向上抛出；
- 其他流式错误：再根据 `disableFallback` 决定是否改用非流式请求。

### 4. 为被中断的 Tool Use 补一条失败结果

假设按下 Esc 前，模型已经完整返回了下面这个 `Grep` Tool Use：

```javascript
{
  type: 'tool_use',
  id: 'toolu_01',
  name: 'Grep',
  input: {
    pattern: 'login|auth',
    path: 'src',
  },
}
```

此时不能只结束循环，否则会留下一个「模型要求执行 Tool，却永远没有结果」的半截记录。在未启用流式 Tool 执行器的分支中，`queryLoop()` 会补出下面这条失败的 Tool Result：

```javascript
{
  type: 'tool_result',
  tool_use_id: 'toolu_01',
  is_error: true,
  content: 'Interrupted by user',
}
```

`tool_use.id` 和 `tool_result.tool_use_id` 相同，表示这条结果对应上面的 `Grep` 请求。这里不是继续执行 `Grep`，只是记录它因为用户中断而没有完成。

源码根据是否启用了流式 Tool 执行器选择结果来源：

```javascript
// src/query.ts:1011-1051
async function* queryLoop(/* ... */) {
  if (toolUseContext.abortController.signal.aborted) {
    if (streamingToolExecutor) {
      for await (const update of streamingToolExecutor.getRemainingResults()) {
        if (update.message) {
          yield update.message
          // => 收集已经完成的结果，
          //    或执行器为中断 Tool 生成的失败结果
        }
      }
    } else {
      yield* yieldMissingToolResultBlocks(
        assistantMessages,
        'Interrupted by user',
      )
      // => Tool 尚未交给流式执行器，
      //    直接扫描消息并补失败结果
    }

    return {
      reason: 'aborted_streaming',
    }
  }

  // 未中断时继续处理 Tool
  // ...
}
```

`getRemainingResults()` 不是重新执行 Tool。它只是把执行器队列中已经完成的结果取出来，并为排队中或执行到一半的 Tool 生成失败结果。如果中断前还没有出现完整的 `tool_use`，这里就没有内容需要补。

这里先理解它们共同解决的问题：**即使执行被中断，已经产生的 `tool_use` 也要有对应的 `tool_result`。** `yieldMissingToolResultBlocks()` 怎样查找缺失结果，`StreamingToolExecutor` 怎样管理排队、执行与中断，以及 `getRemainingResults()` 怎样收尾，会放到后边的文章展开。

最终结果取决于按下中断键的时机：

- 模型仍在流式输出：收尾后返回 `aborted_streaming`；
- 模型已经输出完，正在执行 Tool：停止 Tool 后返回 `aborted_tools`。

两种情况都不会 Fallback，因为 `signal.aborted` 表示用户已经明确要求停止任务。

中断沿调用链返回时，`queryModel()` 的 `finally` 还会停止 `api_call` 活跃标记，并调用 `releaseStreamResources()` 终止 SDK Stream、取消 HTTP Response body。这只是模型请求层的收尾，不是 Claude Code 的完整资源清理清单。

## 小结

沿着源码走完以后，最初的黑盒终于展开了：API 增量被包装成 `StreamEvent` 供 REPL 临时显示；同一批增量也会累积到 `contentBlocks`，形成 `AssistantMessage`，再由 `queryLoop()` 识别 Tool Use。

如果其他流式错误进入 Streaming Fallback，Claude Code 会改用非流式请求，使用 Tombstone 撤销旧消息，再接收新的完整消息；用户主动中断则直接结束。

再回看上一篇的代码：

```javascript
// src/query.ts
async function* queryLoop(/* ... */) {
  // ...

  for await (
    const message of deps.callModel(/* ... */)
  ) {
    yield message
    // => 把实时事件和完整消息都交给上层

    if (message.type === 'assistant') {
      assistantMessages.push(message)
      // => 只有完整消息进入 Agent 正式状态
    }
  }

  // ...
}
```

到这里，`callModel()` 在 Agent 主循环中的作用也就清楚了。

Claude Code 处理的仍然是熟悉的工程问题。流式数据怎么拼装，失败后怎么重试或回滚，用户中断后怎么收尾，资源什么时候释放——这些在普通业务开发中也会遇到。不同之处只是 Agent 的一次任务链路更长，还会调用 Tool 修改文件、执行命令，因此发生异常时，需要处理的中间状态更多。
