---
title: 6、上下文的发现、注入与压缩
---

前几篇的调用链已经走到 Agent 主循环、模型流、Tool 执行和权限判断。继续往下追，模型每一轮实际收到的内容，比聊天界面显示的内容多得多。

聊天界面里能看到用户消息、模型回答和 Tool Result，但这不是模型请求的全部内容。`CLAUDE.md`、当前日期、系统提示、Tools 定义以及压缩摘要，也会参与下一轮请求。

为了让后面的运行值保持一致，先固定运行目录和用户输入：

```javascript
const cwd = '/Users/me/shop'
const userInput = '检查 src/auth/login.ts 的登录逻辑'
```

这个目录中有三份指令文件：

`~/.claude/CLAUDE.md`：

> 所有回复使用中文。

`/Users/me/shop/CLAUDE.md`：

> 使用 pnpm 管理依赖。
> 修改代码后运行 pnpm test。

`/Users/me/shop/src/auth/CLAUDE.md`：

> 登录失败必须记录安全审计日志。

前两份文件会在 REPL 准备第一轮请求时进入 `userContext`。第三份位于 `src/auth` 子目录，此时不会加载；当 `Read` 读取同目录下的 `src/auth/login.ts` 后，它才以 `nested_memory` 附件进入下一轮消息。

顺着这次运行往下找，四个节点逐渐对上：

1. 第一轮请求前发现的 `CLAUDE.md`；
2. 项目指令进入模型请求的位置；
3. `src/auth/CLAUDE.md` 延迟出现的路径；
4. 长会话压缩后保留下来的工作状态。

## 先看完整执行顺序

