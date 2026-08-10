---
title: "8、Memory 如何被写入、整理与按需召回"
---

上一篇的 Skill 把一份工作方法按需放进上下文；Memory 解决的是另一件事：一段对话已经结束后，下一次打开 Claude Code，哪些过去的信息还值得找回来。

第六篇的 Compact 会把当前会话收束成摘要，适合保留「现在做到哪里」；但摘要会压缩细节，新会话也不会继承它。长期有效的用户偏好、项目决策和外部系统入口，需要有一层不参与压缩的持久存储。当前源码中的 `memdir` 就把这类信息保存为文件。

假设 `/Users/me/shop` 曾经留下过一条测试约束和一条项目背景。自动记忆目录中有三份文件：

```text
~/.claude/projects/-Users-me-shop/memory/
├── MEMORY.md
├── feedback-real-database.md
└── project-auth-migration.md
```

`MEMORY.md` 很短，只保存索引；真正的细节留在独立文件中：

```markdown
<!-- ~/.claude/projects/-Users-me-shop/memory/MEMORY.md -->

- [真实数据库测试](feedback-real-database.md) — 登录模块的集成测试不得 mock 数据库
- [认证重构](project-auth-migration.md) — 认证重构由合规要求推动
```

```markdown
<!-- ~/.claude/projects/-Users-me-shop/memory/feedback-real-database.md -->

---
description: 登录模块的集成测试不得 mock 数据库
type: feedback
---

登录模块的集成测试必须连接真实数据库。

原因：曾经出现过 mock 测试通过、生产迁移失败的情况。
```

现在启动 Claude Code，并输入：

```text
修复 src/auth/login.integration.test.ts 的失败测试，保留现有测试方式。
```

最终，下一轮模型请求中会多出这条隐藏消息。下面是运行时消息对象，不是独立函数：

```javascript
// 运行时消息对象：由 normalizeAttachmentForAPI() 创建
{
  type: 'user',
  isMeta: true,
  message: {
    role: 'user',
    content: `<system-reminder>
Memory (saved 2 days ago): ~/.claude/projects/-Users-me-shop/memory/feedback-real-database.md:

登录模块的集成测试必须连接真实数据库。

原因：曾经出现过 mock 测试通过、生产迁移失败的情况。
</system-reminder>`,
  },
}
```

这篇追踪这条消息从磁盘回到后续请求的过程：Claude Code 先保留索引，再用一次独立模型调用选文件，最后把选中的正文作为附件写进会话。

![图 1：一条 Memory 被按需找回并进入下一轮](https://windliangblog.oss-cn-beijing.aliyuncs.com/diagram-01.png)

## 1. 先进入上下文的是索引，不是全部记忆

第六篇追过 `getMemoryFiles()`：启动时它会读取用户级和项目级的 `CLAUDE.md`。自动记忆启用时，同一个函数还会把 `MEMORY.md` 加入返回列表。

源码位置：`src/utils/claudemd.ts:790-992`

```javascript
// src/utils/claudemd.ts:790-992
export const getMemoryFiles = memoize(
  async (forceIncludeExternal = false) => {
    // 前面省略：读取用户级、项目级 CLAUDE.md 的逻辑。
    const result = []

    if (isAutoMemoryEnabled()) {
      const { info: memdirEntry } = await safelyReadMemoryFileAsync(
        getAutoMemEntrypoint(),
        'AutoMem',
      )
      // getAutoMemEntrypoint() =>
      //   '~/.claude/projects/-Users-me-shop/memory/MEMORY.md'
      // memdirEntry.content =>
      //   '- [真实数据库测试](feedback-real-database.md) — 登录模块的集成测试不得 mock 数据库'

      if (memdirEntry) {
        result.push(memdirEntry)
      }
    }

    return result
  }
)
```

之后 `getClaudeMds()` 会像处理 `CLAUDE.md` 一样，把这份 `AutoMem` 文件格式化进 `userContext.claudeMd`。这里读到的是一份 `MEMORY.md` 文件，文件内有两条索引记录：真实数据库测试和认证重构。模型开始处理任务时能看到这两条摘要，但还没有收到两个正文文件的完整内容。

`getMemoryFiles()` 读出的数组会立刻沿着下面这条链路被消费，并没有停留在启动阶段：

```javascript
// src/context.ts:155-184
export const getUserContext = memoize(async () => {
  const claudeMd = getClaudeMds(
    filterInjectedMemoryFiles(await getMemoryFiles()),
  )
  // getMemoryFiles() => [
  //   {
  //     path: '~/.claude/projects/-Users-me-shop/memory/MEMORY.md',
  //     type: 'AutoMem',
  //     content: '- [真实数据库测试](feedback-real-database.md) — 登录模块的集成测试不得 mock 数据库\n- [认证重构](project-auth-migration.md) — 认证重构由合规要求推动',
  //   },
  // ]
  // claudeMd => "Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\nContents of ~/.claude/projects/-Users-me-shop/memory/MEMORY.md (user's auto-memory, persists across conversations):\n\n- [真实数据库测试](feedback-real-database.md) — 登录模块的集成测试不得 mock 数据库\n- [认证重构](project-auth-migration.md) — 认证重构由合规要求推动"

  return {
    claudeMd,
    currentDate: "Today's date is 2026-08-10.",
  }
})

// src/query.ts:659-664
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  // messagesForQuery => [
  //   {
  //     type: 'user',
  //     message: {
  //       role: 'user',
  //       content: '修复 src/auth/login.integration.test.ts 的失败测试，保留现有测试方式。',
  //     },
  //   },
  // ]
  // userContext.claudeMd 会被 prependUserContext() 包成第一条隐藏 User Message，
  // 再与用户输入一起发送给模型。
})) {
  yield message
}
```

其中 `getClaudeMds()` 只做文本拼装：逐个读取数组中的 `file.path`、`file.type` 和 `file.content`，生成 `claudeMd` 字符串。`prependUserContext()` 再把这个字符串包装为 `isMeta: true` 的隐藏 User Message，放在 `messagesForQuery` 前面。因此第一节读取的 `MEMORY.md` 索引，实际使用位置就是这次模型调用的 `messages` 参数。

`getMemoryFiles()` 的读取范围不只包括这份自动 Memory 索引。对应设置启用且文件存在时，它还会读取：

- 受管控的 `CLAUDE.md` 与 `.claude/rules/*.md`；
- 用户级 `~/.claude/CLAUDE.md` 与 `~/.claude/rules/*.md`；
- 从文件系统根目录到当前 `cwd` 沿途的 `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md` 和 `CLAUDE.local.md`；
- `--add-dir` 指定目录中的同类项目指令；
- 启用 Team Memory 时的 Team `MEMORY.md` 索引。

自动 Memory 在这一步只读取当前项目对应目录中的 `MEMORY.md`，不会扫描 `feedback-real-database.md` 这类正文文件。正文要等第 3 节的相关性筛选选中后才读取；子目录中的 `CLAUDE.md` 则由第六篇追过的文件附件路径按需补入。

这层分法让索引始终很小。真正的记忆文件可以随时间增加，初始请求不需要把每条历史偏好都附上。

从代码结构可以直接看出两层数据的职责不同：`MEMORY.md` 用于「发现」，独立 `.md` 文件用于「提供依据」。这样写的代价是后面需要多一次筛选和读取；换来的是记忆数量增长时，固定进入上下文的部分仍然可控。给 Memory 写 `description` 因而不只是给人看的说明，它也是后面筛选阶段唯一稳定可见的线索之一。

`isAutoMemoryEnabled()` 默认返回 `true`，但 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`、`--bare`，或设置中的 `autoMemoryEnabled: false` 都会关掉这套机制。

源码位置：`src/memdir/paths.ts:20-53`

第一节和下一节的两份数据的形状也不同：这节 `getMemoryFiles()` 在自动 Memory 部分返回的是 `MEMORY.md` 这一份入口文件；下一节预取要的是每个正文文件的 `filePath`、Frontmatter `description`、`type` 和 `mtimeMs`，以便挑选后再读取。

这份索引先给模型的是长期信息的「摘要目录」。本例一开始修复登录测试时，模型已经能看到「登录集成测试不得 mock 数据库」和「认证重构由合规要求推动」两条约束；第一条已足以影响它是否选择 mock。后面的预取再根据当前任务，从两个正文文件中选出 `feedback-real-database.md`，把原因和细节补入后续请求。

索引注入提供的是第一轮请求前就确定存在的长期信息。后边要讲的流程 `startRelevantMemoryPrefetch()` 虽然与第一轮模型调用并行启动，但 `queryLoop()` 只在一次迭代结束后检查它是否已经完成；没有完成就直接跳过，不会等待。于是 `feedback-real-database.md` 的正文不保证赶上第一轮，而 `MEMORY.md` 中「不得 mock 数据库」这条摘要一定已经在第一轮消息里。

## 2. `queryLoop()` 开始时，后台启动一次相关性筛选

用户消息已经进入 `state.messages` 后，`queryLoop()` 创建 `pendingMemoryPrefetch`。这一步发生在主循环开始前，因此不会等到模型回答结束才开始检索。

源码位置：`src/query.ts:301-304`

```javascript
// src/query.ts:241-312
async function* queryLoop(params, consumedCommandUuids) {
  const state = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    turnCount: 1,
  }

  // 前面省略：其余跨轮状态的初始化。
  using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
    state.messages,
    state.toolUseContext,
  )
  // state.messages 最后一条真实用户消息 =>
  //   '修复 src/auth/login.integration.test.ts 的失败测试，保留现有测试方式。'
  // pendingMemoryPrefetch.promise =>
  //   Promise<Attachment[]>，后台正在筛选相关 Memory；此刻尚未读取结果

  // 后面进入 while (true) 处理每一轮模型调用和 Tool 调用。
}
```

`using` 表示这份预取任务会在 `queryLoop()` 退出时自动释放；用户中断、正常结束或抛出异常都会取消尚未完成的检索。这是一项和模型请求并行的预取工作。

之前也从来没用过 `using` 这个语法，查了下可以类比成下面的 `try / finally`：

```javascript
const pendingMemoryPrefetch = startRelevantMemoryPrefetch(
  state.messages,
  state.toolUseContext,
)

