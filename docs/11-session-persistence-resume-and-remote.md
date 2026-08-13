---
title: "11、一段会话怎样保存、恢复与续写"
---

前面的主循环一直围绕内存中的 `messages` 工作。用户消息、模型返回的 `tool_use`、Tool Result 都会追加进去。当前 `claude` 进程退出后，这个数组就会消失；但执行 `claude --resume <sessionId>` 后，Claude Code 又能接着原来的任务继续运行。

在 `/Users/me/shop` 中输入「检查 `src/auth/login.ts` 的登录逻辑」。模型决定读取文件，`Read` 返回文件内容。此时退出终端，再执行：

```bash
运行时值，不属于函数体：终端传给 src/main.tsx::run() 的命令行参数。
claude --resume 5b7f5415-6e0d-4f41-a0a6-a778b4a02e11
```

恢复过程中的同一批数据会经过三个位置：

1. REPL 内存中的 `messages`；
2. 磁盘中的 `.jsonl` Transcript；
3. 恢复后传回 REPL 的初始 `messages`。

![图 1：本地会话写入与恢复](https://windliangblog.oss-cn-beijing.aliyuncs.com/11-session-persistence-resume-and-remote-diagram-01.png)

## 1. 先固定：退出前内存里到底有什么

下面三条是一次「用户提问 → 模型请求 Read → Read 返回结果」结束后，REPL 中与本次任务相关的消息。后面的保存和恢复都围绕这三条记录展开。

```javascript
// 运行时值，不属于函数体：src/screens/REPL.tsx::REPL() 持有的 messages。
[
  {
    type: 'user',
    uuid: 'user_ask_01',
    message: {
      role: 'user',
      content: '检查 src/auth/login.ts 的登录逻辑',
    },
  },
  {
    type: 'assistant',
    uuid: 'assistant_read_01',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_read_01',
          name: 'Read',
          input: {
            file_path: '/Users/me/shop/src/auth/login.ts',
          },
        },
      ],
    },
  },
  {
    type: 'user',
    uuid: 'user_read_result_01',
    sourceToolAssistantUUID: 'assistant_read_01',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_read_01',
          content: 'export async function login() { return { ok: true } }',
        },
      ],
    },
  },
]
```

`messages` 适合当前进程实时追加和渲染，却不适合跨进程保存。Claude Code 没有在每次变化时把整个数组重写到文件，而是把每条需要保存的消息写成一条独立记录。

## 2. JSONL：一行一条记录

会话文件名由当前 session ID 决定。

源码位置：`src/utils/sessionStorage.ts:202-208`

```javascript
// 函数体：src/utils/sessionStorage.ts::getTranscriptPath()
export function getTranscriptPath() {
  const projectDir =
    getSessionProjectDir() ??
    getProjectDir(getOriginalCwd())
  // => '/Users/me/.claude/projects/-Users-me-shop'

  // => '/Users/me/.claude/projects/-Users-me-shop/5b7f5415-6e0d-4f41-a0a6-a778b4a02e11.jsonl'
  return join(projectDir, `${getSessionId()}.jsonl`)
}
```

JSONL 是 JSON Lines：文件中每一行都是一份独立 JSON 对象，不是一个包住全部消息的 JSON 数组。上面三条内存消息写入后，文件中相应的核心记录可以看成这样：

```javascript
// 运行时值，不属于函数体：src/utils/sessionStorage.ts::SessionStorage.appendEntry() 追加到 JSONL 的三行内容。
{"uuid":"user_ask_01","parentUuid":null,"type":"user","message":{"role":"user","content":"检查 src/auth/login.ts 的登录逻辑"}}
{"uuid":"assistant_read_01","parentUuid":"user_ask_01","type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_read_01","name":"Read","input":{"file_path":"/Users/me/shop/src/auth/login.ts"}}]}}
{"uuid":"user_read_result_01","parentUuid":"assistant_read_01","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_read_01","content":"export async function login() { return { ok: true } }"}]}}
```

这里多出的关键字段是 `parentUuid`：

- `assistant_read_01` 指向用户问题 `user_ask_01`；
- `user_read_result_01` 指向发起 `Read` 的助手消息 `assistant_read_01`。

因此，这三行不仅是按时间排列的日志，也构成了一条可反向追溯的消息链。

## 3. 新消息怎样从 REPL 进入 JSONL

REPL 组件使用 `useLogMessages()` 记录会话。`messages` 变化后，Hook 的 Effect 不会每次都把完整数组交给存储层；它记住上次已处理的长度，只切出新增尾部。

源码位置：`src/screens/REPL.tsx:3829`、`src/hooks/useLogMessages.ts:19-131`

先假设第一条用户消息已经写入。这一轮 `Read` 完成后，数组从 1 条增长到 3 条。

```javascript
// 函数体：src/hooks/useLogMessages.ts::useLogMessages()
export function useLogMessages(
  messages, // => 3 条：user_ask_01、assistant_read_01、user_read_result_01
  ignore = false, // => false
) {
  const lastRecordedLengthRef = useRef(0) // 当前值 => 1
  const lastParentUuidRef = useRef(undefined) // 当前值 => 'user_ask_01'
  const firstMessageUuidRef = useRef(undefined) // 当前值 => 'user_ask_01'

  useEffect(() => {
    const currentFirstUuid = messages[0]?.uuid // => 'user_ask_01'
    const previousLength = lastRecordedLengthRef.current // => 1
    const isIncremental =
      currentFirstUuid !== undefined &&
      currentFirstUuid === firstMessageUuidRef.current &&
      previousLength <= messages.length
    // => true

    const startIndex = isIncremental ? previousLength : 0 // => 1
    const slice = messages.slice(startIndex)
    // => [
    //   { type: 'assistant', uuid: 'assistant_read_01', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_read_01', name: 'Read', input: { file_path: '/Users/me/shop/src/auth/login.ts' } }] } },
    //   { type: 'user', uuid: 'user_read_result_01', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read_01', content: 'export async function login() { return { ok: true } }' }] } },
    // ]
    const parentHint = isIncremental
      ? lastParentUuidRef.current
      : undefined
    // => 'user_ask_01'

    void recordTranscript(
      slice,
      {},
      parentHint,
      messages,
    ).then(lastRecordedUuid => {
      // => 'user_read_result_01'
      if (lastRecordedUuid && !isIncremental) {
        lastParentUuidRef.current = lastRecordedUuid
      }
    })

    const last = cleanMessagesForLogging(
      slice,
      messages,
    ).findLast(isChainParticipant)
    // => { type: 'user', uuid: 'user_read_result_01', ... }
    if (last && isIncremental) {
      lastParentUuidRef.current = last.uuid
      // => 'user_read_result_01'
    }

    lastRecordedLengthRef.current = messages.length
    // => 3
    // ...
  }, [messages, ignore])
}
```

这段代码的输入和输出可以直接对应：

| 进入 Hook 前 | 这次取出的 `slice` | 下一批记录使用的 `parentHint` |
| --- | --- | --- |
| 已经保存 `user_ask_01` | `assistant_read_01`、`user_read_result_01` | `lastParentUuidRef.current = 'user_read_result_01'` |

下一次再新增消息时，`parentHint` 就从 `user_read_result_01` 开始。`void` 让 UI 不必等待磁盘操作；增量路径同时从这次 `slice` 中找出最后一个可接入链的消息，立刻更新 `lastParentUuidRef`，所以后续一批记录仍知道自己该接在谁后面。

## 4. 一份 Tool Result 怎样变成可恢复的记录

第 3 节停在「新增消息交给 `recordTranscript()`」。继续向下看，会经过三个连续动作：

```text
模型的 Tool Use
  → Tool 执行完成，创建 Tool Result 消息
  → recordTranscript() 跳过已经写过的消息
  → insertMessageChain() 为新消息写入 parentUuid
```

先看第一个动作。`runToolUse()` 执行 `Read` 时，同时拿到模型的 Tool Use 和承载它的助手消息。执行完成后，它把一条 Tool Result 消息加入本轮结果；这条消息带着发起本次 Tool Use 的助手消息 UUID。

源码位置：`src/services/tools/toolExecution.ts:337-341`、`src/services/tools/toolExecution.ts:1457-1466`

记录这次变更的 `slice` 因而包含下面两条消息。接下来的 `recordTranscript()` 不再处理 Tool 执行，只负责把它们保存下来。

源码位置：`src/utils/sessionStorage.ts:1408-1447`

```javascript
// 函数体：src/utils/sessionStorage.ts::recordTranscript()
export async function recordTranscript(
  messages, // => 两条新增消息：assistant_read_01、user_read_result_01
  teamInfo, // => {}
  startingParentUuidHint, // => 'user_ask_01'
  allMessages, // => [user_ask_01, assistant_read_01, user_read_result_01]
) {
  const cleanedMessages = cleanMessagesForLogging(
    messages,
    allMessages,
  )
  // => 两条新增消息：assistant_read_01、user_read_result_01
  const sessionId = getSessionId()
  // => '5b7f5415-6e0d-4f41-a0a6-a778b4a02e11'
  const messageSet = await getSessionMessages(sessionId)
  // => Set(['user_ask_01'])
  const newMessages = []
  // => []
  let startingParentUuid = startingParentUuidHint
  // => 'user_ask_01'
  let seenNewMessage = false
  // => false

  for (const message of cleanedMessages) {
    if (messageSet.has(message.uuid)) {
      if (!seenNewMessage && isChainParticipant(message)) {
        startingParentUuid = message.uuid
      }
    } else {
      newMessages.push(message)
      seenNewMessage = true
    }
  }
  // 此时 newMessages 的 UUID => ['assistant_read_01', 'user_read_result_01']
  // 此时 startingParentUuid => 'user_ask_01'

  if (newMessages.length > 0) {
    await getProject().insertMessageChain(
      newMessages,
      false,
      undefined,
      startingParentUuid,
      teamInfo,
    )
  }

  return newMessages.findLast(isChainParticipant)?.uuid
    ?? startingParentUuid
    ?? null
}
```

当前例子里两条消息都是新 UUID，所以循环直接把它们放入 `newMessages`。函数最后真正交给下一层的数据等价于：

```javascript
// 运行时值，不属于函数体：src/utils/sessionStorage.ts::recordTranscript() 传给 SessionStorage.insertMessageChain() 的实参。
[
  [
    {
      type: 'assistant',
      uuid: 'assistant_read_01',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_read_01',
          name: 'Read',
          input: { file_path: '/Users/me/shop/src/auth/login.ts' },
        }],
      },
    },
    {
      type: 'user',
      uuid: 'user_read_result_01',
      sourceToolAssistantUUID: 'assistant_read_01',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_read_01',
          content: 'export async function login() { return { ok: true } }',
        }],
      },
    },
  ],
  false,
  undefined,
  'user_ask_01',
]
```

如果前半段已经在 JSONL 中出现，`messageSet` 会跳过它，并把最后一条可接入链的旧消息更新为 `startingParentUuid`。

`insertMessageChain()` 随后逐条写入，并在每一次写完后更新下一个父节点。

源码位置：`src/utils/sessionStorage.ts:993-1094`

```javascript
// 函数体：src/utils/sessionStorage.ts::SessionStorage.insertMessageChain()
async insertMessageChain(
  messages, // => [assistant_read_01, user_read_result_01]
  isSidechain = false, // => false
  agentId, // => undefined
  startingParentUuid, // => 'user_ask_01'
  teamInfo, // => {}
) {
  let parentUuid = startingParentUuid ?? null
  // => 'user_ask_01'

  for (const message of messages) {
    let effectiveParentUuid = parentUuid
    // 第 1 次循环 => 'user_ask_01'

    if (
      message.type === 'user' &&
      'sourceToolAssistantUUID' in message &&
      message.sourceToolAssistantUUID
    ) {
      effectiveParentUuid = message.sourceToolAssistantUUID
    }
    // 第 2 次循环中：
    // sourceToolAssistantUUID => 'assistant_read_01'
    // effectiveParentUuid => 'assistant_read_01'

    // 紧凑边界的单独写法与当前正常保存路径无关。
    // ...
    const transcriptMessage = {
      parentUuid: effectiveParentUuid,
      isSidechain,
      agentId,
      ...message,
      cwd: getCwd(),
      sessionId: getSessionId(),
    }
    // 第 1 次写入的关键字段：
    // { uuid: 'assistant_read_01', parentUuid: 'user_ask_01', type: 'assistant' }
    // 第 2 次写入的关键字段：
    // { uuid: 'user_read_result_01', parentUuid: 'assistant_read_01', type: 'user' }

    await this.appendEntry(transcriptMessage)
    if (isChainParticipant(message)) {
      parentUuid = message.uuid
      // 第 1 次循环后 => 'assistant_read_01'
      // 第 2 次循环后 => 'user_read_result_01'
    }
  }
}
```

两次循环只是在写两条消息：先写 `assistant_read_01`，它的父节点是已有的 `user_ask_01`；再写 `user_read_result_01`，它的父节点明确是 `assistant_read_01`。

默认情况下，循环变量 `parentUuid` 会在每次写完后移到刚写入的消息。

```javascript
let effectiveParentUuid = parentUuid
if (
  message.type === 'user' &&
  'sourceToolAssistantUUID' in message &&
  message.sourceToolAssistantUUID
) {
  effectiveParentUuid = message.sourceToolAssistantUUID
}
```

上面第 2 次循环本应把 Tool Result 接到当前的 `parentUuid`；上边的 `sourceToolAssistantUUID` 分支改写了这一点，强制把 `effectiveParentUuid` 设为发起这次 Tool Use 的助手消息 UUID。单个 `Read` 的两个值刚好同为 `assistant_read_01`。下面看一下并行 Tool Ues 的情况。

### 同一条助手消息包含两个 Tool Use 时

非流式模型响应可以在同一条助手消息中放入多个 Tool Use。假设 `assistant_tools_01` 同时包含一次 `Grep` 和一次 `Read`，两个结果都是对这条消息的回复，因此会写成：

```text
assistant_tools_01
  ├─ user_grep_result_01   parentUuid = assistant_tools_01
  └─ user_read_result_01   parentUuid = assistant_tools_01
```

这两条 Tool Result 的 `parentUuid` 相同是正常的：`parentUuid` 表示「回复哪条助手消息」，不是 JSONL 中的唯一值，也不是文件中的上一行。

如果 `insertMessageChain()` 只使用循环中的 `parentUuid`，第一个结果写完后会把它更新为 `user_grep_result_01`；第二个结果就会错误地接到第一个结果后面。创建 Tool Result 时保存的 `sourceToolAssistantUUID` 让两个结果都能回到 `assistant_tools_01`，不受 Tool 完成顺序影响。

这两个分支写完后，下一条消息接在哪里取决于 `messages` 数组中的顺序。假设数组中 `user_read_result_01` 排在最后，`useLogMessages()` 会把它记为下一次增量写入的 `parentHint`；下一条助手消息就接在它后面：

```text
assistant_tools_01
  ├─ user_grep_result_01   parentUuid = assistant_tools_01
  └─ user_read_result_01   parentUuid = assistant_tools_01
       └─ assistant_answer_01   parentUuid = user_read_result_01
```

因此，只沿一条 `parentUuid` 往回走并不能覆盖所有并行分支，会漏掉兄弟分支。第 6 节的 `buildConversationChain()` 先重建主链，随后 `recoverOrphanedParallelToolResults()` 再补回同一轮遗漏的助手内容和 Tool Result。

`appendEntry()` 才是落盘前最后一层。普通会话消息会先按 UUID 去重，再进入 `enqueueWrite()` 队列；这个队列按顺序把一行 JSON 追加到文件末尾。

源码位置：`src/utils/sessionStorage.ts:1128-1288`

```javascript
// 函数体：src/utils/sessionStorage.ts::SessionStorage.appendEntry()
async appendEntry(
  entry, // => { uuid: 'user_read_result_01', type: 'user', isSidechain: false }
  sessionId = getSessionId(), // => '5b7f5415-6e0d-4f41-a0a6-a778b4a02e11'
) {
  const currentSessionId = getSessionId()
  const isCurrentSession = sessionId === currentSessionId
  // => true
  let sessionFile

  if (isCurrentSession) {
    if (this.sessionFile === null) {
      this.pendingEntries.push(entry)
      return
    }
    sessionFile = this.sessionFile
    // => '/Users/me/.claude/projects/-Users-me-shop/5b7f5415-6e0d-4f41-a0a6-a778b4a02e11.jsonl'
  } else {
    const existing = await this.getExistingSessionFile(sessionId)
    if (!existing) return
    sessionFile = existing
  }

  // 前面还会处理 summary、title 等不需要 UUID 去重的记录。
  // ...
  const messageSet = await getSessionMessages(sessionId)
  // => Set(['user_ask_01', 'assistant_read_01'])
  const isAgentSidechain =
    entry.isSidechain && entry.agentId !== undefined
  // => false
  const isNewUuid = !messageSet.has(entry.uuid)
  // => true

  if (isAgentSidechain || isNewUuid) {
    const targetFile = isAgentSidechain
      ? getAgentTranscriptPath(entry.agentId)
      : sessionFile
    // => '/Users/me/.claude/projects/-Users-me-shop/5b7f5415-6e0d-4f41-a0a6-a778b4a02e11.jsonl'

    void this.enqueueWrite(targetFile, entry)
    // => 向 5b7f5415-6e0d-4f41-a0a6-a778b4a02e11.jsonl 追加 user_read_result_01

    if (!isAgentSidechain) {
      messageSet.add(entry.uuid)
      // => Set(['user_ask_01', 'assistant_read_01', 'user_read_result_01'])
    }
  }
}
```

因此，保存不是「定时把整段对话序列化」，每一条已完成消息只需写一次。

## 5. `--resume` 不是直接打开文件，而是先还原一份可用会话

重新启动进程后，内存里的 `messages` 是空的。`main.tsx::run()` 先验证命令行中的 session ID，随后加载旧会话、恢复运行状态，最后把恢复结果传给 `launchRepl()`。

源码位置：`src/main.tsx:3667-3733`

```javascript
// 函数体：src/main.tsx::run()
async function run() {
  // options.resume => '5b7f5415-6e0d-4f41-a0a6-a778b4a02e11'
  // ...
  let processedResume
  // => undefined
  const maybeSessionId = validateUuid(options.resume)
  // => '5b7f5415-6e0d-4f41-a0a6-a778b4a02e11'

  if (maybeSessionId) {
    const sessionId = maybeSessionId
    // => '5b7f5415-6e0d-4f41-a0a6-a778b4a02e11'
    const result = await loadConversationForResume(
      sessionId,
      undefined,
    )
    // => {
    //   sessionId: '5b7f5415-6e0d-4f41-a0a6-a778b4a02e11',
    //   fullPath: '/Users/me/.claude/projects/-Users-me-shop/5b7f5415-6e0d-4f41-a0a6-a778b4a02e11.jsonl',
    //   messages: [user_ask_01, assistant_read_01, user_read_result_01],
    // }
    if (!result) {
      return await exitWithError(root, 'No conversation found')
    }

    processedResume = await processResumedConversation(
      result,
      {
        forkSession: false,
        sessionIdOverride: sessionId,
        transcriptPath: result.fullPath,
      },
      resumeContext,
    )
    // => { messages: [user_ask_01, assistant_read_01, user_read_result_01], initialState: { ... } }
  }

  // run() 后面统一处理已经恢复成功的会话。
  // ...
  const resumeData = processedResume
  // => { messages: [user_ask_01, assistant_read_01, user_read_result_01], initialState: { ... } }
  if (resumeData) {
    await launchRepl(root, {
      initialState: resumeData.initialState,
      // ...
    }, {
      ...sessionConfig,
      initialMessages: resumeData.messages,
    }, renderAndRun)
    // REPL 初始 messages => [user_ask_01, assistant_read_01, user_read_result_01]
  }
}
```

`loadConversationForResume()` 是「命令行 ID」和「恢复后的消息数组」之间的桥。字符串 ID 进入时，它没有自行拼消息，而是转交 `getLastSessionLog()`；拿到链之后，才反序列化未完成的 Tool Use，并补上 Resume Hook 产生的消息。

源码位置：`src/utils/conversationRecovery.ts:456-607`

```javascript
// 函数体：src/utils/conversationRecovery.ts::loadConversationForResume()
export async function loadConversationForResume(
  source, // => '5b7f5415-6e0d-4f41-a0a6-a778b4a02e11'
  sourceJsonlFile, // => undefined
) {
  let log = null
  let messages = null
  let sessionId

  if (typeof source === 'string') {
    log = await getLastSessionLog(source)
    // => { messages: [user_ask_01, assistant_read_01, user_read_result_01], fullPath: '/Users/me/.claude/projects/-Users-me-shop/5b7f5415-6e0d-4f41-a0a6-a778b4a02e11.jsonl' }
    sessionId = source
    // => '5b7f5415-6e0d-4f41-a0a6-a778b4a02e11'
  }

  if (!log && !messages) return null

  if (log) {
    // 轻量会话记录会先在这里补全；本例已经是完整记录。
    // ...
    messages = log.messages
    // => [user_ask_01, assistant_read_01, user_read_result_01]
    checkResumeConsistency(messages)
  }

  const deserialized = deserializeMessagesWithInterruptDetection(messages)
  // => { messages: [user_ask_01, assistant_read_01, user_read_result_01], turnInterruptionState: undefined }
  messages = deserialized.messages

  const hookMessages = await processSessionStartHooks('resume', { sessionId })
  // => []
  messages.push(...hookMessages)

  return {
    messages,
    sessionId,
    fullPath: log?.fullPath,
    // ...
  }
}
```

`--continue` 的路径也会调用 `loadConversationForResume()`，区别只是它把 `undefined` 传入，让加载器从最近会话中挑一个可继续的记录。后面「恢复消息 → 交给 REPL」的主线相同。

恢复阶段接着处理一件事：`loadConversationForResume()` 怎样从一份可能有旧分支的 JSONL 中选出这三条消息？

## 6. 恢复不是「取文件最后几行」，而是沿父节点回到根

`--resume <sessionId>` 传入字符串 ID 时，`loadConversationForResume()` 会调用 `getLastSessionLog(sessionId)`。后者一次读入该 session 的记录，先找到主会话最后一条消息；本例就是 `user_read_result_01`。这条记录随后作为起点，沿 `parentUuid` 向前找出应恢复的整条消息链。

源码位置：`src/utils/conversationRecovery.ts:456-545`、`src/utils/sessionStorage.ts:3869-3931`

```javascript
// 函数体：src/utils/sessionStorage.ts::getLastSessionLog()
export async function getLastSessionLog(
  sessionId, // => '5b7f5415-6e0d-4f41-a0a6-a778b4a02e11'
) {
  const { messages } = await loadSessionFile(sessionId)
  // => Map {
  //   'user_ask_01' => { uuid: 'user_ask_01', parentUuid: null, type: 'user' },
  //   'assistant_read_01' => { uuid: 'assistant_read_01', parentUuid: 'user_ask_01', type: 'assistant' },
  //   'user_read_result_01' => { uuid: 'user_read_result_01', parentUuid: 'assistant_read_01', type: 'user' },
  // }

  const lastMessage = findLatestMessage(
    messages.values(),
    message => !message.isSidechain,
  )
  // => { uuid: 'user_read_result_01', parentUuid: 'assistant_read_01', type: 'user' }

  const transcript = buildConversationChain(
    messages,
    lastMessage,
  )
  // => [
  //   { uuid: 'user_ask_01', parentUuid: null, type: 'user' },
  //   { uuid: 'assistant_read_01', parentUuid: 'user_ask_01', type: 'assistant' },
  //   { uuid: 'user_read_result_01', parentUuid: 'assistant_read_01', type: 'user' },
  // ]

  return convertToLogOption(transcript, 0, /* ... */)
}
```

`buildConversationChain()` 的动作很直接：先从叶子 `user_read_result_01` 开始，沿 `parentUuid` 一路向前，收集顺序刚好是倒的；最后 `reverse()` 回到正常对话顺序。

源码位置：`src/utils/sessionStorage.ts:2069-2094`

```javascript
// 函数体：src/utils/sessionStorage.ts::buildConversationChain()
export function buildConversationChain(
  messages, // => 包含 user_ask_01、assistant_read_01、user_read_result_01 的 Map
  leafMessage, // => { uuid: 'user_read_result_01', parentUuid: 'assistant_read_01', type: 'user' }
) {
  const transcript = [] // => []
  const seen = new Set() // => Set()
  let currentMessage = leafMessage
  // => { uuid: 'user_read_result_01', parentUuid: 'assistant_read_01', type: 'user' }

  while (currentMessage) {
    if (seen.has(currentMessage.uuid)) {
      break
    }
    seen.add(currentMessage.uuid)
    transcript.push(currentMessage)
    currentMessage = currentMessage.parentUuid
      ? messages.get(currentMessage.parentUuid)
      : undefined
    // 第 1 次循环后 => { uuid: 'assistant_read_01', parentUuid: 'user_ask_01', type: 'assistant' }
    // 第 2 次循环后 => { uuid: 'user_ask_01', parentUuid: null, type: 'user' }
    // 第 3 次循环后 => undefined
  }

  transcript.reverse()
  // => [user_ask_01, assistant_read_01, user_read_result_01]
  return recoverOrphanedParallelToolResults(
    messages,
    transcript,
    seen,
  )
}
```

这就是 `parentUuid` 存在的理由。JSONL 只负责不断追加，文件中可以留下压缩前记录或旧的并行分支；恢复阶段不依赖「最后几行恰好正确」，而是选择最新叶子，再取出它真正依赖的祖先链。

`recoverOrphanedParallelToolResults()` 是这一步后面的补全处理。一次模型回答可能包含多个并行 Tool Use，单条父指针无法经过每一个同轮分支；源码会把第 4 节提到的两个 Tool User 并行时遗漏的助手内容和 Tool Result 补回。当前例子只有一个 `Read`，因此上面的三条链已经完整。

## 7. 消息恢复后，还要接管旧会话

如果只把历史消息传回 REPL，后续消息会写进本次启动时新生成的 session 文件，`--resume` 就变成了「读取旧历史、写入新历史」。`processResumedConversation()` 负责避免这种断开：非 fork 模式下先切换到旧 session ID，再重新指向旧的 JSONL 文件。

源码位置：`src/utils/sessionRestore.ts:409-485`

```javascript
// 函数体：src/utils/sessionRestore.ts::processResumedConversation()
export async function processResumedConversation(
  result, // => { sessionId: '5b7f5415-6e0d-4f41-a0a6-a778b4a02e11', fullPath: '/Users/me/.claude/projects/-Users-me-shop/5b7f5415-6e0d-4f41-a0a6-a778b4a02e11.jsonl', messages: [user_ask_01, assistant_read_01, user_read_result_01] }
  opts, // => { forkSession: false, sessionIdOverride: '5b7f5415-6e0d-4f41-a0a6-a778b4a02e11', transcriptPath: '/Users/me/.claude/projects/-Users-me-shop/5b7f5415-6e0d-4f41-a0a6-a778b4a02e11.jsonl' }
  context, // => { initialState: undefined }
) {
  if (!opts.forkSession) {
    const sid = opts.sessionIdOverride ?? result.sessionId
    // => '5b7f5415-6e0d-4f41-a0a6-a778b4a02e11'

    switchSession(
      asSessionId(sid),
      opts.transcriptPath ? dirname(opts.transcriptPath) : null,
    )
    // 当前进程的 sessionId => '5b7f5415-6e0d-4f41-a0a6-a778b4a02e11'

    await renameRecordingForSession()
    await resetSessionFilePointer()
    restoreCostStateForSession(sid)
    // ...
    restoreWorktreeForResume(result.worktreeSession)
    adoptResumedSessionFile()
    // 之后 appendEntry() 的目标文件 =>
    // '/Users/me/.claude/projects/-Users-me-shop/5b7f5415-6e0d-4f41-a0a6-a778b4a02e11.jsonl'
  }

  return {
    messages: result.messages,
    // => [user_ask_01, assistant_read_01, user_read_result_01]
    fileHistorySnapshots: result.fileHistorySnapshots,
    contentReplacements: result.contentReplacements,
    // ...
    initialState: {
      ...context.initialState,
    },
  }
}
```

到这里，恢复才真正闭环：REPL 先拿到旧消息；存储层也重新指向旧文件。随后用户再输入「继续检查登录失败时是否写入审计日志」，新的用户消息就会接在 `user_read_result_01` 之后，继续追加到同一个 JSONL。

`--fork-session` 则走另一条路：它拿旧消息作为起点，但保留新 session ID，因此后续记录会写到新的 Transcript。`resume` 是续写旧会话，`fork` 是从旧会话另开一条历史。

## 小结

一段会话从运行到恢复，数据没有变成某种神秘的「历史对象」。它只是经历了三次形态变化：

1. REPL 用 `messages` 保存当前进程正在进行的对话；
2. `useLogMessages()` 取出新增部分，`recordTranscript()` 和 `insertMessageChain()` 用 UUID、`parentUuid` 将它们追加到 JSONL；
3. `--resume` 读回记录，从最新叶子沿 `parentUuid` 重建消息链，`processResumedConversation()` 接管旧文件，再交给 REPL。

这里真正需要维护的不是「把旧文本显示出来」，而是同一条历史的连续性：恢复出来的最后一条消息是谁，下一条消息应该接到谁后面，以及它们是否继续写入同一份会话文件。