![图 1：项目指令从发现到压缩的完整路径](https://windliangblog.oss-cn-beijing.aliyuncs.com/diagram-01.png)

图中的调用关系先暴露出三段生命周期：

- 第一轮请求前发现用户级和项目根目录的指令；
- 读取具体文件后，再补充那个目录下的局部指令；
- 历史消息接近上下文上限时，把旧对话压缩成摘要和状态附件。

## 先把模型请求里的三份上下文分开

沿着图继续进入 `callModel()`，会看到上下文没有保存在一个大字符串里，而是来自三份数据：

源码位置：`src/query.ts:657-672`

```javascript
async function* queryLoop(/* ... */) {
  // 前面已经得到 messagesForQuery、userContext 和 fullSystemPrompt
  // ...

  for await (const message of deps.callModel({
    systemPrompt: fullSystemPrompt,
    messages: prependUserContext(
      messagesForQuery,
      userContext,
    ),
    tools: toolUseContext.options.tools,
  })) {
    yield message
  }
}
```

- `fullSystemPrompt` 保存 Claude Code 自身的行为说明，并根据当前模式和已启用能力组装；
- `userContext` 保存 `CLAUDE.md`、当前日期等信息，调用模型前被包装成隐藏 User Message；
- `messagesForQuery` 保存用户消息、模型消息、Tool Result、局部规则附件和压缩摘要。

`tools` 又是独立的请求参数，里面是本轮可用 Tool 的名称、描述和输入 Schema。

后边实际上是在观察 `userContext` 与 `messagesForQuery` 怎样分别变化，最后又怎样在请求模型前合到一起。

## 第一轮请求前先出现了两份 `CLAUDE.md`

这一段调用链可以先压缩成一张图：

![图 2：第一轮请求前如何收集 CLAUDE.md](https://windliangblog.oss-cn-beijing.aliyuncs.com/diagram-03.png)

交互模式准备一轮请求时，REPL 并不亲自读取文件。它调用 `getUserContext()`，取得 `CLAUDE.md` 和当前日期，再把结果作为 `userContext` 传给 `query()`。

源码位置：`src/screens/REPL.tsx:2767-2805`

```javascript
async function onQuery(/* ... */) {
  const [
    ,
    ,
    defaultSystemPrompt,
    baseUserContext,
    systemContext,
  ] = await Promise.all([
    checkAndDisableBypassPermissionsIfNeeded(/* ... */),
    checkAndDisableAutoModeIfNeeded(/* ... */),
    getSystemPrompt(/* ... */),
    getUserContext(), // => baseUserContext.claudeMd 包含两份 CLAUDE.md
    getSystemContext(),
  ])

  const userContext = {
    ...baseUserContext,
    // 其他运行模式补充的字段省略
  }

  for await (const event of query({
    messages: messagesIncludingNewMessages,
    systemPrompt,
    userContext,
    // => 把 getUserContext() 的结果传入 Agent 主循环
    systemContext,
    canUseTool,
    toolUseContext,
    querySource: getQuerySourceForREPL(),
  })) {
    onQueryEvent(event)
  }
}
```

顺着它返回的 `baseUserContext` 回去，`CLAUDE.md` 最终落到 `getUserContext()`。

源码位置：`src/context.ts:152-188`

```javascript
export const getUserContext = memoize(
  async function getUserContext() {
    // 关闭 CLAUDE.md 的分支省略，本例会进入读取路径
    const memoryFiles = filterInjectedMemoryFiles(
      await getMemoryFiles(),
    )
    // => [
    //   {
    //     type: 'User',
    //     path: '/Users/me/.claude/CLAUDE.md',
    //     content: '所有回复使用中文。',
    //   },
    //   {
    //     type: 'Project',
    //     path: '/Users/me/shop/CLAUDE.md',
    //     content: '使用 pnpm 管理依赖。\n修改代码后运行 pnpm test。',
    //   },
    // ]

    const claudeMd = getClaudeMds(memoryFiles)

    return {
      claudeMd,
      currentDate: `Today's date is ${getLocalISODate()}.`,
    }
  },
)
```

`getUserContext()` 和内部的 `getMemoryFiles()` 都被 `memoize()` 包住。缓存未被重置时，后续请求不会重新扫描目录；配置、工作目录以及主线程压缩后的上下文重建等路径会清理缓存。

### 继续进入 `getMemoryFiles()`

源码位置：`src/utils/claudemd.ts:790-1026`

展开 `getMemoryFiles()` 后，先看与 `CLAUDE.md` 和 rules 直接相关的四类来源：

| 类型 | 常见位置 | 用途 |
| --- | --- | --- |
| `Managed` | 系统管理员配置的 `CLAUDE.md` 和 rules | 组织级指令 |
| `User` | `~/.claude/CLAUDE.md`、`~/.claude/rules/*.md` | 用户跨项目指令 |
| `Project` | 项目中的 `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md` | 团队共享的项目指令 |
| `Local` | `CLAUDE.local.md` | 不提交到仓库的个人项目指令 |

`getMemoryFiles()` 主要收集 `CLAUDE.md` 和 rules；Auto Memory 功能启用时，它还会加入 `MEMORY.md` 入口，Team Memory 也有对应分支。本文示例假设这些可选功能未启用，因此这一段只追踪 `CLAUDE.md`。后面压缩分支出现的 Session Memory 则由另一组模块维护。

项目目录不是只检查当前目录。`getMemoryFiles()` 从 `cwd` 向上查找父目录中的 `CLAUDE.md`、`.claude/CLAUDE.md` 和 rules；`processMemoryFile()` 负责真正读取文件，并用 `processedPaths` 避免同一路径被重复加入。

只保留本例会经过的 User 和 Project 分支：

源码位置：`src/utils/claudemd.ts:790-927`

```javascript
export const getMemoryFiles = memoize(
  async () => {
    const result = []
    const processedPaths = new Set()
    const includeExternal = false
    // => 本例没有批准项目指令引用工作目录外的文件

    // 1. 读取用户级指令
    const userClaudeMd = getMemoryPath('User')
    // => '/Users/me/.claude/CLAUDE.md'
    result.push(
      ...await processMemoryFile(
        userClaudeMd,
        'User',
        processedPaths,
        true,
      ),
    )

    // 2. 从 cwd 一直收集到文件系统根目录
    const dirs = []
    let currentDir = getOriginalCwd()
    // => '/Users/me/shop'

    while (currentDir !== parse(currentDir).root) {
      dirs.push(currentDir)
      currentDir = dirname(currentDir)
    }
    // dirs.reverse() 中与本例有关的部分
    // => ['/Users', '/Users/me', '/Users/me/shop']

    // 3. 从父目录向 cwd 查找项目指令
    for (const dir of dirs.reverse()) {
      const projectPath = join(dir, 'CLAUDE.md')

      result.push(
        ...await processMemoryFile(
          projectPath,
          'Project',
          processedPaths,
          includeExternal,
        ),
      )
    }

    return result
  },
)
```

源码位置：`src/utils/claudemd.ts:424-434`、`618-675`

```javascript
export async function processMemoryFile(
  filePath,
  type,
  processedPaths,
  includeExternal,
) {
  // includeExternal => Project 分支中为 false
  // => @include 指向工作目录外时不继续加载

  const normalizedPath =
    normalizePathForComparison(filePath)

  if (processedPaths.has(normalizedPath)) {
    return []
  }
  processedPaths.add(normalizedPath)

  const { resolvedPath } = safeResolvePath(
    getFsImplementation(),
    filePath,
  )

  const { info: memoryFile } =
    await safelyReadMemoryFileAsync(
      filePath,
      type,
      resolvedPath,
    )

  if (!memoryFile || !memoryFile.content.trim()) {
    return []
  }

  // @include 等分支省略
  return [memoryFile]
}
```

本例的 `cwd` 是 `/Users/me/shop`，因此向上查找时会命中 `/Users/me/shop/CLAUDE.md`。这两层函数的内部还要处理设置开关、`@include`、符号链接和权限错误，但对本次调用链来说，关键输出就是代码注释中的两个文件对象。

`getMemoryFiles()` 返回结构化数组后，`getClaudeMds()` 只做最后一步格式化：把每个文件的路径、来源和正文拼成 `userContext.claudeMd`。它不再扫描目录，也不改变规则内容。

同样只保留本例中的 User 和 Project 分支：

源码位置：`src/utils/claudemd.ts:1153-1195`

```javascript
export const getClaudeMds = memoryFiles => {
  const memories = []

  for (const file of memoryFiles) {
    if (!file.content) continue

    const description = file.type === 'Project'
      ? ' (project instructions, checked into the codebase)'
      : " (user's private global instructions for all projects)"

    memories.push(
      `Contents of ${file.path}${description}:\n\n` +
      file.content.trim(),
    )
  }

  return `${MEMORY_INSTRUCTION_PROMPT}\n\n` +
    memories.join('\n\n')
}

// => userContext.claudeMd 中包含：
// Contents of /Users/me/.claude/CLAUDE.md: ...
// Contents of /Users/me/shop/CLAUDE.md: ...
```

到这里，第一轮请求前的准备已经结束：REPL 调用 `getUserContext()`，`getMemoryFiles()` 找到用户级和项目根目录规则，`getClaudeMds()` 把它们合并成一段上下文。

这条路径只向父目录查找，不会递归进入 `src/auth`，因此局部的 `src/auth/CLAUDE.md` 尚未出现。源码形成了两种加载时机：用户级和根目录规则在准备第一轮请求时加载，子目录规则碰到相关文件后再加载。

## 请求模型前，`prependUserContext()` 拼装消息

`getClaudeMds()` 返回后，`getUserContext()` 再补上当前日期。回到 `queryLoop()` 时，已经有两份数据：`messagesForQuery` 保存原始对话，`userContext` 保存刚才生成的项目指令和日期。

```javascript
const messagesForQuery = [
  {
    type: 'user',
    uuid: 'user_01',
    message: {
      role: 'user',
      content: '检查 src/auth/login.ts 的登录逻辑',
    },
  },
]

const userContext = {
  claudeMd,
  currentDate: "Today's date is 2026-08-04.",
}
```

`callModel()` 没有直接接收 `messagesForQuery`。源码先调用 `prependUserContext()`：

源码位置：`src/query.ts:657-672`

```javascript
async function* queryLoop(/* ... */) {
  // 前面已经得到 messagesForQuery、userContext 和 fullSystemPrompt
  // ...

  for await (const message of deps.callModel({
    messages: prependUserContext(
      messagesForQuery,
      userContext,
    ),
    systemPrompt: fullSystemPrompt,
    tools: toolUseContext.options.tools,
  })) {
    yield message
  }
}
```

继续进入 `prependUserContext()`。

源码位置：`src/utils/api.ts:449-474`

```javascript
export function prependUserContext(
  messages,
  context,
) {
  // 本例运行到这里时：
  // context => {
  //   claudeMd: `Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.
  //
  // Contents of /Users/me/.claude/CLAUDE.md (user's private global instructions for all projects):
  //
  // 所有回复使用中文。
  //
  // Contents of /Users/me/shop/CLAUDE.md (project instructions, checked into the codebase):
  //
  // 使用 pnpm 管理依赖。
  // 修改代码后运行 pnpm test。`,
  //   currentDate: "Today's date is 2026-08-04.",
  // }

  if (process.env.NODE_ENV === 'test') {
    return messages
  }

  if (Object.entries(context).length === 0) {
    return messages
  }

  return [
    createUserMessage({
      content: `<system-reminder>
As you answer the user's questions, you can use the following context:
${Object.entries(context)
  .map(([key, value]) => `# ${key}\n${value}`)
  .join('\n')}

IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.
</system-reminder>`,
      isMeta: true,
    }),
    ...messages,
  ]
}
```

`Object.entries(context)` 把 `claudeMd` 和 `currentDate` 分别转换成 `# claudeMd`、`# currentDate` 两段文字；`createUserMessage()` 再把整段内容包装成 `isMeta` User Message。

`isMeta` 是 Claude Code 在消息外层保存的标记。消息列表会跳过它，因此界面上不会出现一条新的用户消息；发送 API 时，`userMessageToMessageParam()` 仍会取出其中的 `role` 和 `content`，所以模型可以读到这段上下文。

源码位置：`src/components/Messages.tsx:125-158`、`src/services/api/claude.ts:588-623`

```javascript
// Messages.tsx：不把 Meta User Message 显示在消息列表中
if (msg.type === 'user') {
  return !msg.isMeta
}

// claude.ts：发送模型时保留它的实际内容
return {
  role: 'user',
  content: message.message.content,
}
```

拼装后的消息数组如下：

```javascript
const messagesForModel = [
  {
    type: 'user',
    isMeta: true,
    uuid: 'meta_01',
    timestamp: '2026-08-04T08:00:00.000Z',
    message: {
      role: 'user',
      content: `<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.

Contents of /Users/me/.claude/CLAUDE.md (user's private global instructions for all projects):

所有回复使用中文。

Contents of /Users/me/shop/CLAUDE.md (project instructions, checked into the codebase):

使用 pnpm 管理依赖。
修改代码后运行 pnpm test。
# currentDate
Today's date is 2026-08-04.
IMPORTANT: this context may or may not be relevant to your tasks.
</system-reminder>`,
    },
  },
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

调用前，`CLAUDE.md` 位于 `userContext.claudeMd`；调用后，它已经变成 `messagesForModel[0]` 中的 `<system-reminder>` 文本。`messagesForModel[1]` 仍是用户原来输入的消息。

## `Read` 之后，怎样找到 `src/auth/CLAUDE.md`

项目根目录的 `CLAUDE.md` 在第一轮请求前加载，子目录中的 `CLAUDE.md` 则沿实际访问过的文件路径加载。本例经过三个阶段：

```javascript
FileReadTool.callInner()
// 读取 login.ts，并记录它的完整路径

queryLoop() -> getAttachmentMessages()
// Tool 执行结束后，开始收集本轮产生的附件

getAttachments()
  -> getNestedMemoryAttachments()
  -> getNestedMemoryAttachmentsForFile()
  -> getMemoryFilesForNestedDirectory()
// 依次检查 src 和 src/auth 中的 CLAUDE.md 与 rules
```

### 第一步：`Read` 返回文件内容，同时记录路径

模型选择 `Read` 读取用户指定的文件：

```javascript
Read({
  file_path: '/Users/me/shop/src/auth/login.ts',
})
```

源码位置：`src/tools/FileReadTool/FileReadTool.ts:1019-1085`

```javascript
async function callInner(/* ... */) {
  const { content, lineCount, totalLines } =
    await readFileInRange(
      resolvedFilePath,
      lineOffset,
      limit,
      limit === undefined ? maxSizeBytes : undefined,
      context.abortController.signal,
    )
  // resolvedFilePath => '/Users/me/shop/src/auth/login.ts'
  // content => login.ts 的源码文本

  context.nestedMemoryAttachmentTriggers?.add(
    fullFilePath,
  )
  // fullFilePath => '/Users/me/shop/src/auth/login.ts'
  // nestedMemoryAttachmentTriggers
  // => Set { '/Users/me/shop/src/auth/login.ts' }

  return {
    data: {
      type: 'text',
      file: {
        filePath: file_path,
        content,
        numLines: lineCount,
        totalLines,
      },
    },
  }
}
```

`return` 中的 `data` 会变成正常的 Read Tool Result，里面是 `login.ts` 的内容。`nestedMemoryAttachmentTriggers` 保存的是另一份信息：本轮实际访问了哪个路径。

### 第二步：`getAttachmentMessages()` 消费 Read 记录的路径

`queryLoop()` 先收集 Read Tool Result，再调用 `getAttachmentMessages()` 收集由本轮行为触发的附件。

源码位置：`src/query.ts:1380-1400`、`1535-1590`，`src/utils/attachments.ts:743-1021`、`2167-2194`、`2937-2967`

```javascript
async function* queryLoop(/* ... */) {
  for await (const update of toolUpdates) {
    if (update.message) {
      toolResults.push(
        ...normalizeMessagesForAPI(
          [update.message],
          toolUseContext.options.tools,
        ).filter(message => message.type === 'user'),
      )
      // => Read Tool Result，内容是 login.ts 源码
    }
  }

  for await (const attachment of getAttachmentMessages(
    null,
    updatedToolUseContext,
    null,
    queuedCommandsSnapshot,
    [...messagesForQuery, ...assistantMessages, ...toolResults],
    querySource,
  )) {
    toolResults.push(attachment)
  }
}
```

`queryLoop()` 与目录扫描之间还有三层调用：`getAttachmentMessages()` 统一输出附件，`getAttachments()` 汇总各种附件来源，`getNestedMemoryAttachments()` 消费 Read 留下的路径。

```javascript
export async function* getAttachmentMessages(
  input,
  toolUseContext,
  ideSelection,
  queuedCommands,
  messages,
  querySource,
) {
  const attachments = await getAttachments(
    input,
    toolUseContext,
    ideSelection,
    queuedCommands,
    messages,
    querySource,
  )
  // attachments => [{
  //   type: 'nested_memory',
  //   path: '/Users/me/shop/src/auth/CLAUDE.md',
  //   content: { content: '登录失败必须记录安全审计日志。' },
  // }]

  for (const attachment of attachments) {
    yield createAttachmentMessage(attachment)
  }
}

export async function getAttachments(/* ... */) {
  const abortController = createAbortController()
  const context = {
    ...toolUseContext,
    abortController,
  }

  const allThreadAttachments = [
    // 其他附件来源……
    maybe(
      'nested_memory',
      () => getNestedMemoryAttachments(context),
    ),
    // 其他附件来源……
  ]

  const threadAttachmentResults =
    await Promise.all(allThreadAttachments)

  return threadAttachmentResults.flat()
}

async function getNestedMemoryAttachments(toolUseContext) {
  if (
    !toolUseContext.nestedMemoryAttachmentTriggers ||
    toolUseContext.nestedMemoryAttachmentTriggers.size === 0
  ) {
    return []
  }

  const appState = toolUseContext.getAppState()
  const attachments = []

  for (
    const filePath of
      toolUseContext.nestedMemoryAttachmentTriggers
  ) {
    // filePath => '/Users/me/shop/src/auth/login.ts'
    const nestedAttachments =
      await getNestedMemoryAttachmentsForFile(
        filePath,
        toolUseContext,
        appState,
      )

    attachments.push(...nestedAttachments)
  }

  toolUseContext.nestedMemoryAttachmentTriggers.clear()
  return attachments
}
```

`getAttachmentMessages()` 是所有附件的统一出口；`getNestedMemoryAttachments()` 才负责取出 Read 记录的文件路径。处理完成后清空 `nestedMemoryAttachmentTriggers`，避免下一轮再次处理同一路径。

### 第三步：沿文件路径查找局部规则

源码位置：`src/utils/attachments.ts:1656-1689`、`1792-1862`，`src/utils/claudemd.ts:1249-1317`

```javascript
async function getNestedMemoryAttachmentsForFile(
  filePath,
  toolUseContext,
) {
  const attachments = []
  const processedPaths = new Set()
  const { nestedDirs } = getDirectoriesToProcess(
    filePath,
    '/Users/me/shop',
  )
  // filePath => '/Users/me/shop/src/auth/login.ts'
  // nestedDirs => ['/Users/me/shop/src', '/Users/me/shop/src/auth']

  for (const dir of nestedDirs) {
    const memoryFiles = await getMemoryFilesForNestedDirectory(
      dir,
      filePath,
      processedPaths,
    )
    // dir === '/Users/me/shop/src'      => []
    // dir === '/Users/me/shop/src/auth' => [src/auth/CLAUDE.md]

    attachments.push(
      ...memoryFilesToAttachments(memoryFiles, toolUseContext, filePath),
    )
  }

  return attachments
}

export async function getMemoryFilesForNestedDirectory(
  dir,
  targetPath,
  processedPaths,
) {
  const projectPath = join(dir, 'CLAUDE.md')
  // projectPath => '/Users/me/shop/src/auth/CLAUDE.md'

  const result = await processMemoryFile(
    projectPath,
    'Project',
    processedPaths,
    false,
  )
  // result => [{
  //   path: '/Users/me/shop/src/auth/CLAUDE.md',
  //   content: '登录失败必须记录安全审计日志。',
  // }]

  return result
}
```

这条路径把 `src`、`src/auth` 依次交给规则加载函数，因此访问 `login.ts` 时会补入 `src/auth/CLAUDE.md`。源码还会在这些目录中检查 `.claude/CLAUDE.md`、`CLAUDE.local.md` 和 `.claude/rules`。

## Tool 执行结束后，下一轮先整理消息再请求模型

上一节停在 `Read` Tool 返回文件内容和局部 `CLAUDE.md`。这一轮结束时，`queryLoop()` 把模型消息与 Tool 结果一起写进 `state.messages`：

源码位置：`src/query.ts:268-279`、`1714-1728`

```javascript
async function* queryLoop(params) {
  let state = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
    autoCompactTracking: undefined,
    stopHookActive: undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    turnCount: 1,
    pendingToolUseSummary: undefined,
    transition: undefined,
  }

  while (true) {
    // 本轮请求模型并执行 Tool
    // ...

    const next = {
      messages: [
        ...messagesForQuery,
        ...assistantMessages,
        ...toolResults,
      ],
      // 本例新增的 toolResults 包含：
      // 1. login.ts 的文件内容
      // 2. src/auth/CLAUDE.md 的 nested_memory 附件
      toolUseContext: toolUseContextWithQueryTracking,
      autoCompactTracking: tracking,
      turnCount: nextTurnCount,
      // 其他循环状态……
    }

    state = next
    // 随后回到 while (true) 顶部，开始下一轮
  }
}
```

回到循环顶部后，这批消息不会立刻交给模型。下面只保留 `queryLoop()` 中与消息流有关的赋值和调用，用来确定执行顺序；每个函数的完整参数和运行值放在对应编号的小节中。

源码位置：`src/query.ts:306-468`、`551-552`、`659-664`、`820-859`

```javascript
async function* queryLoop(params) {
  // state 已经携带上一轮的 Assistant Message 和 Tool Result
  while (true) {
    let { toolUseContext } = state
    const { messages } = state

    let messagesForQuery = [
      ...getMessagesAfterCompactBoundary(messages),
    ]

    // ① 限制同一条 User Message 中 Tool Result 的总大小
    messagesForQuery = await applyToolResultBudget(
      messagesForQuery,
      toolUseContext.contentReplacementState,
      // 其余参数在第一层展开
    )

    // ② 判断本轮是否需要产生新的 Snip
    if (feature('HISTORY_SNIP')) {
      const result =
        snipModule.snipCompactIfNeeded(messagesForQuery)
      messagesForQuery = result.messages
    }

    // ③ 清理较早的 Tool Result
    const microcompactResult = await deps.microcompact(
      messagesForQuery,
      toolUseContext,
      querySource,
    )
    messagesForQuery = microcompactResult.messages

    // ④ 用已有的局部摘要替换一段历史
    if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
      const result =
        await contextCollapse.applyCollapsesIfNeeded(
          messagesForQuery,
          toolUseContext,
          querySource,
        )
      messagesForQuery = result.messages
    }

    const fullSystemPrompt = asSystemPrompt(
      appendSystemContext(systemPrompt, systemContext),
    )

    // ⑤ 仍然超过阈值时，对整个上下文做 Auto Compact
    const { compactionResult } = await deps.autocompact(
      messagesForQuery,
      // 其余参数在第五层展开
    )

    if (compactionResult) {
      messagesForQuery =
        buildPostCompactMessages(compactionResult)
    }

    const assistantMessages = []
    const toolResults = []

    for await (const message of deps.callModel({
      messages: prependUserContext(
        messagesForQuery,
        userContext,
      ),
      systemPrompt: fullSystemPrompt,
      tools: toolUseContext.options.tools,
    })) {
      yield message

      if (message.type === 'assistant') {
        assistantMessages.push(message)
      }

      // 后续 Tool 执行代码把结果写入 toolResults
    }

    // 一轮结束后，再把新结果写进 state，重复同一条路径
  }
}
```

至此，调用框架已经闭合：上一轮结果进入 `state.messages`，经过 ①～⑤ 得到 `messagesForQuery`，再传给 `callModel()`；新一轮产生的消息和 Tool Result 又写回 `state.messages`。后面的五个小节分别展开 ①～⑤。

在进入第一层前，`getMessagesAfterCompactBoundary()` 先从 `state.messages` 得到本轮视图 `messagesForQuery`。如果此前没有压缩边界，它返回全部消息；如果已经压缩过，它从最后一个边界开始截取。边界消息本身暂时保留，稍后由 `normalizeMessagesForAPI()` 过滤，不会直接发给模型。

`HISTORY_SNIP` 启用时，这一步还会应用前几轮已经形成的 Snip 标记；② `snipCompactIfNeeded()` 判断的则是本轮是否需要产生新标记。

后面的运行值沿用同一个例子：同一轮并行执行了七个 Bash Tool，每个 Tool Result 约 `29000` 字符，合并后的 User Message 大约包含 `203000` 字符；经过前几层后，整段消息仍约占 `169400` token。

### ① Tool Result Budget 先处理单轮突然出现的大输出

`querySource` 表示这次 `query()` 是从哪里发起、用于什么任务。它不是用户输入的内容，而是调用方传入的来源标签。例如，主线程交互、子 Agent、会话摘要和自动压缩会使用不同的值。

当前例子来自交互界面。REPL 调用 `query()` 时，通过 `getQuerySourceForREPL()` 生成这个值：

源码位置：`src/screens/REPL.tsx:2793-2801`、`src/utils/promptCategory.ts:36-49`

```javascript
// src/screens/REPL.tsx
for await (const event of query({
  messages: messagesIncludingNewMessages,
  systemPrompt,
  userContext,
  systemContext,
  canUseTool,
  toolUseContext,
  querySource: getQuerySourceForREPL(),
})) {
  onQueryEvent(event)
}

// src/utils/promptCategory.ts
export function getQuerySourceForREPL() {
  const settings = getSettings_DEPRECATED()
  const style =
    settings?.outputStyle ?? DEFAULT_OUTPUT_STYLE_NAME
  // style => 'default'

  if (style === DEFAULT_OUTPUT_STYLE_NAME) {
    // 本例从这里返回
    return 'repl_main_thread'
  }

  const isBuiltIn = style in OUTPUT_STYLE_CONFIG
  return isBuiltIn
    ? `repl_main_thread:outputStyle:${style}`
    : 'repl_main_thread:outputStyle:custom'
}
```

所以本轮进入 `queryLoop()` 时，`querySource` 的值是 `repl_main_thread`。`agent:*` 表示 Agent 发起的请求；`repl_main_thread:*` 则仍属于主线程，只是可能附带输出风格等信息。

这一层实际经过四个函数：`queryLoop()` 准备参数，`applyToolResultBudget()` 接入预算功能，`enforceToolResultBudget()` 决定替换哪些结果，`buildReplacement()` 完成文件写入和预览生成。先从最外层看到的输入开始。

源码位置：`src/query.ts:369-394`、`src/utils/toolResultStorage.ts:769-935`

```javascript
async function* queryLoop(/* ... */) {
  const persistReplacements =
    querySource.startsWith('agent:') ||
    querySource.startsWith('repl_main_thread')
  // querySource => 'repl_main_thread'
  // persistReplacements => true
  // 这类会话支持恢复，需要记录本轮新增的替换映射

  // messagesForQuery 中与本次预算有关的内容大致如下：
  // [
  //   {
  //     type: 'assistant',
  //     uuid: 'assistant_01',
  //     message: {
  //       role: 'assistant',
  //       content: [
  //         { type: 'tool_use', id: 'toolu_bash_01', name: 'Bash', ... },
  //         ...,
  //         { type: 'tool_use', id: 'toolu_bash_07', name: 'Bash', ... },
  //       ],
  //     },
  //   },
  //   {
  //     type: 'user',
  //     uuid: 'user_tool_results_01',
  //     message: {
  //       role: 'user',
  //       content: [
  //         { type: 'tool_result', tool_use_id: 'toolu_bash_01', content: '约 29000 字符' },
  //         ...,
  //         { type: 'tool_result', tool_use_id: 'toolu_bash_07', content: '约 29001 字符' },
  //       ],
  //     },
  //   },
  // ]

  // contentReplacementState => {
  //   seenIds: Set(0) {},
  //   replacements: Map(0) {},
  // }

  const toolsWithoutFiniteLimit = new Set(
    toolUseContext.options.tools
      .filter(tool =>
        !Number.isFinite(tool.maxResultSizeChars),
      )
      .map(tool => tool.name),
  )
  // toolsWithoutFiniteLimit => Set { 'Read' }
  // Read 的 maxResultSizeChars => Infinity
  // 它通过自己的读取 token 上限约束输出，不参加这次总量预算

  messagesForQuery = await applyToolResultBudget(
    // 参数 1：本轮准备发给模型的消息视图
    messagesForQuery,

    // 参数 2：跨轮保存「见过哪些结果、替换过哪些结果」
    toolUseContext.contentReplacementState,

    // 参数 3：可选的恢复记录回调
    persistReplacements
      ? records => void recordContentReplacement(
          records,
          toolUseContext.agentId,
        )
      : undefined,
    // => 本例传入 recordContentReplacement()

    // 参数 4：不参加总量预算的 Tool 名称
    toolsWithoutFiniteLimit,
  )
  // 返回值仍是完整的 Message[]。
  // 其中 toolu_bash_01 ～ toolu_bash_06 保留原文，
  // toolu_bash_07.content 变为 <persisted-output> 路径和预览。
}

// 本例进入函数前：
// 同一个 User Message 中有 7 个 Bash Tool Result
// 每个约 29000 字符，总计约 203000 字符
// 默认单个 User Message 的总预算是 200000 字符
```

`recordContentReplacement()` 只把 `toolUseId → 替换文本` 写进会话记录，供 `/resume` 恢复使用，不参与预算计算和 Tool Result 原文落盘。

`queryLoop()` 调用的是 `applyToolResultBudget()`。继续进入这个函数，才会看到负责统计大小和选择结果的 `enforceToolResultBudget()`：

源码位置：`src/utils/toolResultStorage.ts:924-935`

```javascript
export async function applyToolResultBudget(
  messages,
  state,
  writeToTranscript,
  skipToolNames,
) {
  // 这个函数只负责接入和返回，不负责挑选 Tool Result。
  // messages => 上面那份完整 Message[]
  // state => {
  //   seenIds: Set(0) {},
  //   replacements: Map(0) {},
  // }
  // writeToTranscript => records => recordContentReplacement(records, undefined)
  // skipToolNames => Set(1) { 'Read' }

  if (!state) {
    // contentReplacementState 未创建，说明功能没有启用
    // 直接返回原数组，不统计、不落盘
    return messages
  }

  // 内层负责计算预算并返回两份结果：
  // messages：替换后的模型消息视图
  // newlyReplaced：本次新产生、需要写入会话记录的映射
  const result = await enforceToolResultBudget(
    messages,
    state,
    skipToolNames,
  )
  // result.messages => 完整 Message[]，但 toolu_bash_07 已换成预览
  // result.newlyReplaced
  // => [{
  //   kind: 'tool-result',
  //   toolUseId: 'toolu_bash_07',
  //   replacement: '<persisted-output>...</persisted-output>',
  // }]

  if (result.newlyReplaced.length > 0) {
    // 可选回调只持久化「替换决定」；不参与预算计算
    writeToTranscript?.(result.newlyReplaced)
    // => 调用 queryLoop() 传入的 recordContentReplacement()
  }

  // 输出 => 替换后的完整 Message[]
  // queryLoop() 后续继续使用它请求模型
  return result.messages
}
```

`enforceToolResultBudget()` 算出总大小超过预算后，把选中的结果放进 `toPersist`，再逐个调用 `buildReplacement()`。抽出本例实际经过的分支，结构如下：

源码位置：`src/utils/toolResultStorage.ts:769-908`

```javascript
async function enforceToolResultBudget(
  messages,
  state,
  skipToolNames,
) {
  // 这个函数负责真正的预算计算和替换选择。
  // messages => 完整 Message[]
  // state => { seenIds: Set(0) {}, replacements: Map(0) {} }
  // skipToolNames => Set(1) { 'Read' }

  // 按最终发给 API 的 User Message 分组。
  // 并行 Tool Result 即使在 state 中分成多条消息，
  // 只要随后会被 API 格式合并，这里就放进同一组。
  const candidatesByMessage =
    collectCandidatesByMessage(messages)
  // collectCandidatesByMessage()：从消息中提取 tool_result，
  // 并按最终发给 API 的 User Message 分组。
  // => [[
  //   {
  //     toolUseId: 'toolu_bash_01',
  //     content: '第一个 Bash 的完整输出……',
  //     size: 29000,
  //   },
  //   ...,
  //   {
  //     toolUseId: 'toolu_bash_07',
  //     content: '第七个 Bash 的完整输出……',
  //     size: 29001,
  //   },
  // ]]

  // Tool Result 只有 tool_use_id，没有 Tool 名称。
  // 先从前面的 Assistant Tool Use 建立 ID → 名称映射，
  // 后面才能判断某个结果是否来自 Read。
  const nameByToolUseId =
    buildToolNameMap(messages)
  // buildToolNameMap()：从 assistant 的 tool_use 中建立 ID → Tool 名称。
  // => Map(7) {
  //   'toolu_bash_01' => 'Bash',
  //   ...,
  //   'toolu_bash_07' => 'Bash',
  // }
  // nameByToolUseId.get('toolu_bash_07') => 'Bash'

  const shouldSkip = toolUseId =>
    skipToolNames.has(
      nameByToolUseId.get(toolUseId) ?? '',
    )
  // skipToolNames => Set { 'Read' }
  // shouldSkip('toolu_bash_07') => false

  const limit = getPerMessageBudgetLimit()
  // getPerMessageBudgetLimit()：读取远程覆盖值；没有时返回源码常量。
  // limit => 200000

  // replacementMap：本次最终要替换到 messages 中的 ID → 文本
  // toPersist：本次还需要写文件的候选结果
  const replacementMap = new Map()
  const toPersist = []

  for (const candidates of candidatesByMessage) {
    const { mustReapply, frozen, fresh } =
      partitionByPriorDecision(candidates, state)
    // partitionByPriorDecision()：用 state 判断每个结果以前是否处理过。
    // mustReapply：以前已经替换过，本轮直接复用同一段预览
    // frozen：以前以完整原文发给过模型，本轮不能突然改成预览
    // fresh：第一次经过预算层，可以在本轮决定是否替换
    // 本例首次处理：
    // mustReapply => []
    // frozen => []
    // fresh => [toolu_bash_01, ..., toolu_bash_07]

    mustReapply.forEach(candidate => {
      replacementMap.set(
        candidate.toolUseId,
        candidate.replacement,
      )
    })

    // Read 等自行限制输出的 Tool 不参加这层总量计算。
    const eligible = fresh.filter(
      candidate => !shouldSkip(candidate.toolUseId),
    )
    // 本例 7 个结果都来自 Bash，因此 eligible.length => 7

    // frozen 内容已经被模型看过，只能保留原样，
    // 但仍要算进这一条 User Message 的现有大小。
    const frozenSize = frozen.reduce(
      (sum, candidate) => sum + candidate.size,
      0,
    )
    // => 0

    const freshSize = eligible.reduce(
      (sum, candidate) => sum + candidate.size,
      0,
    )
    // => 203000

    // 只有总量超过 200000 时才选择结果落盘。
    // selectFreshToReplace() 按大小从大到小选择，
    // 直到「frozen + 尚未替换的 fresh」回到预算内。
    const selected =
      frozenSize + freshSize > limit
        ? selectFreshToReplace(
            eligible,
            frozenSize,
            limit,
          )
        : []
    // selectFreshToReplace() 输入：
    // eligible => 7 个 Bash candidate
    // frozenSize => 0
    // limit => 200000
    // 它按 size 从大到小挑选，直到剩余总量不超过 limit。
    // 本例中 toolu_bash_07 略大于另外六个结果，因此先被选中。
    // selected => [{
    //   toolUseId: 'toolu_bash_07',
    //   content: '第七个 Bash 的完整输出……',
    //   size: 29001,
    // }]

    // 没有被选中的结果本轮将按原文发送，因此冻结这次决定。
    const selectedIds = new Set(
      selected.map(candidate => candidate.toolUseId),
    )
    candidates
      .filter(candidate =>
        !selectedIds.has(candidate.toolUseId),
      )
      .forEach(candidate =>
        state.seenIds.add(candidate.toolUseId),
      )
    // selectedIds => Set(1) { 'toolu_bash_07' }
    // state.seenIds 此时先记录六个保留原文的结果
    // => Set(6) { 'toolu_bash_01', ..., 'toolu_bash_06' }

    toPersist.push(...selected)
    // toPersist => [{
    //   toolUseId: 'toolu_bash_07',
    //   content: '第七个 Bash 的完整输出……',
    //   size: 29001,
    // }]
  }

  // 不同结果的文件互不依赖，可以并行落盘。
  // 这里只执行被 selected 选中的结果，本例只有一个。
  const freshReplacements = await Promise.all(
    toPersist.map(async candidate => [
      candidate,
      await buildReplacement(candidate),
    ]),
  )
  // buildReplacement()：把一个 candidate 落盘，并返回预览文本。
  // => [[
  //   {
  //     toolUseId: 'toolu_bash_07',
  //     content: '第七个 Bash 的完整输出……',
  //     size: 29001,
  //   },
  //   {
  //     content: '<persisted-output>...</persisted-output>',
  //     originalSize: 29001,
  //   },
  // ]]

  const newlyReplaced = []
  for (const [candidate, replacement] of freshReplacements) {
    // 文件写入完成后，再同时更新 seenIds 和 replacements，
    // 避免出现「已标记见过，却还没有替换文本」的中间状态。
    state.seenIds.add(candidate.toolUseId)

    if (replacement === null) {
      // 落盘失败时保留原始 Tool Result，不生成替换记录。
      continue
    }

    replacementMap.set(
      candidate.toolUseId,
      replacement.content,
    )
    state.replacements.set(
      candidate.toolUseId,
      replacement.content,
    )
    newlyReplaced.push({
      kind: 'tool-result',
      toolUseId: candidate.toolUseId,
      replacement: replacement.content,
    })
  }

  // 本次处理完成后的跨轮状态：
  // state.seenIds
  // => Set(7) {
  //   'toolu_bash_01', ..., 'toolu_bash_07'
  // }
  // state.replacements
  // => Map(1) {
  //   'toolu_bash_07' => '<persisted-output>...</persisted-output>'
  // }

  return {
    // 只替换 replacementMap 中命中的 Tool Result，
    // 其他消息和内容块保持不变。
    messages: replaceToolResultContents(
      messages,
      replacementMap,
    ),
    // replaceToolResultContents()：复制需要修改的消息和内容块，
    // 把 replacementMap 中命中的 tool_result.content 换成预览。
    // 输出仍是完整 Message[]，相关 User Message 变为：
    // {
    //   type: 'user',
    //   message: {
    //     role: 'user',
    //     content: [
    //       { type: 'tool_result', tool_use_id: 'toolu_bash_01', content: '原文……' },
    //       ...,
    //       {
    //         type: 'tool_result',
    //         tool_use_id: 'toolu_bash_07',
    //         content: '<persisted-output>路径和预览……</persisted-output>',
    //       },
    //     ],
    //   },
    // }
    // 只包含本次新替换，交给外层写入会话记录。
    newlyReplaced,
    // => [{
    //   kind: 'tool-result',
    //   toolUseId: 'toolu_bash_07',
    //   replacement: '<persisted-output>...</persisted-output>',
    // }]
  }
}
```

至此，调用顺序已经连起来：`queryLoop()` → `applyToolResultBudget()` → `enforceToolResultBudget()` → `buildReplacement()`。最后一个函数负责把原文落盘并生成替换文本：

源码位置：`src/utils/toolResultStorage.ts:728-737`

```javascript
async function buildReplacement(candidate) {
  // 输入 candidate => {
  //   toolUseId: 'toolu_bash_07',
  //   content: '第七个 Bash 的完整输出……',
  //   size: 29001,
  // }

  // 把这个 Tool Result 的完整 content 作为一个整体写入文件，
  // 文件名使用 tool_use_id，便于从预览定位回原结果。
  const result = await persistToolResult(
    candidate.content,
    candidate.toolUseId,
  )
  // persistToolResult()：创建 tool-results 目录，把完整 content 写入文件，
  // 同时截取最多前 2000 字节作为 preview。
  // result => {
  //   filepath: '/Users/me/.claude/projects/-Users-me-shop/session_01/tool-results/toolu_bash_07.txt',
  //   originalSize: 29001,
  //   isJson: false,
  //   preview: '测试输出的前一部分……',
  //   hasMore: true,
  // }

  if (isPersistError(result)) {
    // isPersistError(result) => false
    // 文件写入失败时返回 null；上层会继续保留原始内容。
    return null
  }

  return {
    // buildLargeToolResultMessage()：把路径、大小和 preview
    // 拼成最终放进模型消息的 <persisted-output> 文本。
    content: buildLargeToolResultMessage(result),
    // => `<persisted-output>
    // Output too large (28.3KB). Full output saved to: /Users/me/.claude/projects/-Users-me-shop/session_01/tool-results/toolu_bash_07.txt
    //
    // Preview (first 2KB):
    // 测试输出的前一部分……
    // ...
    // </persisted-output>`
    originalSize: result.originalSize,
    // => 29001
  }
  // 输出 => {
  //   content: '<persisted-output>...</persisted-output>',
  //   originalSize: 29001,
  // }
}
```

这里需要分开看「何时触发」和「替换谁」。预算按一条 User Message 中所有 Tool Result 的总大小触发，真正落盘和替换时仍以单个 Tool Result 为单位。

并行 Tool 产生的结果在内部可能是多条 User Message，但 `normalizeMessagesForAPI()` 会把相邻结果合并成一条发给 API。假设七个结果各有约 `29000` 字符，每一个单看都不算大，合并后却达到约 `203000` 字符。只检查单个结果，就会漏掉这种合计过大的情况。

超过总预算后，`selectFreshToReplace()` 从较大的新结果开始选择，直到剩余内容回到预算以内。本例只需把一个约 `29000` 字符的 Tool Result 落盘，其他六个仍保留原文。因此，这层不是把整条 User Message 一起存进文件，而是用总大小决定是否处理，再用 `tool_use_id` 精确替换其中的个别结果。

完整输出仍保存在文件中，模型看到的是文件路径和预览。`contentReplacementState` 按 `tool_use_id` 记录这次决定，后续轮次会继续使用同一份替换文本；源码用这种方式保持已经发送过的消息前缀不再变化。

单个结果的大小限制仍然存在，由具体 Tool 的 `maxResultSizeChars` 等机制处理；这一层补的是「多个结果分别不过大，合并后却过大」的情况。

`Read` 没有进入这次替换。传入的 `toolsWithoutFiniteLimit` 来自 `maxResultSizeChars === Infinity` 的 Tool；`Read` 自己已经通过读取 token 上限控制大小，不参加这层聚合预算。

### ② Snip 让模型主动清理旧消息

Snip 的主线很简单：消息发给模型前会附加短 ID，工具列表里同时提供 `SnipTool`。模型认为某段旧内容已经没用时，可以通过 ID 告诉 Snip Tool 删除哪些消息。

源码位置：`src/utils/messages.ts:1620-1635`、`src/tools.ts:243`

```javascript
const tag =
  `\n[id:${deriveShortMessageId(message.uuid)}]`
// message.uuid => '550e8400-e29b-41d4-a716-446655440000'
// tag => '\n[id:4ntnke]'

export function getAllBaseTools() {
  return [
    // 其他 Tool……
    ...(SnipTool ? [SnipTool] : []),
  ]
}
```

`queryLoop()` 随后调用 `snipCompactIfNeeded()`，把已经确定要删除的消息从本轮上下文中移除：

源码位置：`src/query.ts:396-410`

```javascript
let snipTokensFreed = 0

if (feature('HISTORY_SNIP')) {
  const snipResult =
    snipModule.snipCompactIfNeeded(
      messagesForQuery,
    )

  messagesForQuery = snipResult.messages
  // => 删除指定旧消息后的 Message[]

  snipTokensFreed = snipResult.tokensFreed
  // => 本次大约释放的 token 数

  if (snipResult.boundaryMessage) {
    yield snipResult.boundaryMessage
    // => 记录被删除消息的 UUID，供会话恢复使用
  }
}
```

源码中没有 `SnipTool` 和 `snipCompactIfNeeded()` 的核心实现，因此无法继续确认模型使用的判断提示词和删除边界。本例中 `HISTORY_SNIP === false`，这一层没有执行，`messagesForQuery` 原样进入 Microcompact。

### ③ Microcompact 只盯旧 Tool Result

`Microcompact` 是一次小范围清理：它不重写整段会话，只处理已经留在历史中的旧 Tool Result，减少这些工具输出继续占用的上下文。

先看 `queryLoop()` 交给它什么。这里的 `messagesForQuery` 已经依次经过 Tool Result Budget 和 Snip；本例中包含 7 个 Bash Tool Result，其中一个大结果已经被替换成「文件路径 + 预览」。

源码位置：`src/query.ts:412-426`

```javascript
async function* queryLoop(/* ... */) {
  // messagesForQuery.at(-1) => 包含 Tool Result 的 User Message
  // messagesForQuery.at(-1).message.content.length => 7
  // 这 7 个内容块都是 Bash Tool Result
  // querySource => 'repl_main_thread'
  // toolUseContext.options.mainLoopModel
  // => 'claude-sonnet-4-6'

  const microcompactResult = await deps.microcompact(
    messagesForQuery,
    toolUseContext,
    querySource,
  )
  // 本例没有触发清理：
  // microcompactResult => {
  //   messages: messagesForQuery,
  // }

  messagesForQuery = microcompactResult.messages
  // => 内容和数量都没有变化，继续交给下一层
}
```

`deps.microcompact` 默认指向 `microcompactMessages()`。顺着函数往下看，会依次尝试两条路径：先判断是否长时间没有继续会话，再判断能否通过 API 的缓存编辑能力删除旧结果。

源码位置：`src/services/compact/microCompact.ts:253-303`

```javascript
export async function microcompactMessages(
  messages,
  toolUseContext,
  querySource,
) {
  // messages => queryLoop() 传入的 Message[]
  // querySource => 'repl_main_thread'

  // 路径一：会话间隔较长时，直接缩短本地旧 Tool Result
  const timeBasedResult =
    maybeTimeBasedMicrocompact(
      messages,
      querySource,
    )
  // 默认配置 enabled === false
  // 本例 timeBasedResult => null

  if (timeBasedResult) {
    // 若触发，返回的是已经替换过旧 Tool Result 的新消息数组
    return timeBasedResult
  }

  // 路径二：使用服务端 cache_edits 删除缓存中的旧 Tool Result
  if (feature('CACHED_MICROCOMPACT')) {
    const mod = await getCachedMCModule()
    const model =
      toolUseContext.options.mainLoopModel
    // model => 'claude-sonnet-4-6'

    if (
      mod.isCachedMicrocompactEnabled() &&
      mod.isModelSupportedForCacheEditing(model) &&
      isMainThreadSource(querySource)
    ) {
      return await cachedMicrocompactPath(
        messages,
        querySource,
      )
    }
  }

  // 两条路径都没有触发时，原样返回传入的 messages
  return { messages }
}
```

#### 时间触发路径：直接改短本地消息

默认配置关闭了这条路径。为了看清触发后的输入输出，假设远程配置将它打开，阈值仍为 60 分钟，并保留最近 5 个 Tool Result：

源码位置：`src/services/compact/timeBasedMCConfig.ts:25-33`、`src/services/compact/microCompact.ts:432-529`

```javascript
const TIME_BASED_MC_CLEARED_MESSAGE =
  '[Old tool result content cleared]'

function maybeTimeBasedMicrocompact(
  messages,
  querySource,
) {
  // 以下保留清理主线，省略日志和缓存状态重置。
  // 假设这次运行：
  // querySource => 'repl_main_thread'
  // config => {
  //   enabled: true,
  //   gapThresholdMinutes: 60,
  //   keepRecent: 5,
  // }
  // 距离最后一条 Assistant Message 已过去 70 分钟

  const trigger = evaluateTimeBasedTrigger(
    messages,
    querySource,
  )
  // trigger => {
  //   gapMinutes: 70,
  //   config: {
  //     enabled: true,
  //     gapThresholdMinutes: 60,
  //     keepRecent: 5,
  //   },
  // }

  if (!trigger) {
    return null
  }

  const compactableIds =
    collectCompactableToolIds(messages)
  // => [
  //   'toolu_bash_01',
  //   'toolu_bash_02',
  //   'toolu_bash_03',
  //   'toolu_bash_04',
  //   'toolu_bash_05',
  //   'toolu_bash_06',
  //   'toolu_bash_07',
  // ]

  const keepRecent = Math.max(
    1,
    trigger.config.keepRecent,
  )
  // keepRecent => 5

  const keepSet = new Set(
    compactableIds.slice(-keepRecent),
  )
  // keepSet => Set {
  //   'toolu_bash_03',
  //   'toolu_bash_04',
  //   'toolu_bash_05',
  //   'toolu_bash_06',
  //   'toolu_bash_07',
  // }

  const clearSet = new Set(
    compactableIds.filter(
      id => !keepSet.has(id),
    ),
  )
  // clearSet => Set {
  //   'toolu_bash_01',
  //   'toolu_bash_02',
  // }

  if (clearSet.size === 0) {
    return null
  }

  let tokensSaved = 0
  const result = messages.map(message => {
    if (
      message.type !== 'user' ||
      !Array.isArray(message.message.content)
    ) {
      return message
    }

    let touched = false
    const newContent =
      message.message.content.map(block => {
        if (
          block.type === 'tool_result' &&
          clearSet.has(block.tool_use_id) &&
          block.content !==
            TIME_BASED_MC_CLEARED_MESSAGE
        ) {
          tokensSaved +=
            calculateToolResultTokens(block)
          touched = true

          return {
            ...block,
            content:
              TIME_BASED_MC_CLEARED_MESSAGE,
          }
        }

        return block
      })

    if (!touched) {
      return message
    }

    return {
      ...message,
      message: {
        ...message.message,
        content: newContent,
      },
    }
  })

  if (tokensSaved === 0) {
    return null
  }

  // result 中 toolu_bash_01 和 toolu_bash_02：
  // content => '[Old tool result content cleared]'
  // 最近 5 个 Tool Result 仍保留原内容
  // 假设两个旧结果各占约 7000 tokens：
  // tokensSaved => 约 14000

  return { messages: result }
}
```

删除范围由消息顺序和 `keepRecent` 共同决定。`collectCompactableToolIds()` 先收集可压缩 Tool 的 ID，`slice(-keepRecent)` 固定保留最近 N 个，只有更早的结果会被替换。返回数组的结构不变，`tool_use_id` 也不变，变化的只有旧 `tool_result.content`。

#### Cached Microcompact

Agent 每轮都会再次提交历史消息。服务端缓存已经处理过的相同前缀，可以避免从头重复计算。缓存仍然有效时，Claude Code 不改本地会话记录，而是通过 API 的缓存编辑能力移除其中较旧的 Tool Result。

调用链只有三步：选出旧 Tool Result、生成 `cache_edits`、把删除指令带进随后的模型请求。服务端具体怎样维护缓存不在这份源码中。

源码位置：`src/services/compact/microCompact.ts:317-399`

```javascript
async function cachedMicrocompactPath(
  messages,
  querySource,
) {
  const mod = await getCachedMCModule()
  const state = ensureCachedMCState()

  const toolsToDelete =
    mod.getToolResultsToDelete(state)
  // => ['toolu_bash_01', 'toolu_bash_02']

  if (toolsToDelete.length > 0) {
    pendingCacheEdits =
      mod.createCacheEditsBlock(
        state,
        toolsToDelete,
      )
    // => 删除上述两个旧 Tool Result 的缓存编辑指令

    return {
      messages,
      // => 本地 Message[] 保持不变
      compactionInfo: {
        pendingCacheEdits: {
          deletedToolIds: toolsToDelete,
          // => ['toolu_bash_01', 'toolu_bash_02']
          // 其他统计字段省略
        },
      },
    }
  }

  return { messages }
}
```

`cachedMicrocompactPath()` 只生成删除指令。当前 `queryLoop()` 随后调用模型时，`queryModel()` 取出它，并由 `addCacheBreakpoints()` 放进本次 API 请求。

源码位置：`src/services/api/claude.ts:1528-1532`、`1699-1709`

```javascript
async function* queryModel(/* ... */) {
  const consumedCacheEdits =
    consumePendingCacheEdits()
  // => 删除 toolu_bash_01、toolu_bash_02 的缓存编辑指令

  const paramsFromContext = retryContext => ({
    messages: addCacheBreakpoints(
      messagesForAPI,
      enablePromptCaching,
      options.querySource,
      useCachedMC,
      consumedCacheEdits,
      consumedPinnedEdits,
      options.skipCacheWrite,
    ),
    // 其他请求参数……
  })
}
```

本地 `messages` 虽然没有变化，`addCacheBreakpoints()` 生成的请求消息已经带上删除指令。API 会从模型继续使用的缓存上下文中移除指定的旧 Tool Result；`Grep`、`Bash` 等 Tool 本身不会被删除。

两条路径的区别至此已经足够：时间触发路径直接缩短本地 `messages`；Cached Microcompact 保留本地记录，通过 API 删除服务端缓存中的旧 Tool Result。

① 排在 ③ 前面。`src/query.ts:369-372` 的注释说明，Cached Microcompact 只按 `tool_use_id` 工作，因此不受内容替换影响；再结合时间触发路径会把旧 Tool Result 换成固定短文本，可以进一步看出，Tool Result Budget 在原文仍然完整时执行，才能决定是否落盘并生成预览。

本例中时间触发配置没有开启，Cached Microcompact 的条件也没有满足，所以最终走到 `return { messages }`。`microcompactResult.messages` 与这一层的输入相同，随后继续进入 Context Collapse。

### ④ Context Collapse 先尝试替换局部历史

前面三层主要缩短 Tool Result，Context Collapse 处理的则是一段完整历史。它做的事情可以先压缩成一句话：

> 原消息继续留在会话记录中，但发给模型时，可以用一条摘要替换一段旧消息。

假设 `messagesForQuery` 中有 24 条消息，第 5～14 条都是在搜索、读取和分析登录代码：

```javascript
// 替换前：模型要读取 24 条消息
messagesForQuery.length
// => 24

// 第 5～14 条，共 10 条
messagesForQuery.slice(4, 14)
// => [
//   Grep Tool Use,
//   Grep Tool Result,
//   Read Tool Use,
//   Read Tool Result,
//   ...,
// ]
```

这 10 条消息可以被下面一条摘要代替：

```javascript
const summaryContent =
  '<collapsed id="0000000000000001">' +
  '已定位登录入口，读取了认证配置和相关测试；' +
  '登录失败路径缺少安全审计日志。' +
  '</collapsed>'
```

因此，发给模型的消息从 24 条变成 15 条：

```javascript
// 24 条 - 被替换的 10 条 + 摘要 1 条
collapseResult.messages.length
// => 15
```

REPL 和会话文件中仍然保留原来的 24 条消息。15 条只是本轮请求模型时使用的较短版本，源码注释把它称为「projected view」，即投影视图。

#### 一份摘要会经历两个状态

继续看日志类型，可以看到 Context Collapse 没有生成摘要后立刻替换消息，而是分成了 `staged` 和 `committed`：

| 状态 | 含义 | 模型此时看到什么 |
| --- | --- | --- |
| `staged` | 摘要已经准备好，但还未启用 | 仍然是原来的 24 条消息 |
| `committed` | 摘要正式启用 | 第 5～14 条被摘要替换，共 15 条 |

`staged` 记录的是候选摘要及其覆盖范围。

源码位置：`src/types/logs.ts:272-296`

```javascript
const snapshot = {
  type: 'marble-origami-snapshot',
  sessionId: 'session_01',
  staged: [{
    startUuid: 'assistant_03',
    endUuid: 'user_12',
    summary:
      '已定位登录入口，读取了认证配置和相关测试；' +
      '登录失败路径缺少安全审计日志。',
    risk: 0.08,
    stagedAt: 1785888000000,
  }],
}
```

其中 `startUuid` 和 `endUuid` 圈出了将来可能被替换的连续消息。此时摘要只是备用，尚未改变 `messagesForQuery`。

需要释放上下文空间时，这份摘要会成为一条 Commit 记录：

源码位置：`src/types/logs.ts:255-270`

```javascript
const commit = {
  type: 'marble-origami-commit',
  sessionId: 'session_01',
  collapseId: '0000000000000001',
  summaryUuid: 'collapse_summary_01',
  summaryContent,
  summary:
    '已定位登录入口，读取了认证配置和相关测试；' +
    '登录失败路径缺少安全审计日志。',
  firstArchivedUuid: 'assistant_03',
  lastArchivedUuid: 'user_12',
}
```

`firstArchivedUuid` 和 `lastArchivedUuid` 表示「替换哪一段」，`summaryContent` 表示「换成什么」。Commit 不保存那 10 条原消息，因为原消息本来就留在会话记录中。

从这两个边界字段还能确定一个范围：**单次 Collapse 替换的是当前消息数组中的一个连续区间**，不是从不同位置随意挑出几条消息。一次会话可以产生多条 Commit，因此整体上仍然可能存在多个彼此分开的压缩区间。候选区间怎样选择、是否允许两个区间重叠，则要由当前源码包没有包含的 Context Collapse 模块决定。

#### `queryLoop()` 在哪里使用这份摘要

Context Collapse 位于 Microcompact 之后、Auto Compact 之前。

这里先看到了一个源码缺口。`query.ts` 通过条件加载取得 Context Collapse 模块：

源码位置：`src/query.ts:18-20`

```javascript
const contextCollapse = feature('CONTEXT_COLLAPSE')
  ? require('./services/contextCollapse/index.js')
  : null
```

调用处上方的源码注释写的是「生成已压缩的投影视图，并且可能提交更多 Collapse」。结合前面看到的 staged、Commit 和投影结果，可以把当前能够确认的输入与输出对应起来：

| 阶段 | 本例中的值 |
| --- | --- |
| 输入消息 | `messagesForQuery.length => 24` |
| 已准备的候选摘要 | `staged.length => 1` |
| 已经生效的摘要 | Commit 记录中的边界和 `summaryContent` |
| 本次可能发生的变化 | 根据上下文压力，把 staged 摘要提交成 Commit |
| 投影 | 按 Commit 用一条摘要替换一个连续消息区间 |
| 调用方使用的输出 | `collapseResult.messages.length => 15` |

源码位置：`src/query.ts:428-447`

```javascript
async function* queryLoop(/* ... */) {
  // Microcompact 处理完成后：
  // messagesForQuery.length => 24

  if (
    feature('CONTEXT_COLLAPSE') &&
    contextCollapse
  ) {
    const collapseResult =
      await contextCollapse.applyCollapsesIfNeeded(
        messagesForQuery,
        // => 24 条当前消息
        toolUseContext,
        // => 本轮 Tool、权限、状态等运行上下文
        querySource,
        // => 'repl_main_thread'
      )

    // 从调用处注释和日志类型能够确认：
    // 1. 它可能把 staged 中的候选摘要提交成 Commit；
    // 2. 它按 Commit 生成本轮使用的投影视图。
    // collapseResult.messages.length => 15

    messagesForQuery = collapseResult.messages
    // => 后面的 Auto Compact 和模型请求都读取这 15 条消息
  }
}
```

所以这段调用链可以直接读成：24 条完整消息进入 `applyCollapsesIfNeeded()`，其中 10 条旧消息被 1 条摘要替换，得到 15 条 `messagesForQuery`，再继续交给 Auto Compact 和模型请求。

源码还把 Commit 单独写入会话文件。恢复会话时，再根据两个边界 UUID 和摘要重建同一份投影视图，而不是永久删除原消息。对应位置是 `src/utils/sessionStorage.ts:1541-1575` 和 `src/utils/sessionRestore.ts:121-137`。

Context Collapse 放在 Auto Compact 前面也就容易理解了：局部替换已经把消息降到安全范围时，便不必再把整段历史压成一份总摘要。功能启用后，`shouldAutoCompact()` 会停止主动触发 Auto Compact，避免两套主动压缩同时运行。

源码位置：`src/services/compact/autoCompact.ts:201-223`

```javascript
if (feature('CONTEXT_COLLAPSE')) {
  const { isContextCollapseEnabled } =
    require('../contextCollapse/index.js')

  if (isContextCollapseEnabled()) {
    return false
    // => Context Collapse 已接管主动上下文管理
    // => 不再同时触发主动 Auto Compact
  }
}
```

正常路径到这里已经结束。还有一个异常分支：如果投影后的消息仍然超过模型上限，API 会返回 Prompt Too Long。`queryLoop()` 此时会把尚未启用的候选摘要全部提交，再用更短的投影视图重试一次。

源码位置：`src/query.ts:1066-1116`

```javascript
if (isWithheld413) {
  const drained =
    contextCollapse.recoverFromOverflow(
      messagesForQuery,
      querySource,
    )

  // 假设又启用了 2 份候选摘要：
  // drained.committed => 2
  // drained.messages.length => 11

  if (drained.committed > 0) {
    state = {
      messages: drained.messages,
      transition: {
        reason: 'collapse_drain_retry',
        committed: drained.committed,
      },
      // 其他 State 字段……
    }

    continue
    // => 回到主循环顶部，用 11 条消息重试本轮请求
  }
}
```

这次重试仍然过长时，`collapse_drain_retry` 会阻止重复排空候选摘要，后面再进入 Reactive Compact。

候选摘要怎样生成、怎样挑选历史片段以及 `risk` 怎样计算，位于当前源码包缺失的 `src/services/contextCollapse/` 中。从现有源码能够确认的是：候选摘要先进入 `staged`，提交后形成 Commit，`queryLoop()` 再据此生成不破坏原会话记录的投影视图。

### ⑤ Auto Compact 判断是否需要重建整段会话

前面的 Context Collapse 使用了 24 条消息的独立示例。现在回到本文一直跟踪的主运行：前四层处理结束后，`messagesForQuery` 仍有 126 条消息，估算为 `169400` token。

`queryLoop()` 把这组消息交给 `autoCompactIfNeeded()`。

源码位置：`src/query.ts:449-468`

```javascript
async function* queryLoop(/* ... */) {
  // Auto Compact 的主要输入：
  // messagesForQuery.length => 126
  // tokenCountWithEstimation(messagesForQuery) => 169400
  // toolUseContext.options.mainLoopModel => 'claude-sonnet-4-6'
  // querySource => 'repl_main_thread'
  // tracking => undefined，本会话尚未发生过 Auto Compact
  // snipTokensFreed => 0，前面的 Snip 没有删除消息

  const { compactionResult, consecutiveFailures } =
    await deps.autocompact(
      messagesForQuery,
      // => 需要判断和压缩的 126 条消息

      toolUseContext,
      // => 模型、Tool、权限、已读文件状态等会话依赖

      {
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        forkContextMessages: messagesForQuery,
      },
      // => 压缩模型复用主请求缓存时需要的参数

      querySource,
      tracking,
      snipTokensFreed,
    )

  // 本例超过阈值并且压缩成功：
  // compactionResult => {
  //   boundaryMarker: SystemMessage,
  //   summaryMessages: [UserMessage],
  //   attachments: [AttachmentMessage, ...],
  //   hookResults: [],
  //   preCompactTokenCount: 169400,
  //   truePostCompactTokenCount: 约 12400,
  // }
  // consecutiveFailures => 0
}
```

`autocompact()` 不会原地修改 `messagesForQuery`。没有达到阈值时，`compactionResult` 是 `undefined`；压缩成功时，它返回一组用于重建上下文的消息，`queryLoop()` 稍后再替换本地变量。

下面顺着这次调用看四个动作：计算阈值、选择压缩路径、生成摘要和附件、把结果送回 `queryLoop()`。

#### 第一步：计算本轮是否需要压缩

Auto Compact 的阈值不是完整的 Context Window。以本文的 `200000` token 模型为例，源码先为摘要输出预留 `20000` token，再留出 `13000` token 缓冲区。

源码位置：`src/services/compact/autoCompact.ts:28-90`

```javascript
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20000
const AUTOCOMPACT_BUFFER_TOKENS = 13000

export function getEffectiveContextWindowSize(model) {
  // model => 'claude-sonnet-4-6'

  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  // getMaxOutputTokensForModel(model) => 32000
  // reservedTokensForSummary => 20000

  const contextWindow =
    getContextWindowForModel(model, getSdkBetas())
  // contextWindow => 200000

  return contextWindow - reservedTokensForSummary
  // => 180000
}

export function getAutoCompactThreshold(model) {
  const effectiveContextWindow =
    getEffectiveContextWindowSize(model)
  // => 180000

  return effectiveContextWindow -
    AUTOCOMPACT_BUFFER_TOKENS
  // => 167000
}
```

本例假设环境变量覆盖和输出上限实验均未启用，因此 `getMaxOutputTokensForModel(model) => 32000`。这里省略的覆盖分支不影响本次计算。结果是：上下文估算达到 `167000` token 时便开始压缩，而不是等到 `200000` 才处理。否则压缩请求本身可能已经没有空间生成摘要。

`shouldAutoCompact()` 再把当前消息消耗与这个阈值比较。

源码位置：`src/services/compact/autoCompact.ts:160-239`

```javascript
export async function shouldAutoCompact(
  messages,
  model,
  querySource,
  snipTokensFreed = 0,
) {
  // messages.length => 126
  // model => 'claude-sonnet-4-6'
  // querySource => 'repl_main_thread'
  // snipTokensFreed => 0

  if (
    querySource === 'session_memory' ||
    querySource === 'compact'
  ) {
    return false
    // 摘要 Agent 自己不能再次启动 Auto Compact
  }

  if (!isAutoCompactEnabled()) {
    return false
  }
  // isAutoCompactEnabled() => true

  const tokenCount =
    tokenCountWithEstimation(messages) -
    snipTokensFreed
  // => 169400 - 0
  // => 169400

  const threshold = getAutoCompactThreshold(model)
  // => 167000

  const { isAboveAutoCompactThreshold } =
    calculateTokenWarningState(
      tokenCount,
      model,
    )
  // isAboveAutoCompactThreshold => true

  return isAboveAutoCompactThreshold
  // => true，本轮需要压缩
}
```

这里的返回值只是一个布尔值。`shouldAutoCompact()` 不生成摘要，也不改消息；它只回答「本轮要不要进入压缩路径」。

#### 第二步：可选的 Session Memory 分支返回 `null`

`autoCompactIfNeeded()` 会先调用 `trySessionMemoryCompaction()`。这是受 Feature Flag 控制的实验分支：开关启用时，后台 Hook 会在模型回答结束后维护一份当前会话的 `summary.md`，压缩时可以直接复用；开关未启用、文件不存在或内容为空时，函数返回 `null`。

本文运行值是 `shouldUseSessionMemoryCompaction() => false`，因此没有进入这条分支。主线继续调用 `compactConversation()`，让模型重新总结当前历史。

源码位置：`src/services/compact/autoCompact.ts:241-350`

```javascript
export async function autoCompactIfNeeded(
  messages,
  toolUseContext,
  cacheSafeParams,
  querySource,
  tracking,
  snipTokensFreed,
) {
  // messages.length => 126
  // querySource => 'repl_main_thread'
  // tracking => undefined
  // snipTokensFreed => 0

  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= 3
  ) {
    return { wasCompacted: false }
  }
  // 本例没有历史失败，不进入熔断分支

  const model =
    toolUseContext.options.mainLoopModel
  // => 'claude-sonnet-4-6'

  const shouldCompact = await shouldAutoCompact(
    messages,
    model,
    querySource,
    snipTokensFreed,
  )
  // => true

  if (!shouldCompact) {
    return { wasCompacted: false }
  }

  const recompactionInfo = {
    isRecompactionInChain:
      tracking?.compacted === true,
    turnsSincePreviousCompact:
      tracking?.turnCounter ?? -1,
    previousCompactTurnId: tracking?.turnId,
    autoCompactThreshold:
      getAutoCompactThreshold(model),
    querySource,
  }
  // => {
  //   isRecompactionInChain: false,
  //   turnsSincePreviousCompact: -1,
  //   previousCompactTurnId: undefined,
  //   autoCompactThreshold: 167000,
  //   querySource: 'repl_main_thread',
  // }

  const sessionMemoryResult =
    await trySessionMemoryCompaction(
      messages,
      toolUseContext.agentId,
      recompactionInfo.autoCompactThreshold,
    )
  // shouldUseSessionMemoryCompaction() => false
  // sessionMemoryResult => null

  if (sessionMemoryResult) {
    return {
      wasCompacted: true,
      compactionResult: sessionMemoryResult,
    }
  }

  try {
    const compactionResult =
      await compactConversation(
        messages,
        // => 126 条、约 169400 token

        toolUseContext,
        cacheSafeParams,
        true,
        // => 自动压缩后直接续行，不让摘要要求用户补充信息

        undefined,
        // => 没有用户传入的自定义压缩指令

        true,
        // => isAutoCompact

        recompactionInfo,
      )

    return {
      wasCompacted: true,
      compactionResult,
      consecutiveFailures: 0,
    }
  } catch (error) {
    return {
      wasCompacted: false,
      consecutiveFailures:
        (tracking?.consecutiveFailures ?? 0) + 1,
      // => 本例如果第一次失败，这里返回 1
    }
  }
}
```

连续失败次数达到 `3` 后，开头的熔断分支会阻止后续轮次继续发送注定失败的摘要请求。

#### 第三步：`compactConversation()` 生成摘要并恢复状态

到这里才真正开始压缩。`compactConversation()` 的输入是 126 条旧消息，输出不是一条字符串，而是一个 `CompactionResult`：摘要之外，还包含新边界、最近文件和其他运行状态。

##### 先把旧消息交给一次独立的摘要请求

源码位置：`src/services/compact/compact.ts:387-515`

```javascript
export async function compactConversation(
  messages,
  context,
  cacheSafeParams,
  suppressFollowUpQuestions,
  customInstructions,
  isAutoCompact = false,
  recompactionInfo,
) {
  // messages.length => 126
  // suppressFollowUpQuestions => true
  // customInstructions => undefined
  // isAutoCompact => true

  const preCompactTokenCount =
    tokenCountWithEstimation(messages)
  // => 169400

  const compactPrompt =
    getCompactPrompt(customInstructions)
  // => 要求模型保留当前目标、已完成工作、文件变化和下一步
  // => 同时要求只返回文本，不调用 Tool

  const summaryRequest = createUserMessage({
    content: compactPrompt,
  })
  // summaryRequest.message.role => 'user'
  // summaryRequest.message.content => compactPrompt

  const summaryResponse =
    await streamCompactSummary({
      messages,
      // => 126 条待总结消息

      summaryRequest,
      // => 追加在旧消息后的摘要要求

      appState: context.getAppState(),
      context,
      preCompactTokenCount,
      cacheSafeParams,
    })
  // => 一条 AssistantMessage，内容是模型生成的摘要

  const summary =
    getAssistantMessageText(summaryResponse)
  // => '<analysis>...</analysis><summary>\n' +
  //    '- 正在检查登录模块\n' +
  //    '- 已读取 src/auth/login.ts\n' +
  //    '- 登录失败路径缺少审计日志\n' +
  //    '- 下一步修改代码并运行 pnpm test\n' +
  //    '</summary>'

  // 函数还没有返回，下面继续恢复压缩后仍需保留的状态
}
```

`streamCompactSummary()` 会优先尝试复用主会话的 Prompt Cache，失败时走普通流式请求；两条路径最终都返回一条 `AssistantMessage`。对 `compactConversation()` 来说，关键输出就是上面的 `summary` 字符串，原来的 `messages` 数组没有被原地修改。

##### 摘要之外，再恢复最近文件和运行状态

只保留自然语言摘要还不够。最近读过哪些文件、当前是否处于 Plan Mode、调用过哪些 Skill，以及当前可用的延迟 Tool、Agent 和 MCP 指令，都可能在旧消息被替换后消失。

下面仍在同一个 `compactConversation()` 函数中。

源码位置：`src/services/compact/compact.ts:517-624`

```javascript
export async function compactConversation(/* 前面的参数 */) {
  // 前面已经得到 summary

  const preCompactReadFileState =
    cacheToObject(context.readFileState)
  // Object.keys(preCompactReadFileState)
  // => ['/Users/me/shop/src/auth/login.ts']

  context.readFileState.clear()
  context.loadedNestedMemoryPaths?.clear()
  // => 清空旧的读取缓存和局部 CLAUDE.md 去重记录
  // => 压缩后的上下文需要重新建立这两份状态

  const [fileAttachments, asyncAgentAttachments] =
    await Promise.all([
      createPostCompactFileAttachments(
        preCompactReadFileState,
        context,
        POST_COMPACT_MAX_FILES_TO_RESTORE,
      ),
      // => 最多恢复 5 个最近读取文件

      createAsyncAgentAttachmentsIfNeeded(context),
      // => 本例没有后台 Agent，返回 []
    ])

  // fileAttachments.length => 1
  // asyncAgentAttachments.length => 0

  const postCompactFileAttachments = [
    ...fileAttachments,
    ...asyncAgentAttachments,
  ]
  // => [login.ts 的文件附件]

  const planAttachment =
    createPlanAttachmentIfNeeded(context.agentId)
  // => null，本例没有 Plan 文件
  if (planAttachment) {
    postCompactFileAttachments.push(planAttachment)
  }

  const planModeAttachment =
    await createPlanModeAttachmentIfNeeded(context)
  // => null，本例不在 Plan Mode
  if (planModeAttachment) {
    postCompactFileAttachments.push(
      planModeAttachment,
    )
  }

  const skillAttachment =
    createSkillAttachmentIfNeeded(context.agentId)
  // => null，本例尚未调用 Skill
  if (skillAttachment) {
    postCompactFileAttachments.push(skillAttachment)
  }

  // 当前 Tool、Agent 和 MCP 声明也可能被旧消息一起压掉，
  // 因此从当前状态重新生成增量附件。
  for (const attachment of
    getDeferredToolsDeltaAttachment(
      context.options.tools,
      context.options.mainLoopModel,
      [],
      { callSite: 'compact_full' },
    )) {
    postCompactFileAttachments.push(
      createAttachmentMessage(attachment),
    )
  }

  for (const attachment of
    getAgentListingDeltaAttachment(context, [])) {
    postCompactFileAttachments.push(
      createAttachmentMessage(attachment),
    )
  }

  for (const attachment of
    getMcpInstructionsDeltaAttachment(
      context.options.mcpClients,
      context.options.tools,
      context.options.mainLoopModel,
      [],
    )) {
    postCompactFileAttachments.push(
      createAttachmentMessage(attachment),
    )
  }

  // 本例假设只有文件和延迟 Tool 声明需要恢复：
  // postCompactFileAttachments.length => 2
  // postCompactFileAttachments => [
  //   login.ts 的文件附件,
  //   deferred_tools_delta 附件,
  // ]
}
```

这段代码把摘要与附件分开：摘要承接「之前做了什么」，附件恢复「接下来继续工作需要的机器状态」。

##### 最后构造 `CompactionResult`

`compactConversation()` 继续创建一条压缩边界和一条摘要消息，然后把前面收集的内容一起返回。

源码位置：`src/services/compact/compact.ts:591-748`

```javascript
export async function compactConversation(/* 前面的参数 */) {
  // summary => 模型刚生成的摘要
  // preCompactTokenCount => 169400
  // postCompactFileAttachments.length => 2

  const hookMessages =
    await processSessionStartHooks('compact', {
      model: context.options.mainLoopModel,
    })
  // => []，本例没有额外的 SessionStart Hook 消息

  const boundaryMarker =
    createCompactBoundaryMessage(
      isAutoCompact ? 'auto' : 'manual',
      preCompactTokenCount,
      messages.at(-1)?.uuid,
    )
  // boundaryMarker.type => 'system'
  // boundaryMarker.subtype => 'compact_boundary'
  // boundaryMarker.compactMetadata.trigger => 'auto'
  // boundaryMarker.compactMetadata.preTokens => 169400

  const summaryMessages = [
    createUserMessage({
      content: getCompactUserSummaryMessage(
        summary,
        suppressFollowUpQuestions,
        getTranscriptPath(),
      ),
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    }),
  ]
  // summaryMessages.length => 1
  // summaryMessages[0].message.content
  // => 'This session is being continued...\n\n' +
  //    'Summary:\n- 正在检查登录模块...\n\n' +
  //    'Continue the conversation from where it left off...'

  const truePostCompactTokenCount =
    roughTokenCountEstimationForMessages([
      boundaryMarker,
      ...summaryMessages,
      ...postCompactFileAttachments,
      ...hookMessages,
    ])
  // => 约 12400

  const compactionCallTotalTokens =
    tokenCountFromLastAPIResponse([
      summaryResponse,
    ])
  // => 摘要模型请求的输入、缓存和输出总量

  const compactionUsage =
    getTokenUsage(summaryResponse)
  // => 摘要请求的 input_tokens、output_tokens 等统计

  return {
    boundaryMarker,
    summaryMessages,
    attachments: postCompactFileAttachments,
    hookResults: hookMessages,
    userDisplayMessage: undefined,
    preCompactTokenCount,
    // => 169400
    postCompactTokenCount: compactionCallTotalTokens,
    // => 摘要模型请求本身消耗的总 token，不是新上下文大小
    truePostCompactTokenCount,
    // => 约 12400，才是新消息载荷的估算大小
    compactionUsage,
  }
}
```

到这里，`autoCompactIfNeeded()` 收到的 `compactionResult` 才完整：1 条边界消息、1 条摘要消息、2 条示例附件和 0 条 Hook 消息。

#### 第四步：`queryLoop()` 用压缩结果继续当前请求

控制权回到 `queryLoop()` 后，`buildPostCompactMessages()` 先按固定顺序把 `CompactionResult` 展开成普通消息数组。

源码位置：`src/services/compact/compact.ts:322-336`

```javascript
export function buildPostCompactMessages(result) {
  // result.boundaryMarker => 1 条
  // result.summaryMessages.length => 1
  // result.messagesToKeep => undefined
  // result.attachments.length => 2
  // result.hookResults.length => 0

  return [
    result.boundaryMarker,
    ...result.summaryMessages,
    ...(result.messagesToKeep ?? []),
    ...result.attachments,
    ...result.hookResults,
  ]
  // => 4 条消息：边界、摘要、文件附件、Tool 声明附件
}
```

传统 Auto Compact 没有 `messagesToKeep`，旧的 126 条消息不会继续进入模型视图；Session Memory 和 Reactive Compact 等路径才可能在这里保留一段最近消息。

源码位置：`src/query.ts:470-535`、`src/query.ts:650-705`

```javascript
async function* queryLoop(/* ... */) {
  // compactionResult => compactConversation() 的返回值

  if (compactionResult) {
    const postCompactMessages =
      buildPostCompactMessages(compactionResult)
    // postCompactMessages.length => 4

    for (const message of postCompactMessages) {
      yield message
      // => 依次交给 REPL 保存和显示
    }

    messagesForQuery = postCompactMessages
    // => 当前 queryLoop() 不结束
    // => 后续模型请求从 126 条旧消息切换到这 4 条新消息
  }

  toolUseContext = {
    ...toolUseContext,
    messages: messagesForQuery,
  }
  // toolUseContext.messages.length => 4

  for await (const message of deps.callModel({
    messages: prependUserContext(
      messagesForQuery,
      userContext,
    ),
    // prependUserContext() 输入 4 条压缩结果
    // 再在开头加入 1 条包含根 CLAUDE.md 的隐藏 User Message
    // 传给 callModel() 的 messages.length => 5

    systemPrompt: fullSystemPrompt,
    tools: toolUseContext.options.tools,
    // 其他模型参数……
  })) {
    yield message
    // => 模型直接根据摘要和恢复附件继续原任务
  }
}
```

这次运行中的 4 条 `messagesForQuery` 大致如下。这里只展开影响后续处理的字段：

```javascript
messagesForQuery
// => [
//   {
//     type: 'system',
//     subtype: 'compact_boundary',
//     content: 'Conversation compacted',
//     compactMetadata: {
//       trigger: 'auto',
//       preTokens: 169400,
//     },
//   },
//   {
//     type: 'user',
//     isCompactSummary: true,
//     message: {
//       role: 'user',
//       content:
//         'This session is being continued...\n\n' +
//         'Summary:\n' +
//         '- 正在检查登录模块\n' +
//         '- 已读取 src/auth/login.ts\n' +
//         '- 下一步补充审计日志并运行 pnpm test',
//     },
//   },
//   {
//     type: 'attachment',
//     attachment: {
//       type: 'file',
//       filename: '/Users/me/shop/src/auth/login.ts',
//     },
//   },
//   {
//     type: 'attachment',
//     attachment: {
//       type: 'deferred_tools_delta',
//     },
//   },
// ]
```

边界消息用于本地切片，不会作为自然语言内容发送给 Anthropic API。进入 API 前，`normalizeMessagesForAPI()` 会过滤这条 System Message；模型实际读取的是根规则、摘要和状态附件。

![图 4：压缩前后的消息结构](https://windliangblog.oss-cn-beijing.aliyuncs.com/diagram-02.png)

`queryLoop()` 中的赋值保证当前 Agent 循环改用这 4 条消息。它们被 `yield` 给 REPL 后，普通交互模式收到 `compact_boundary` 时也会清掉旧状态，再依次保存摘要和附件；因此用户下一次输入时，传回 `queryLoop()` 的仍是这 4 条压缩结果。对应代码位于 `src/screens/REPL.tsx:2582-2604`。

项目根目录的 `CLAUDE.md` 不依赖摘要保存。它仍然位于独立的 `userContext` 中，每次 `callModel()` 前由 `prependUserContext()` 重新加入。局部 `src/auth/CLAUDE.md` 则跟随文件读取路径；压缩清空去重状态并恢复最近文件后，相关局部规则可以再次被发现。

## 小结

沿着「检查 `src/auth/login.ts` 的登录逻辑」这次运行，调用链依次发生了三次变化：

1. 准备第一轮请求时读取 `~/.claude/CLAUDE.md` 和项目根目录的 `CLAUDE.md`，每次请求模型前重新加入；
2. `Read` 读取 `src/auth/login.ts` 后，下一轮才发现并加入 `src/auth/CLAUDE.md`；
3. 消息接近上下文上限时，旧对话被压缩成边界、摘要和状态附件，下一轮不再携带全部历史消息。

从这条调用链还能看到四个具体的实现方法：

- **不同来源的上下文分开保存。** `fullSystemPrompt`、`userContext`、`messagesForQuery` 和 `tools` 直到请求模型时才组合。Auto Compact 只替换 `messagesForQuery`，不会把项目规则和 Tool 定义一起压进摘要。
- **局部规则按实际访问路径加载。** 第一轮请求前不会递归读取 `src/auth/CLAUDE.md`；`FileReadTool` 先记录真正访问过的文件，下一轮再沿该路径寻找局部规则。没有访问相关目录，就不会把那里的规则塞进上下文。
- **压缩不是一次完成的。** 当前轮突然出现的大 Tool Result、较旧的 Tool Result、局部历史和整段会话分别由不同步骤处理。只有前面的缩减仍无法把消息控制在阈值内，才进入需要模型生成摘要的 Auto Compact。
- **Auto Compact 返回新状态，而不是原地删除几条消息。** `compactConversation()` 生成 `CompactionResult`，`queryLoop()` 再把 126 条旧消息整体切换为 4 条压缩结果；REPL 收到压缩边界后也同步切换，避免下一次输入重新带回旧历史。

因此，下一轮请求模型时，压缩结果负责说明「任务进行到了哪里」，`prependUserContext()` 再补回用户级和项目根规则。