try {
  // queryLoop() 后续的模型调用与 Tool 调用。
} finally {
  pendingMemoryPrefetch[Symbol.dispose]()
  // => controller.abort()，取消尚未完成的 Memory 检索。
}
```

`using` 会在当前作用域退出时自动调用对象的 `Symbol.dispose()`；这里避免每个正常结束、中断和异常分支各写一次取消逻辑。

`startRelevantMemoryPrefetch()` 先排除几个不值得检索的情况：自动记忆或 Feature Flag 未开启、没有真实用户输入、输入只有一个词、或者本会话已经注入的记忆达到总预算。

源码位置：`src/utils/attachments.ts:2361-2427`

`readFileState` 是 `ToolUseContext` 中的文件状态缓存。键是文件路径，值保存该文件被读取时的内容、时间、分页位置等信息。此刻 `feedback-real-database.md` 还没有被模型读过，所以 `readFileState.has()` 返回 `false`；后面选出 Memory 时，它用来排除模型已经看过的文件。

源码位置：`src/utils/fileStateCache.ts:5-92`

```javascript
// src/utils/attachments.ts:2361-2427
export function startRelevantMemoryPrefetch(messages, toolUseContext) {
  // 前面省略：自动记忆和 Feature Flag 的开关判断。
  const lastUserMessage = messages.findLast(
    message => message.type === 'user' && !message.isMeta,
  )
  // lastUserMessage.message.content =>
  //   '修复 src/auth/login.integration.test.ts 的失败测试，保留现有测试方式。'

  const input = getUserMessageText(lastUserMessage)
  // => '修复 src/auth/login.integration.test.ts 的失败测试，保留现有测试方式。'

  const surfaced = collectSurfacedMemories(messages)
  // surfaced.paths => []
  // 本轮运行值：
  // toolUseContext.readFileState.has(
  //   '~/.claude/projects/-Users-me-shop/memory/feedback-real-database.md',
  // ) => false
  const controller = createChildAbortController(
    toolUseContext.abortController,
  )
  const promise = getRelevantMemoryAttachments(
    input,
    toolUseContext.options.agentDefinitions.activeAgents,
    toolUseContext.readFileState,
    collectRecentSuccessfulTools(messages, lastUserMessage),
    controller.signal,
    surfaced.paths,
  )
  // => Promise<Attachment[]>；完成后可能得到
  // [{
  //   type: 'relevant_memories',
  //   memories: [{
  //     path: '~/.claude/projects/-Users-me-shop/memory/feedback-real-database.md',
  //     content: '---\\ndescription: 登录模块的集成测试不得 mock 数据库\\ntype: feedback\\n---\\n\\n登录模块的集成测试必须连接真实数据库。',
  //   }],
  // }]

  const handle = {
    promise,
    settledAt: null,
    consumedOnIteration: -1,
    [Symbol.dispose]() {
      controller.abort()
    },
  }
  // handle.settledAt => null；Promise 完成后会写入完成时间。
  void promise.finally(() => {
    handle.settledAt = Date.now()
  })
  return handle
}
```

这里的输入只有当前用户问题，不会把完整会话再次交给检索器。目录、已经展示过的路径和本轮成功使用过的 Tool 则作为辅助条件，避免把相同记忆反复塞回上下文。

这段安排把「是否需要回忆」放到模型调用和 Tool 执行并行的时间里。源码只消费已经完成的 Promise，不 `await` 尚未结束的检索；检索慢不会卡住正常任务，提前完成的结果则会在后续模型请求前加入消息。

## 3. `sideQuery()` 根据目录挑选文件

预取调用 `getRelevantMemoryAttachments()`，其内部的 `findRelevantMemories()` 先扫描记忆目录中所有 `.md` 文件的前 30 行，读到 Frontmatter 的 `description`、`type` 和修改时间；最多保留 200 个文件头，并按更新时间倒序排列。

```javascript
// src/utils/attachments.ts:2196-2242
async function getRelevantMemoryAttachments(
  input,
  agents,
  readFileState,
  recentTools,
  signal,
  alreadySurfaced,
) {
  // input => '修复 src/auth/login.integration.test.ts 的失败测试，保留现有测试方式。'
  const memoryDirs = extractAgentMentions(input).flatMap(mention => {
    const agentType = mention.replace('agent-', '')
    const agentDef = agents.find(agent => agent.agentType === agentType)
    return agentDef?.memory
      ? [getAgentMemoryDir(agentType, agentDef.memory)]
      : []
  })
  // memoryDirs => []，本例没有 @ 提及子 Agent。

  const dirs = memoryDirs.length > 0
    ? memoryDirs
    : [getAutoMemPath()]
  // dirs => ['~/.claude/projects/-Users-me-shop/memory/']

  const allResults = await Promise.all(
    dirs.map(dir =>
      findRelevantMemories(
        input,
        dir,
        signal,
        recentTools,
        alreadySurfaced,
      ).catch(() => []),
    ),
  )
  // allResults => [[{
  //   path: '~/.claude/projects/-Users-me-shop/memory/feedback-real-database.md',
  //   mtimeMs: 1785922200000,
  // }]]

  const selected = allResults
    .flat()
    .filter(memory => !readFileState.has(memory.path))
    .slice(0, 5)
  // selected => allResults[0]

  const memories = await readMemoriesForSurfacing(selected, signal)
  return memories.length === 0
    ? []
    : [{ type: 'relevant_memories', memories }]
}
```

```javascript
// src/memdir/findRelevantMemories.ts:39-75
export async function findRelevantMemories(
  query,
  memoryDir,
  signal,
  recentTools = [],
  alreadySurfaced = new Set(),
) {
  const memories = (
    await scanMemoryFiles(memoryDir, signal)
  ).filter(memory => !alreadySurfaced.has(memory.filePath))
  // memories => [
  //   {
  //     filename: 'feedback-real-database.md',
  //     description: '登录模块的集成测试不得 mock 数据库',
  //     type: 'feedback',
  //   }, {
  //     filename: 'project-auth-migration.md',
  //     description: '认证重构由合规要求推动',
  //     type: 'project',
  //   },
  // ]

  if (memories.length === 0) {
    return []
  }

  const selectedFilenames = await selectRelevantMemories(
    query,
    memories,
    signal,
    recentTools,
  )
  // => ['feedback-real-database.md']

  const byFilename = new Map(
    memories.map(memory => [memory.filename, memory]),
  )
  const selected = selectedFilenames
    .map(filename => byFilename.get(filename))
    .filter(memory => memory !== undefined)

  return selected.map(memory => ({
    path: memory.filePath,
    mtimeMs: memory.mtimeMs,
  }))
  // => [{
  //   path: '~/.claude/projects/-Users-me-shop/memory/feedback-real-database.md',
  //   mtimeMs: 1785922200000,
  // }]
}
```

源码位置：`src/memdir/memoryScan.ts:35-94`

```javascript
// src/memdir/memoryScan.ts:35-94
export async function scanMemoryFiles(memoryDir, signal) {
  // 外层 try / catch 省略：目录读取失败时返回 []。
  const entries = await readdir(memoryDir, { recursive: true })
  // entries => ['MEMORY.md', 'feedback-real-database.md', 'project-auth-migration.md']

  const mdFiles = entries.filter(
    filename =>
      filename.endsWith('.md') &&
      basename(filename) !== 'MEMORY.md',
  )
  // => ['feedback-real-database.md', 'project-auth-migration.md']

  const headerResults = await Promise.allSettled(
    mdFiles.map(async filename => {
      const filePath = join(memoryDir, filename)
      const { content, mtimeMs } = await readFileInRange(
        filePath,
        0,
        30,
        undefined,
        signal,
      )
      const { frontmatter } = parseFrontmatter(content, filePath)
      // feedback-real-database.md 的 frontmatter => {
      //   description: '登录模块的集成测试不得 mock 数据库',
      //   type: 'feedback',
      // }
      return {
        filename,
        filePath,
        mtimeMs,
        description: frontmatter.description || null,
        type: parseMemoryType(frontmatter.type),
      }
    }),
  )

  return headerResults
    .filter(
      (result): result is PromiseFulfilledResult<MemoryHeader> =>
        result.status === 'fulfilled',
    )
    .map(result => result.value)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, 200)
  // => [{
  //   filename: 'feedback-real-database.md',
  //   filePath: '~/.claude/projects/-Users-me-shop/memory/feedback-real-database.md',
  //   description: '登录模块的集成测试不得 mock 数据库',
  //   type: 'feedback',
  // }, {
  //   filename: 'project-auth-migration.md',
  //   filePath: '~/.claude/projects/-Users-me-shop/memory/project-auth-migration.md',
  //   description: '认证重构由合规要求推动',
  //   type: 'project',
  // }]
}
```

扫描结果不会直接按关键词匹配，也不会传入 embedding 向量库。`selectRelevantMemories()` 把「当前问题 + 文件名 + 描述」交给 `sideQuery()`，通过一次 Sonnet 调用从目录中选出可用文件名。

源码位置：`src/memdir/findRelevantMemories.ts:77-137`

```javascript
// src/memdir/findRelevantMemories.ts:77-137
async function selectRelevantMemories(query, memories, signal, recentTools) {
  // query => '修复 src/auth/login.integration.test.ts 的失败测试，保留现有测试方式。'
  // memories => [{
  //   filename: 'feedback-real-database.md',
  //   filePath: '~/.claude/projects/-Users-me-shop/memory/feedback-real-database.md',
  //   description: '登录模块的集成测试不得 mock 数据库',
  //   type: 'feedback',
  // }, {
  //   filename: 'project-auth-migration.md',
  //   filePath: '~/.claude/projects/-Users-me-shop/memory/project-auth-migration.md',
  //   description: '认证重构由合规要求推动',
  //   type: 'project',
  // }]
  // signal => AbortSignal { aborted: false }
  // recentTools => []

  const validFilenames = new Set(memories.map(memory => memory.filename))
  const manifest = formatMemoryManifest(memories)
  // => '- [feedback] feedback-real-database.md (2026-08-05T09:30:00.000Z): 登录模块的集成测试不得 mock 数据库\n- [project] project-auth-migration.md (2026-08-01T08:00:00.000Z): 认证重构由合规要求推动'

  const result = await sideQuery({
    model: getDefaultSonnetModel(),
    // => 'claude-sonnet-4-6'
    messages: [{
      role: 'user',
      content: `Query: ${query}\\n\\nAvailable memories:\\n${manifest}`,
    }],
    max_tokens: 256,
    output_format: {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          selected_memories: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['selected_memories'],
      },
    },
    signal,
    querySource: 'memdir_relevance',
  })

  const textBlock = result.content.find(block => block.type === 'text')
  const selected = jsonParse(textBlock.text).selected_memories
  // selected => ['feedback-real-database.md']

  const selectedExistingMemories = selected.filter(
    filename => validFilenames.has(filename),
  )
  // selectedExistingMemories => ['feedback-real-database.md']
  return selectedExistingMemories
}
```

选择器最多返回 5 个文件名。它也会避开已经展示过的文件；如果模型近期已经成功使用 `Read`，选择器不会再把「如何使用 Read」这类参考记忆捞回来，但仍可以选择包含警告或已知问题的记忆。

这条路径先把两个文件的目录交给一次独立调用，再由它选中 `feedback-real-database.md`，最后才读取正文。随着记忆文件增加，初始请求中的固定部分仍然较小。

这种实现还留下一个很实际的约束：检索质量首先取决于文件名和 Frontmatter 描述，而不是全文的语义向量。对 Memory 来说，「登录模块的集成测试不得 mock 数据库」比「测试经验」更容易被当前问题准确选中。文件正文可以写详细，索引和描述则应当短且能说明何时有用。

## 4. 选中后才读取正文，并限制大小

回到第 3 节的 `getRelevantMemoryAttachments()`：`selected` 是选择器给出的路径和修改时间。函数紧接着把它交给 `readMemoriesForSurfacing()`，再包装成附件：

```javascript
// src/utils/attachments.ts:2233-2242，位于 getRelevantMemoryAttachments()
async function getRelevantMemoryAttachments(
  input,
  agents,
  readFileState,
  recentTools,
  signal,
  alreadySurfaced,
) {
  // 前面省略：findRelevantMemories() 选出文件，并过滤重复路径。
  const selected = [{
    path: '~/.claude/projects/-Users-me-shop/memory/feedback-real-database.md',
    mtimeMs: 1785922200000,
  }]

  const memories = await readMemoriesForSurfacing(selected, signal)
  // memories => [{
  //   path: '~/.claude/projects/-Users-me-shop/memory/feedback-real-database.md',
  //   header: 'Memory (saved 2 days ago): ~/.claude/projects/-Users-me-shop/memory/feedback-real-database.md:',
  //   content: '---\ndescription: 登录模块的集成测试不得 mock 数据库\ntype: feedback\n---\n\n登录模块的集成测试必须连接真实数据库。',
  // }]

  return [{ type: 'relevant_memories', memories }]
}
```

`readMemoriesForSurfacing()` 接到选择器的路径后，才读取文件正文。每个文件最多读取 200 行和 4096 字节；任一限制触发时，正文后面会加上完整文件路径，模型仍可用普通 `Read` Tool 查看余下内容。

源码位置：`src/utils/attachments.ts:2279-2323`

```javascript
// src/utils/attachments.ts:2279-2323
export async function readMemoriesForSurfacing(selected, signal) {
  const results = await Promise.all(
    selected.map(async ({ path: filePath, mtimeMs }) => {
      try {
        const result = await readFileInRange(
          filePath,
          0,
          200,
          4096,
          signal,
          { truncateOnByteLimit: true },
        )
        // filePath =>
        //   '~/.claude/projects/-Users-me-shop/memory/feedback-real-database.md'
        // result.content =>
        //   '---\ndescription: 登录模块的集成测试不得 mock 数据库\ntype: feedback\n---\n\n登录模块的集成测试必须连接真实数据库。\n\n原因：曾经出现过 mock 测试通过、生产迁移失败的情况。'

        const truncated =
          result.totalLines > 200 || result.truncatedByBytes
        const content = truncated
          ? result.content +
            `\n\n> This memory file was truncated (${result.truncatedByBytes ? '4096 byte limit' : 'first 200 lines'}). Use the Read tool to view the complete file at: ${filePath}`
          : result.content
        // truncated => false
        // content => result.content

        return {
          path: filePath,
          content,
          mtimeMs,
          header: memoryHeader(filePath, mtimeMs),
        }
      } catch {
        return null
      }
    }),
  )

  return results.filter(result => result !== null)
}
```

`getRelevantMemoryAttachments()` 将这些结果装进 `relevant_memories` 附件。此时还没有修改模型请求；它只是把可能进入下一轮的数据准备好。

自动带入后续请求的每个 Memory 最多只有 200 行、4096 字节。假如 `feedback-real-database.md` 有 500 行且前 200 行没有超过 4096 字节，模型收到的是前 200 行，以及一句「完整文件在 `~/.claude/projects/-Users-me-shop/memory/feedback-real-database.md`」；4096 字节先到时，实际带入的行数会更少。

如果前 200 行已经足够，模型直接继续任务；只有确实需要后面的细节时，才会再调用 `Read` 读取这个路径。这样不会把每份长记忆都自动塞进上下文，也不会让被截掉的内容找不回来。

## 5. 预取不阻塞主任务，完成后加入后续请求

模型请求和 Tool 调用照常进行。例如模型先读失败测试和登录实现：

```javascript
// 模型输出：运行时对象，不是源码中的独立函数
{
  type: 'tool_use',
  id: 'toolu_read_test_01',
  name: 'Read',
  input: {
    file_path: '/Users/me/shop/src/auth/login.integration.test.ts',
  },
}

// Read Tool Result 已写入本轮 messages
{
  type: 'tool_result',
  tool_use_id: 'toolu_read_test_01',
  content: 'describe(\'login\', () => { /* 当前测试使用真实 test database */ })',
}
```

这期间，记忆选择的 `Promise` 可能已经完成，也可能仍在运行。`queryLoop()` 在 Tool 结果收集完成后只检查 `settledAt`；还没结束就跳过，下一次循环再检查，不会为了等待记忆而停住 Agent。

模型调用与 Memory 检索并行进行。模型输出和本轮 Tool 结果处理完后，`queryLoop()` 才运行下面这段代码：已经完成的检索结果会加入 `toolResults`，随后随下一次模型请求发送；尚未完成则跳过，等循环继续时再检查。

源码位置：`src/query.ts:1578-1622`

```javascript
// src/query.ts:241-1622，位于 queryLoop()
async function* queryLoop(params, consumedCommandUuids) {
  // 前面省略：本轮模型调用、Tool 结果收集和 assistantMessages 的处理。

  if (
    pendingMemoryPrefetch &&
    pendingMemoryPrefetch.settledAt !== null &&
    pendingMemoryPrefetch.consumedOnIteration === -1
  ) {
    const memoryAttachments = filterDuplicateMemoryAttachments(
      await pendingMemoryPrefetch.promise,
      toolUseContext.readFileState,
    )
    // memoryAttachments => [{
    //   type: 'relevant_memories',
    //   memories: [{
    //     path: '~/.claude/projects/-Users-me-shop/memory/feedback-real-database.md',
    //     content: '---\ndescription: 登录模块的集成测试不得 mock 数据库\ntype: feedback\n---\n登录模块的集成测试必须连接真实数据库。',
    //   }],
    // }]

    for (const memoryAttachment of memoryAttachments) {
      const message = createAttachmentMessage(memoryAttachment)
      yield message
      toolResults.push(message)
    }
    pendingMemoryPrefetch.consumedOnIteration = turnCount - 1
  }
}
```

`filterDuplicateMemoryAttachments()` 在加入前再检查一次 `readFileState`。若模型已经自己通过 `Read` 打开同一文件，或本会话先前已经注入过它，附件会被过滤掉；保留下来的路径也会记录进 `readFileState`，后续轮次不再重复出现。

磁盘上的 Memory 是跨会话的持久数据，`readFileState` 则是本次会话的临时去重状态。把两者分开后，记忆文件不会因为本轮已经展示过一次而失效；反过来，同一轮也不会因为循环继续而重复膨胀相同正文。

接着 `createAttachmentMessage()` 调用 `normalizeAttachmentForAPI()`，把 `relevant_memories` 格式化为 `isMeta: true` 的隐藏 User Message。这条消息和 Tool Result 一起进入下一轮 `callModel()`。

源码位置：`src/utils/messages.ts:3708-3724`

```javascript
// src/utils/messages.ts:3453-3730
export function normalizeAttachmentForAPI(attachment) {
  // attachment => {
  //   type: 'relevant_memories',
  //   memories: [
  //     {
  //       path: '~/.claude/projects/-Users-me-shop/memory/feedback-real-database.md',
  //       mtimeMs: 1786147200000,
  //       header: 'Memory (saved 2 days ago): ~/.claude/projects/-Users-me-shop/memory/feedback-real-database.md:',
  //       content: '---\ndescription: 登录模块的集成测试不得 mock 数据库\ntype: feedback\n---\n\n登录模块的集成测试必须连接真实数据库。\n\n原因：曾经出现过 mock 测试通过、生产迁移失败的情况。',
  //     },
  //   ],
  // }
  // 前面省略：其他 Attachment 类型的格式化。
  switch (attachment.type) {
    case 'relevant_memories': {
      return wrapMessagesInSystemReminder(
        attachment.memories.map(memory => {
          const header = memory.header ?? memoryHeader(
            memory.path,
            memory.mtimeMs,
          )
          return createUserMessage({
            content: `${header}\n\n${memory.content}`,
            isMeta: true,
          })
        }),
      )
    }
  }
}
// return => [
//   {
//     type: 'user',
//     isMeta: true,
//     message: {
//       role: 'user',
//       content: `<system-reminder>
// Memory (saved 2 days ago): ~/.claude/projects/-Users-me-shop/memory/feedback-real-database.md:
//
// ---
// description: 登录模块的集成测试不得 mock 数据库
// type: feedback
// ---
//
// 登录模块的集成测试必须连接真实数据库。
//
// 原因：曾经出现过 mock 测试通过、生产迁移失败的情况。
// </system-reminder>`,
//     },
//   },
// ]
```

随后模型既能看到测试文件，也能看到这条历史约束。接下来它可以据此修复断言或测试数据，并把「不得 mock 数据库」作为约束。

## 6. 记忆是长期信息，还需要写入和整理

自动记忆目录中的内容用于跨会话保留信息。源码把可保存内容分成 `user`、`feedback`、`project`、`reference` 四类，并明确排除可以从代码、Git 历史或目录结构重新推导的事实。

源码位置：`src/memdir/memoryTypes.ts:1-34`

```javascript
// src/memdir/memoryTypes.ts:1-34，模块顶层导出
export const MEMORY_TYPES = [
  'user',
  'feedback',
  'project',
  'reference',
]

// feedback 例子 =>
//   '登录模块的集成测试不得 mock 数据库'
// 不适合保存 =>
//   'src/auth/login.ts 存在'
// 因为后者可以随时通过 Glob、Grep 或 Read 得到。
```

四类类型对应的是四种不同的长期信息：

| 类型 | 适合记录的内容 | 本例或运行中的例子 |
| --- | --- | --- |
| `user` | 用户角色、目标、稳定偏好 | 「偏好使用 tab 缩进」 |
| `feedback` | 反复有效的协作方式和约束 | 「登录测试不得 mock 数据库」 |
| `project` | 代码无法推导的背景、决策、截止时间 | 「认证重构由合规要求推动」 |
| `reference` | 外部系统中信息的位置 | 「延迟排查查看 Grafana 某个面板」 |

同一会话中的 `messages`、Todo、当前 Tool Result，以及第六篇的 Session Memory Compact，解决的是「这次任务还没结束时如何续上」。它们会随会话结束、压缩边界或上下文预算变化。Memory 只保存以后重新启动 Claude Code 仍可能影响判断的信息。

`buildMemoryLines()` 放进模型上下文的写入约束要求两步：先把详细内容写入独立文件，再在 `MEMORY.md` 写一行指针。这样，写入结构和本篇读取结构正好对应：正文保留原因与使用方式，索引承担发现责任。

源码位置：`src/memdir/memdir.ts:199-266`

用户输入「记住：登录模块的集成测试不得 mock 数据库」后，这句话先作为普通 User Message 进入 `queryLoop()`。`loadMemoryPrompt()` 在启动时已经把 Memory 保存规则放进 System Prompt，其中包含「用户明确要求记住时立即保存」以及「正文文件 + `MEMORY.md` 指针」两步要求。

源码位置：`src/memdir/memdir.ts:199-266`、`src/memdir/memdir.ts:419-490`

```javascript
// src/memdir/memdir.ts:419-490
export async function loadMemoryPrompt() {
  const autoEnabled = isAutoMemoryEnabled()
  const skipIndex = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_moth_copse',
    false,
  )
  // 前面省略：团队 Memory 与 daily-log 两条分支。

  if (autoEnabled) {
    const autoDir = getAutoMemPath()
    // => '~/.claude/projects/-Users-me-shop/memory/'

    await ensureMemoryDirExists(autoDir)

    return buildMemoryLines(
      'auto memory',
      autoDir,
      undefined,
      skipIndex,
    ).join('\n')
    // 返回的 Prompt 包含：
    // 'If the user explicitly asks you to remember something, save it immediately'
    // 'Step 1 — write the memory to its own file'
    // 'Step 2 — add a pointer to that file in MEMORY.md'
  }

  return null
}
```

模型随后沿第四篇的正常 Tool 路径返回写文件请求；没有额外的「记住」专用 Tool。下面是这次输入可能得到的模型 Tool Use，不是源码中的函数：

```javascript
// 模型可能先写正文
{
  type: 'tool_use',
  id: 'toolu_memory_write_01',
  name: 'Write',
  input: {
    file_path: '~/.claude/projects/-Users-me-shop/memory/feedback-real-database.md',
    content: `---
description: 登录模块的集成测试不得 mock 数据库
type: feedback
---

登录模块的集成测试必须连接真实数据库。

原因：曾经出现过 mock 测试通过、生产迁移失败的情况。`,
  },
}

// 再更新索引
{
  type: 'tool_use',
  id: 'toolu_memory_edit_01',
  name: 'Edit',
  input: {
    file_path: '~/.claude/projects/-Users-me-shop/memory/MEMORY.md',
    old_string: '- [认证重构](project-auth-migration.md) — 认证重构由合规要求推动',
    new_string: `- [认证重构](project-auth-migration.md) — 认证重构由合规要求推动
- [真实数据库测试](feedback-real-database.md) — 登录模块的集成测试不得 mock 数据库`,
  },
}
```

这两次 Tool 已经成功写入文件后，Memory 就产生了。任务结束时，后台提取器会检查这段消息中是否已经出现了 `Write` 或 `Edit` 到 Memory 目录的 Tool Use；存在就跳过，避免同一条信息被主 Agent 和提取器各保存一遍。

## 7. 一轮任务结束后，后台提取器补充遗漏的 Memory

用户并不总会明确说「记住」。例如用户在解决测试失败时说出「登录模块的集成测试不得 mock 数据库」，这条约束对以后排查仍然有用，但主 Agent 可能只专注于修复当前测试。因此，正常任务结束后还会有一条后台提取路径：

![图 2：任务结束后产生 Memory 的后台路径](https://windliangblog.oss-cn-beijing.aliyuncs.com/diagram-02.png)

### 1. 主任务结束，Stop Hook 发起后台提取

`queryLoop()` 走到正常结束路径后，将本轮消息、`ToolUseContext` 和上下文对象交给 `handleStopHooks()`，作为主循环准备返回前的收尾工作。

源码位置：`src/query.ts:1267-1275`

```javascript
// src/query.ts:241-1290，位于 queryLoop()
async function* queryLoop(params, consumedCommandUuids) {
  // 前面省略：模型已返回最终文本，本轮没有继续调用 Tool。
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
  // messagesForQuery + assistantMessages =>
  //   本轮用户问题、Tool Result 与最终回答组成的完整主会话消息

  // 后面省略：根据 stopHookResult 决定本轮结束或续行。
}
```

`handleStopHooks()` 只在非 `--bare` 的主线程任务中考虑启动提取器，还要求 `EXTRACT_MEMORIES` Feature Flag 和自动记忆模式都已开启。这里不等待提取任务完成，用户的最终回答可以先返回，Memory 提取留在后台继续。

源码位置：`src/query/stopHooks.ts:141-155`

```javascript
// src/query/stopHooks.ts:65-165
export async function* handleStopHooks(
  messagesForQuery,
  assistantMessages,
  systemPrompt,
  userContext,
  systemContext,
  toolUseContext,
  querySource,
  stopHookActive,
) {
  const stopHookContext = {
    messages: [...messagesForQuery, ...assistantMessages],
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    querySource,
  }

  // 前面省略：其他 Stop Hook、提示建议和任务状态更新。
  if (!isBareMode()) {
    if (
      feature('EXTRACT_MEMORIES') &&
      !toolUseContext.agentId &&
      isExtractModeActive()
    ) {
      void extractMemoriesModule.executeExtractMemories(
        stopHookContext,
        toolUseContext.appendSystemMessage,
      )
    }
  }
  // toolUseContext.agentId => undefined（主 Agent）
  // executeExtractMemories() => 后台 Promise，不等待它完成
}
```

### 2. 公开入口转交给启动时创建的提取器

`executeExtractMemories()` 是 Stop Hook 调用的公开函数。启动阶段的 `initExtractMemories()` 创建 `executeExtractMemoriesImpl()`，并将它保存到模块变量 `extractor`；公开函数只负责把调用转交进去。

源码位置：`src/services/extractMemories/extractMemories.ts:569-602`

```javascript
// src/services/extractMemories/extractMemories.ts:569-602
// initExtractMemories() 内部：
extractor = async (context, appendSystemMessage) => {
  await executeExtractMemoriesImpl(context, appendSystemMessage)
}

// Stop Hook 实际调用的公开入口：
export async function executeExtractMemories(
  context,
  appendSystemMessage,
) {
  await extractor?.(context, appendSystemMessage)
}
```

### 3. 内部入口先决定这次是否需要启动提取

进入 `executeExtractMemoriesImpl()` 后，源码先排除子 Agent、未启用自动 Memory、远程模式等情况。通过后，如果没有另一个提取正在执行，才进入 `runExtraction()`；正在执行时先保存最新上下文，具体的补跑逻辑放到第 6 步再看。

源码位置：`src/services/extractMemories/extractMemories.ts:339-427`、`src/services/extractMemories/extractMemories.ts:171-238`

```javascript
// src/services/extractMemories/extractMemories.ts:296-435
export function initExtractMemories() {
  let lastMemoryMessageUuid

  async function executeExtractMemoriesImpl(
    context,
    appendSystemMessage,
  ) {
    // 前面省略：子 Agent、Feature Flag、自动 Memory、远程模式等前置判断。
    if (inProgress) {
      pendingContext = { context, appendSystemMessage }
      // 当前提取尚未完成：先保存最新上下文，本次不新建 forked Agent。
      return
    }

    await runExtraction({ context, appendSystemMessage })
  }
}
```

### 4. `runExtraction()` 组装提取任务，再交给 forked Agent

第 3 步确认可以运行后，才进入同一个 `initExtractMemories()` 闭包内的 `runExtraction()`。它依次准备「本次新增消息」「已有 Memory 清单」「提取 Prompt」「受限权限」，最后调用 `runForkedAgent()`。

是否产生一条新 Memory、更新旧文件，还是不写任何内容，都是 forked Agent 的模型输出决定的；源码没有把「登录测试」或「不得 mock」写成固定提取规则。这个 Agent 不直接保存文件；它和主 Agent 一样，仍要通过正常的 `Write`、`Edit` Tool 完成写入。

源码位置：`src/services/extractMemories/extractMemories.ts:329-435`

```javascript
// src/services/extractMemories/extractMemories.ts:329-435，位于 initExtractMemories() 的同一闭包内

  async function runExtraction({
    context,
    appendSystemMessage,
    isTrailingRun,
  }) {
    const { messages } = context
    const memoryDir = getAutoMemPath()
    const newMessageCount = countModelVisibleMessagesSince(
      messages,
      lastMemoryMessageUuid,
    )
    // newMessageCount => 4

    const mainAgentWroteMemory = hasMemoryWritesSince(
      messages,
      lastMemoryMessageUuid,
    )
    // mainAgentWroteMemory => false
    if (mainAgentWroteMemory) {
      return
    }
    // 本轮主 Agent 没有直接写入 feedback-real-database.md，因此继续提取。

    const existingMemories = formatMemoryManifest(
      await scanMemoryFiles(
        memoryDir,
        createAbortController().signal,
      ),
    )
    // => '- [project] project-auth-migration.md (2026-08-01T08:00:00.000Z): 认证重构由合规要求推动'

    const skipIndex = false
    const teamMemoryEnabled = false
    const userPrompt =
      feature('TEAMMEM') && teamMemoryEnabled
        ? buildExtractCombinedPrompt(
            newMessageCount,
            existingMemories,
            skipIndex,
          )
        : buildExtractAutoOnlyPrompt(
            newMessageCount,
            existingMemories,
            skipIndex,
          )
    // feature('TEAMMEM') => false
    // userPrompt 中包含：
    //   'If the user explicitly asks you to remember something, save it immediately'
    //   以及「正文文件 + MEMORY.md 索引」的保存规则。

    const result = await runForkedAgent({
      promptMessages: [createUserMessage({ content: userPrompt })],
      cacheSafeParams: createCacheSafeParams(context),
      // cacheSafeParams.forkContextMessages => 本轮主 Agent 已经可见的会话消息
      canUseTool: createAutoMemCanUseTool(memoryDir),
      querySource: 'extract_memories',
      forkLabel: 'extract_memories',
      skipTranscript: true,
      maxTurns: 5,
    })
    // result.messages 可能包含：[
    //   {
    //     type: 'assistant',
    //     message: {
    //       role: 'assistant',
    //       content: [{
    //         type: 'tool_use',
    //         id: 'toolu_memory_write_01',
    //         name: 'Write',
    //         input: {
    //           file_path: '~/.claude/projects/-Users-me-shop/memory/feedback-real-database.md',
    //           content: '---\ndescription: 登录模块的集成测试不得 mock 数据库\ntype: feedback\n---\n\n登录模块的集成测试必须连接真实数据库。',
    //         },
    //       }],
    //     },
    //   },
    //   {
    //     type: 'assistant',
    //     message: {
    //       role: 'assistant',
    //       content: [{
    //         type: 'tool_use',
    //         id: 'toolu_memory_edit_01',
    //         name: 'Edit',
    //         input: {
    //           file_path: '~/.claude/projects/-Users-me-shop/memory/MEMORY.md',
    //           old_string: '- [认证重构](project-auth-migration.md) — 认证重构由合规要求推动',
    //           new_string: '- [认证重构](project-auth-migration.md) — 认证重构由合规要求推动\n- [真实数据库测试](feedback-real-database.md) — 登录模块的集成测试不得 mock 数据库',
    //         },
    //       }],
    //     },
    //   },
    // ]
    // 两个 Tool Use 执行成功后，正文和索引文件已经写入磁盘。
}
```

### 5. `runForkedAgent()` 复用 Agent 主循环，Tool 写入文件

`runForkedAgent()` 做的事情是创建独立的 `ToolUseContext`，再用已有的 `query()` 主循环跑这次「提取记忆」任务。它不写 Memory，也不解析 Memory；写入动作仍发生在这个 forked Agent 返回 `Write`、`Edit` Tool Use 后，由第四篇追过的 Tool 执行链完成。

代码提供的是约束，不是确定的提取算法：提示词给出四种 Memory 类型、已有文件头和「正文后更新索引」的规则；`canUseTool` 限制写入目录，`maxTurns: 5` 限制调用次数。模型在这些边界内决定是否调用 `Write`、`Edit`。因此一次提取也可能正常结束而没有任何写入。

源码位置：`src/utils/forkedAgent.ts:489-594`

```javascript
// src/utils/forkedAgent.ts:489-594
export async function runForkedAgent({
  promptMessages,
  cacheSafeParams,
  canUseTool,
  querySource,
  maxTurns,
}) {
  const outputMessages = []
  let totalUsage = { ...EMPTY_USAGE }

  const {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    forkContextMessages,
  } = cacheSafeParams

  const isolatedToolUseContext = createSubagentContext(toolUseContext)
  // 与主 Agent 分开的上下文：fork 中的文件读取状态、取消状态不会改写主会话。

  const initialMessages = [
    ...forkContextMessages,
    ...promptMessages,
  ]
  // promptMessages => [{
  //   type: 'user',
  //   message: { role: 'user', content: userPrompt },
  // }]

  for await (const message of query({
    messages: initialMessages,
    systemPrompt,
    userContext,
    systemContext,
    canUseTool,
    toolUseContext: isolatedToolUseContext,
    querySource: 'extract_memories',
    maxTurns: 5,
  })) {
    if (message.type === 'stream_event') {
      if (message.event?.type === 'message_delta' && message.event.usage) {
        totalUsage = accumulateUsage(
          totalUsage,
          updateUsage({ ...EMPTY_USAGE }, message.event.usage),
        )
      }
      continue
    }
    if (message.type === 'stream_request_start') {
      continue
    }
    outputMessages.push(message)
  }

  return { messages: outputMessages, totalUsage }
}
```

允许写入的边界来自传入的 `canUseTool`。它只放行 Memory 目录中的 `Edit`、`Write`；例如 `feedback-real-database.md` 可以写，`/Users/me/shop/src/auth/login.ts` 会被拒绝。这样提取器可以更新「正文文件 + `MEMORY.md`」，但不能借机修改项目代码。

```javascript
// src/services/extractMemories/extractMemories.ts:196-214，位于 createAutoMemCanUseTool()
if (
  (tool.name === FILE_EDIT_TOOL_NAME ||
    tool.name === FILE_WRITE_TOOL_NAME) &&
  'file_path' in input
) {
  const filePath = input.file_path
  if (typeof filePath === 'string' && isAutoMemPath(filePath)) {
    return { behavior: 'allow', updatedInput: input }
  }
}

// tool.name => 'Write'
// input.file_path => '~/.claude/projects/-Users-me-shop/memory/feedback-real-database.md'
// isAutoMemPath(filePath) => true
// 返回 allow，随后进入 Write Tool。
```

### 6. 提取进行中有新任务结束时，只在最后补跑一次

第 3 步中 `inProgress === true` 时，第二次调用已经把最新上下文存进 `pendingContext` 并返回。第 4 步的 `runExtraction()` 完成后才会执行下面的 `finally`。源码把这次「前一个提取结束后，补上期间新增消息」的运行称为 `trailing extraction`；它不是失败重试。

源码位置：`src/services/extractMemories/extractMemories.ts:496-523`

```javascript
// src/services/extractMemories/extractMemories.ts:496-523，位于 runExtraction() 的 finally 中
finally {
  inProgress = false

  const trailing = pendingContext
  pendingContext = undefined
  // trailing => {
  //   context: 第二次任务结束时的最新 REPLHookContext,
  //   appendSystemMessage: toolUseContext.appendSystemMessage,
  // }

  if (trailing) {
    await runExtraction({
      context: trailing.context,
      appendSystemMessage: trailing.appendSystemMessage,
      isTrailingRun: true,
    })
    // 第二次提取只处理第一次运行期间新出现的消息。
  }
}
```

多个任务在第一次提取期间结束时，`pendingContext` 会不断被最新一份覆盖；前一个提取结束后只补跑一次。提取失败也只记录日志，不会让已经完成的用户任务变成失败。这样不会并行写 `MEMORY.md`，也不会为了每次任务结束排队运行多份过时的提取。

### 7. `autoDream`：另一条低频的整理分支

提取链路结束后，同一个 Stop Hook 还会尝试调用 `executeAutoDream()`。名字来自它传给 forked Agent 的 Prompt 标题 `# Dream: Memory Consolidation`。它不会在每轮任务结束时都实际开始整理，而是检查三个门槛：距上次整理的时间、期间累积的其他会话数量，以及是否已有另一个进程正在整理。默认值是至少间隔 24 小时、至少积累 5 个其他会话；`autoDreamEnabled` 设置控制是否启用，Feature Flag 可以提供启用状态和两个阈值。

源码位置：`src/query/stopHooks.ts:149-153`

```javascript
// src/query/stopHooks.ts:149-153，位于 handleStopHooks()
if (!toolUseContext.agentId) {
  void executeAutoDream(
    stopHookContext,
    toolUseContext.appendSystemMessage,
  )
  // autoDream 自己检查是否达到整理门槛；未达到时直接返回。
}
```

源码位置：`src/services/autoDream/autoDream.ts:52-199`、`src/services/autoDream/config.ts:10-20`

```javascript
// src/services/autoDream/autoDream.ts:125-199，位于 initAutoDream() 中的 runAutoDream()
const cfg = getConfig()
// cfg => { minHours: 24, minSessions: 5 }

const lastAt = await readLastConsolidatedAt()
// lastAt => 1786060800000，表示上次整理发生在 2026-08-07T00:00:00.000Z
const hoursSince = (Date.now() - lastAt) / 3_600_000
// hoursSince => 72
if (hoursSince < cfg.minHours) return

let sessionIds = await listSessionsTouchedSince(lastAt)
// sessionIds => [
//   'session_auth_bugfix_01',
//   'session_payment_review_02',
//   'session_ci_failure_03',
//   'session_release_check_04',
//   'session_migration_05',
// ]
sessionIds = sessionIds.filter(id => id !== getSessionId())
if (sessionIds.length < cfg.minSessions) return

const priorMtime = await tryAcquireConsolidationLock()
// priorMtime => 1786060800000
// 若另一个进程持有锁，priorMtime => null，当前整理直接返回。
if (priorMtime === null) return
```

门槛通过后，`autoDream` 同样调用 `runForkedAgent()`，也复用 `createAutoMemCanUseTool(memoryRoot)`，所以它只能用 `Edit`、`Write` 修改 Memory 目录。不同的是 Prompt 要求它先看现有索引和必要的会话记录，再合并重复项、删除已失效或矛盾的内容，并保持 `MEMORY.md` 是短索引。

源码位置：`src/services/autoDream/consolidationPrompt.ts:10-87`

```javascript
// buildConsolidationPrompt(memoryRoot, transcriptDir, extra) 的关键要求
// 1. 读取 MEMORY.md 和已有主题文件，避免创建重复内容；
// 2. 只按需要搜索近期 JSONL 会话记录，不完整读取所有记录；
// 3. 更新主题正文，删除已被推翻的事实；
// 4. 更新 MEMORY.md：删除过期指针、补充新指针、解决冲突。

const result = await runForkedAgent({
  promptMessages: [createUserMessage({ content: prompt })],
  cacheSafeParams: createCacheSafeParams(context),
  canUseTool: createAutoMemCanUseTool(memoryRoot),
  querySource: 'auto_dream',
  forkLabel: 'auto_dream',
})
// result.messages => forked Agent 返回的 Read、Edit、Write Tool Use 与 Tool Result。
```

提取器处理「刚刚出现、值得留下的事」；`autoDream` 处理「留下很多之后，哪些该合并、修正或移除」。两者都由模型在受限 Tool 边界内决定具体文件改动，但触发频率和输入范围不同。

## 小结

Memory 有两条方向相反的链路。

- 写入时，主 Agent 可以直接用 `Write`、`Edit` 写入正文文件和 `MEMORY.md`；没有直接写入时，Stop Hook 启动受限的后台提取器，补充这两个文件。后续的 `autoDream` 再低频合并重复或过期内容。
- 读取时，新任务先把 `MEMORY.md` 的短索引放进首轮模型消息；预取任务并行扫描正文文件，用 `sideQuery()` 从名称和描述中选择相关项，再把正文作为隐藏消息加入后续请求。

索引负责让首轮请求立即看到长期约束，正文负责按需提供细节。这样既能保留跨会话信息，也不会在每次模型调用时塞入所有 Memory 正文。
