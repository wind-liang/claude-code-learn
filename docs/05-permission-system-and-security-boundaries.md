---
title: 5、一次 Tool 调用怎样通过权限检查
---

上一篇走到 `checkPermissionsAndCallTool()` 时，权限部分只保留了一个结论：只有 `behavior === 'allow'`，才会执行 `tool.call()`。

继续往下读，先遇到的问题不是权限规则，而是一串很像的函数名：

- `canUseTool()`；
- `hasPermissionsToUseTool()`；
- `hasPermissionsToUseToolInner()`；
- `tool.checkPermissions()`。

这一篇只固定一条 Tool Use，按照实际调用顺序往下追：

```javascript
// 本文固定的一次运行输入，不是源码中的常量。
const toolUse = {
  type: 'tool_use',
  id: 'toolu_05',
  name: 'Bash',
  input: {
    command: 'npm test',
    description: '运行测试',
  },
}
```

假设当前是交互模式，Permission Mode 为 `default`，配置中没有允许或拒绝 `npm test`，并且界面允许显示「不再询问」选项。

这次探索只回答三个问题：

1. `npm test` 按什么顺序经过权限代码；
2. 为什么最后得到 `ask`；
3. 用户点击允许以后，原来的 Tool 调用怎样继续执行。

## 调用关系链

![图 1：一次 Tool 调用的权限检查顺序](https://windliangblog.oss-cn-beijing.aliyuncs.com/diagram-01.png)

这张图可以先读成三段：

1. `runToolUse()` 把 Tool Use 送进权限系统；
2. 权限系统产生 `allow / deny / ask`；
3. 执行层根据结果执行、拒绝或等待用户。

其中只有 `ask` 会进入权限确认界面：

- `allow` 继续调用当前 Tool 的 `call()`；
- `deny` 直接生成错误 Tool Result；
- `ask` 加入权限确认队列，等用户选择以后再转成 `allow` 或 `deny`。

## 第一段：`canUseTool` 从 REPL 一路传到 Tool 执行层

交互模式下，REPL 先调用 `useCanUseTool()`，得到一个名为 `canUseTool` 的函数。

源码位置：`src/screens/REPL.tsx:2382`

```javascript
const canUseTool = useCanUseTool(
  setToolUseConfirmQueue,
  setToolPermissionContext,
)
```

这两个参数分别用于：

- 更新权限确认队列，让界面显示待确认的 Tool；
- 更新当前会话的 `ToolPermissionContext`。

REPL 随后把 `canUseTool` 传给 `query()`。

源码位置：`src/screens/REPL.tsx:2793-2803`

```javascript
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
```

`query()` 和 `queryLoop()` 没有在这里计算权限，只是继续把这个函数交给 Tool 调度与执行代码。最后，上一篇讲过的 `checkPermissionsAndCallTool()` 收到它。

源码位置：`src/services/tools/toolExecution.ts:599-929`

```javascript
async function checkPermissionsAndCallTool(
  tool,
  toolUseID,
  input,
  toolUseContext,
  canUseTool,
  assistantMessage,
) {
  // tool.name => 'Bash'
  // toolUseID => 'toolu_05'
  // input.command => 'npm test'

  // 参数校验和 PreToolUse Hook 已经完成
  // hookPermissionResult => undefined

  const resolved =
    await resolveHookPermissionDecision(
      hookPermissionResult,
      tool,
      input,
      toolUseContext,
      canUseTool,
      assistantMessage,
      toolUseID,
    )

  const permissionDecision = resolved.decision

  if (permissionDecision.behavior !== 'allow') {
    // 不调用 tool.call()，返回错误 Tool Result
    return resultingMessages
  }

  // 只有 allow 才继续执行 Tool
  // ...
}
```

`resolveHookPermissionDecision()` 位于 Hook 与普通权限判断之间。本文假设 Hook 没有做决定，因此会走到 `canUseTool()`。

源码位置：`src/services/tools/toolHooks.ts:332-433`

```javascript
async function resolveHookPermissionDecision(
  hookPermissionResult,
  tool,
  input,
  toolUseContext,
  canUseTool,
  assistantMessage,
  toolUseID,
) {
  if (hookPermissionResult?.behavior === 'deny') {
    return {
      decision: hookPermissionResult,
      input,
    }
  }

  // Hook allow 等分支省略
  // ...

  return {
    decision: await canUseTool(
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseID,
    ),
    input,
  }
}
```

到这里，第一段调用顺序已经连起来：REPL 创建 `canUseTool`，`query()` 负责向下传，Tool 执行层最终调用它。

从调用关系能直接观察到一个效果：Tool 执行代码没有直接操作 React 界面。它只调用一个函数并等待权限结果。交互 CLI、Print 或其他运行方式可以提供不同的 `canUseTool` 实现，而 `runToolUse()` 不需要跟着重写。

## 第二段：`canUseTool()` 怎样进入核心权限判断

接着打开 `useCanUseTool.tsx`。刚才由 REPL 创建的 `canUseTool()`，内部会调用 `hasPermissionsToUseTool()`。

源码位置：`src/hooks/useCanUseTool.tsx:28-190`

```javascript
function useCanUseTool(
  setToolUseConfirmQueue,
  setToolPermissionContext,
) {
  return async function canUseTool(
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseID,
  ) {
    return new Promise(resolve => {
      const ctx = createPermissionContext(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
        setToolPermissionContext,
        createPermissionQueueOps(
          setToolUseConfirmQueue,
        ),
      )

      const decisionPromise =
        hasPermissionsToUseTool(
          tool,
          input,
          toolUseContext,
          assistantMessage,
          toolUseID,
        )

      decisionPromise.then(async result => {
        // 后面根据 allow / deny / ask 处理
        // ...
      })
    })
  }
}
```

`hasPermissionsToUseTool()` 是外层包装，第一步又会调用 `hasPermissionsToUseToolInner()`。

源码位置：`src/utils/permissions/permissions.ts:473-960`

```javascript
export const hasPermissionsToUseTool = async (
  tool,
  input,
  context,
  assistantMessage,
  toolUseID,
) => {
  const result = await hasPermissionsToUseToolInner(
    tool,
    input,
    context,
  )

  // Inner 先产生基础结果；
  // 外层再处理 dontAsk 和无法显示权限提示的运行环境等情况。
  // ...

  return result
}
```

至此前三个相似函数的位置可以对应起来：

| 函数 | 在这条调用链中的作用 |
| --- | --- |
| `canUseTool()` | 连接权限结果与权限确认界面 |
| `hasPermissionsToUseTool()` | 在 Inner 结果之上处理 `dontAsk` 和无法显示权限提示的运行环境等外层分支 |
| `hasPermissionsToUseToolInner()` | 按「整项 deny / ask → Tool 自身判断 → bypass/plan 与整项 allow」的顺序计算结果，并把最后的 `passthrough` 转成 `ask` |

下面进入 `hasPermissionsToUseToolInner()`，开始代入 `npm test`。

## 第三段：先检查整项 deny / ask，再交给 BashTool

假设项目的 `.claude/settings.json` 是：

```javascript
{
  permissions: {
    allow: [
      'Grep',
      'Read(./src/**)',
    ],
    deny: [
      'Bash(rm:*)',
    ],
    ask: [
      'Bash(npm publish:*)',
    ],
    defaultMode: 'default',
  },
}
```

启动时，这些规则已经被整理到 `ToolPermissionContext` 中。与本例有关的运行值是：

```javascript
toolPermissionContext
// => {
//   mode: 'default',
//
//   alwaysAllowRules: {
//     projectSettings: [
//       'Grep',
//       'Read(./src/**)',
//     ],
//   },
//
//   alwaysDenyRules: {
//     projectSettings: [
//       'Bash(rm:*)',
//     ],
//   },
//
//   alwaysAskRules: {
//     projectSettings: [
//       'Bash(npm publish:*)',
//     ],
//   },
// }
```

整项规则分成两类：

- 整项 deny / ask 是限制规则，先检查；
- 整项 allow 是放行规则，要等 BashTool 检查完具体命令以后再检查。

所以这里还没有完成全部通用权限判断。`hasPermissionsToUseToolInner()` 现在只检查是否存在针对整个 Bash Tool 的 deny 或 ask 规则。

源码位置：`src/utils/permissions/permissions.ts:1158-1210`

```javascript
async function hasPermissionsToUseToolInner(
  tool,
  input,
  context,
) {
  let appState = context.getAppState()

  const denyRule = getDenyRuleForTool(
    appState.toolPermissionContext,
    tool,
  )
  // 配置中只有 Bash(rm:*)，不是整项 Bash deny
  // denyRule => null

  if (denyRule) {
    return {
      behavior: 'deny',
      decisionReason: {
        type: 'rule',
        rule: denyRule,
      },
      message:
        `Permission to use ${tool.name} has been denied.`,
      // tool.name => 'Bash'
    }
  }

  const askRule = getAskRuleForTool(
    appState.toolPermissionContext,
    tool,
  )
  // 配置中只有 Bash(npm publish:*)，不是整项 Bash ask
  // askRule => null

  // 没有整项 deny / ask，继续交给 BashTool 检查具体命令
  // ...
}
```

继续进入 `getDenyRuleForTool()`，可以看到它遍历所有 deny 规则，并调用 `toolMatchesRule()` 判断每条规则是否匹配整个 Tool。源码把 `find()` 和默认值写在一行；下面把中间值展开，便于看清 `false → undefined → null` 的过程。

源码位置：`src/utils/permissions/permissions.ts:238-301`

```javascript
function getDenyRuleForTool(context, tool) {
  // tool.name => 'Bash'

  const denyRules = getDenyRules(context)
  // => [{
  //   source: 'projectSettings',
  //   ruleBehavior: 'deny',
  //   ruleValue: {
  //     toolName: 'Bash',
  //     ruleContent: 'rm:*',
  //   },
  // }]

  const matchedRule = denyRules.find(
    rule => toolMatchesRule(tool, rule),
  )
  // 当前只有 Bash(rm:*)，toolMatchesRule() 返回 false
  // matchedRule => undefined

  // matchedRule || null
  // => null，没有命中「拒绝整个 Bash Tool」的规则
  return matchedRule || null
}

function toolMatchesRule(tool, rule) {
  // tool.name => 'Bash'
  // rule.ruleValue.toolName => 'Bash'
  // rule.ruleValue.ruleContent => 'rm:*'

  // 规则带有具体内容时，不属于「整个 Tool」规则
  if (rule.ruleValue.ruleContent !== undefined) {
    // 'rm:*' !== undefined，因此进入这里
    return false
  }

  const nameForRuleMatch =
    getToolNameForPermissionCheck(tool)
  // 内置 Bash Tool 在这里仍然是 'Bash'。
  // nameForRuleMatch => 'Bash'

  if (rule.ruleValue.toolName === nameForRuleMatch) {
    return true
  }

  // MCP Server 级规则的匹配分支省略；
  // 本例不是 MCP Tool。
  return false
}
```

因此调用关系是：`hasPermissionsToUseToolInner()` 先调用 `getDenyRuleForTool()`；`getDenyRuleForTool()` 遍历 deny 规则时，再逐条调用 `toolMatchesRule()`。

两种规则的区别是：

- `Bash`：拒绝所有 Bash 调用，在这里就会命中；
- `Bash(rm:*)`：只拒绝匹配 `rm:*` 的命令，因为带有具体内容，所以这里先跳过。

后面进入 `BashTool.checkPermissions()` 时，才会拿 `npm test` 与 `rm:*` 比较。本例不匹配，因此不会被这条 deny 规则拒绝。

同一个函数接着调用 `tool.checkPermissions()`：

```javascript
async function hasPermissionsToUseToolInner(
  tool,
  input,
  context,
) {
  // 前面的整项 deny / ask 没有命中
  // ...

  const parsedInput = tool.inputSchema.parse(input)
  // parsedInput.command => 'npm test'

  const toolPermissionResult =
    await tool.checkPermissions(
      parsedInput,
      context,
    )

  // 对本例来说，实际调用 BashTool.checkPermissions()
  // ...
}
```

`tool.checkPermissions()` 在这里首次出现。它是 `hasPermissionsToUseToolInner()` 中的一步，用来把具体输入交给当前 Tool 判断，并不是另一套权限流程。

Read、Grep、Glob 会解释路径，Bash Tool 会解释命令、管道、重定向和路径限制。运行时创建的 MCP Tool 不解析输入内容，而是返回 `passthrough`，并建议保存完整 MCP Tool 名称的规则。

到这里，`permissions.ts` 只决定检查顺序，并调用 `tool.checkPermissions()`；它不会判断 `npm test` 是什么命令。接下来要进入 `BashTool`，查看 Bash 自己怎样匹配命令规则。

这层拆分带来的效果可以直接从代码确认：新增一种 Tool 时，具体输入的解释逻辑放进该 Tool 的 `checkPermissions()`；整个 Tool 规则、Permission Mode 与最终兜底顺序留在通用权限层。Bash 命令内部的 deny、ask、allow 顺序仍由 BashTool 自己处理。这样，通用规则和 Tool 输入语义不会堆在同一个巨大函数里。

## 第四段：BashTool 为什么没有直接允许 `npm test`

对 Bash Tool 来说，`checkPermissions()` 会进入 `bashToolHasPermission()`。

源码位置：`src/tools/BashTool/BashTool.tsx:539-541`

```javascript
export const BashTool = buildTool({
  // ...

  async checkPermissions(input, context) {
    return bashToolHasPermission(input, context)
  },
})
```

内部会检查精确规则、命令规则、路径与模式。只保留本例经过的主线后，可以看到：

源码位置：`src/tools/BashTool/bashPermissions.ts:1183-1255`

```javascript
async function checkCommandAndSuggestRules(
  input,
  permissionContext,
  commandPrefixResult,
) {
  // input.command => 'npm test'
  // commandPrefixResult => null

  const exactMatchResult =
    bashToolCheckExactMatchPermission(
      input,
      permissionContext,
    )
  // 没有 Bash(npm test) 精确规则
  // exactMatchResult.behavior => 'passthrough'

  if (exactMatchResult.behavior !== 'passthrough') {
    return exactMatchResult
  }

  const permissionResult = bashToolCheckPermission(
    input,
    permissionContext,
  )
  // Bash(rm:*) 不匹配 npm test
  // Bash(npm publish:*) 也不匹配 npm test
  // npm test 不能被静态确认为安全的只读命令
  // permissionResult.behavior => 'passthrough'

  // 源码随后还会处理显式 deny / ask，
  // 并检查命令注入；本例都没有命中。
  // ...

  const suggestedUpdates =
    commandPrefixResult?.commandPrefix
      ? suggestionForPrefix(
          commandPrefixResult.commandPrefix,
        )
      : suggestionForExactCommand(input.command)
  // commandPrefixResult => null，因此调用
  // suggestionForExactCommand('npm test')
  // 该函数会为普通单行命令提取两词前缀。
  // suggestedUpdates => [{
  //   type: 'addRules',
  //   rules: [{
  //     toolName: 'Bash',
  //     ruleContent: 'npm test:*',
  //   }],
  //   behavior: 'allow',
  //   destination: 'localSettings',
  // }]

  return {
    ...permissionResult,
    suggestions: suggestedUpdates,
  }
}
```

上面两个内部函数决定了 `exactMatchResult` 和 `permissionResult` 的值，继续分别展开。

### `bashToolCheckExactMatchPermission()`：检查完整命令

源码位置：`src/tools/BashTool/bashPermissions.ts:991-1048`

```javascript
function bashToolCheckExactMatchPermission(
  input,
  permissionContext,
) {
  const command = input.command.trim()
  // => 'npm test'

  const {
    matchingDenyRules,
    matchingAskRules,
    matchingAllowRules,
  } = matchingRulesForInput(
    input,
    permissionContext,
    'exact',
  )
  // 当前没有完整内容等于 npm test 的规则
  // matchingDenyRules  => []
  // matchingAskRules   => []
  // matchingAllowRules => []

  if (matchingDenyRules[0] !== undefined) {
    // 本例不进入；完整返回对象省略。
    return { behavior: 'deny' }
  }

  if (matchingAskRules[0] !== undefined) {
    // 本例不进入；完整返回对象省略。
    return { behavior: 'ask' }
  }

  if (matchingAllowRules[0] !== undefined) {
    // 本例不进入；完整返回对象省略。
    return { behavior: 'allow' }
  }

  const decisionReason = {
    type: 'other',
    reason: 'This command requires approval',
  }

  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(
      BashTool.name,
      decisionReason,
    ),
    decisionReason,
    suggestions: suggestionForExactCommand(command),
  }
}
```

`Bash(rm:*)` 和 `Bash(npm publish:*)` 都不是 `npm test` 的精确规则，因此三个数组都是空数组，函数返回 `passthrough`。

### `bashToolCheckPermission()`：继续检查前缀、路径和模式

源码位置：`src/tools/BashTool/bashPermissions.ts:1050-1180`

```javascript
function bashToolCheckPermission(
  input,
  permissionContext,
) {
  const command = input.command.trim()
  // command => 'npm test'

  const exactMatchResult =
    bashToolCheckExactMatchPermission(
      input,
      permissionContext,
    )
  // exactMatchResult.behavior => 'passthrough'

  const {
    matchingDenyRules,
    matchingAskRules,
    matchingAllowRules,
  } = matchingRulesForInput(
    input,
    permissionContext,
    'prefix',
  )
  // Bash(rm:*)：npm test 不以 rm 开头
  // matchingDenyRules => []
  //
  // Bash(npm publish:*)：npm test 不以 npm publish 开头
  // matchingAskRules => []
  //
  // 当前没有 Bash allow 规则
  // matchingAllowRules => []

  if (matchingDenyRules[0] !== undefined) {
    // 本例不进入；完整返回对象省略。
    return { behavior: 'deny' }
  }

  if (matchingAskRules[0] !== undefined) {
    // 本例不进入；完整返回对象省略。
    return { behavior: 'ask' }
  }

  const pathResult = checkPathConstraints(
    input,
    getCwd(),
    permissionContext,
  )
  // npm test 没有触发路径限制
  // pathResult.behavior => 'passthrough'

  if (pathResult.behavior !== 'passthrough') {
    return pathResult
  }

  // 源码先处理精确 allow；本例仍是 passthrough。
  if (exactMatchResult.behavior === 'allow') {
    return exactMatchResult
  }

  if (matchingAllowRules[0] !== undefined) {
    // 本例不进入；完整返回对象省略。
    return { behavior: 'allow' }
  }

  // sed 安全限制没有被本例触发。
  // ...

  const modeResult = checkPermissionMode(
    input,
    permissionContext,
  )
  // permissionContext.mode => 'default'
  // modeResult.behavior => 'passthrough'

  if (modeResult.behavior !== 'passthrough') {
    return modeResult
  }

  // BashTool.isReadOnly({ command: 'npm test' })
  // => false，本例不进入该分支
  if (BashTool.isReadOnly(input)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Read-only command is allowed',
      },
    }
  }

  const decisionReason = {
    type: 'other',
    reason: 'This command requires approval',
  }

  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(
      BashTool.name,
      decisionReason,
    ),
    decisionReason,
    suggestions: suggestionForExactCommand(command),
  }
}
```

因此 `bashToolCheckPermission()` 也没有得到明确的 deny、ask 或 allow，最终仍然返回 `passthrough`。

`passthrough` 是 Tool 内部的中间结果，意思是「BashTool 没有足够依据自动允许或拒绝」。它不是最终交给执行层的第四种权限结果。

`passthrough` 与 `ask` 分开很关键：前者表示「这一层不做决定」，后者表示「最终需要用户确认」。如果两者都用 `ask` 表示，外层还要额外判断这究竟是明确的询问规则，还是当前层没有匹配结果。保留一个「无意见」状态后，Permission Mode 和整项 allow 等后续规则可以继续判断，最后再由通用层收口成 `ask`。

`npm test` 没有被自动视为只读，是因为它实际运行什么取决于 `package.json`。源码没有根据命令名称猜测脚本行为。

同时，BashTool 生成了一条建议规则 `Bash(npm test:*)`，并把它放进 `permissionResult.suggestions`。这条建议会继续传到权限确认界面。对于本例这种单条 Bash 命令，界面会把 `npm test:*` 放进可编辑输入框；用户不修改时，最终保存的规则内容仍然是 `npm test:*`。后面会继续看到 `suggestions` 和 `editablePrefix` 怎样一起决定界面选项。

## 第五段：`passthrough` 怎样变成 `ask`

拿到 BashTool 的结果后，执行位置回到同一个 `hasPermissionsToUseToolInner()`。这不是进入另一套通用权限，而是继续执行前面尚未完成的后半段：先处理 BashTool 返回的限制结果，再检查通用的放行规则。

源码把通用权限拆在 BashTool 前后，顺序可以压缩成：

1. 整项 deny / ask；
2. BashTool 对具体命令给出的 deny / ask / allow / `passthrough`；
3. Permission Mode 与整项 allow；
4. 仍是 `passthrough` 时转成 `ask`。

这样排列是为了让限制规则优先。例如同时配置 `allow: ['Bash']` 和 `deny: ['Bash(rm:*)']` 时，`rm -rf build` 会先被 BashTool 的命令级 deny 拦住，不会被后面的整项 `Bash` allow 覆盖。

源码位置：`src/utils/permissions/permissions.ts:1210-1311`

```javascript
async function hasPermissionsToUseToolInner(
  tool,
  input,
  context,
) {
  let appState = context.getAppState()

  // 前面得到的结果
  // toolPermissionResult.behavior => 'passthrough'
  // toolPermissionResult.suggestions
  // => [添加 Bash(npm test:*) allow 规则]

  // 明确 deny、必须交互、显式 ask 和安全检查先返回
  if (toolPermissionResult.behavior === 'deny') {
    return toolPermissionResult
  }

  if (
    tool.requiresUserInteraction?.() &&
    toolPermissionResult.behavior === 'ask'
  ) {
    return toolPermissionResult
  }

  if (
    toolPermissionResult.behavior === 'ask' &&
    toolPermissionResult.decisionReason?.type === 'rule' &&
    toolPermissionResult.decisionReason
      .rule.ruleBehavior === 'ask'
  ) {
    return toolPermissionResult
  }

  if (
    toolPermissionResult.behavior === 'ask' &&
    toolPermissionResult.decisionReason?.type === 'safetyCheck'
  ) {
    return toolPermissionResult
  }

  // Tool 检查期间状态可能变化，因此重新取得最新状态
  appState = context.getAppState()

  const shouldBypassPermissions =
    appState.toolPermissionContext.mode ===
      'bypassPermissions' ||
    (
      appState.toolPermissionContext.mode === 'plan' &&
      appState.toolPermissionContext
        .isBypassPermissionsModeAvailable
    )
  // 本例 mode === 'default'
  // shouldBypassPermissions => false

  if (shouldBypassPermissions) {
    return {
      behavior: 'allow',
      updatedInput: getUpdatedInputOrFallback(
        toolPermissionResult,
        input,
      ),
      // decisionReason 等字段省略
    }
  }

  // 到这里才检查允许整个 Bash Tool 的通用规则
  const alwaysAllowedRule = toolAlwaysAllowedRule(
    appState.toolPermissionContext,
    tool,
  )
  // 当前 allow 里只有 Grep 和 Read(./src/**)，没有 Bash
  // alwaysAllowedRule => null

  if (alwaysAllowedRule) {
    return {
      behavior: 'allow',
      updatedInput: getUpdatedInputOrFallback(
        toolPermissionResult,
        input,
      ),
      // decisionReason 等字段省略
    }
  }

  // Tool 无法决定时，通用层统一转换为 ask
  return toolPermissionResult.behavior === 'passthrough'
    ? {
        ...toolPermissionResult,
        behavior: 'ask',
        message: createPermissionRequestMessage(
          tool.name,
          toolPermissionResult.decisionReason,
        ),
      }
    : toolPermissionResult
}
```

因此，本例在 Inner 中得到的基础结果是：

```javascript
result
// => {
//   behavior: 'ask',
//   message: 'This command requires approval',
//   suggestions: [{
//     type: 'addRules',
//     rules: [{
//       toolName: 'Bash',
//       ruleContent: 'npm test:*',
//     }],
//     behavior: 'allow',
//     destination: 'localSettings',
//   }],
// }
```

这时外层 `hasPermissionsToUseTool()` 还会根据运行环境处理一次。

当前 mode 是 `default`，所以结果保持 `ask`。如果是 `dontAsk`，外层会把它转换成 `deny`；如果当前运行环境无法显示权限提示，还会进入对应的拒绝分支。

现在，权限计算阶段结束，代码回到 `canUseTool()`。

## 第六段：`ask` 怎样暂停 Tool，等待用户

再次回到 `useCanUseTool.tsx` 中刚才没有展开的 `.then()`：

```javascript
function useCanUseTool(/* ... */) {
  return async function canUseTool(
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseID,
  ) {
    return new Promise(resolve => {
      const ctx = createPermissionContext(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
        setToolPermissionContext,
        createPermissionQueueOps(
          setToolUseConfirmQueue,
        ),
      )

      const decisionPromise =
        hasPermissionsToUseTool(
          tool,
          input,
          toolUseContext,
          assistantMessage,
          toolUseID,
        )

      decisionPromise.then(async result => {
        // result.behavior => 'ask'

        if (result.behavior === 'allow') {
          resolve(
            ctx.buildAllow(result.updatedInput ?? input),
          )
          return
        }

        const description = await tool.description(
          input,
          // 其他参数省略
        )
        // 本例 input.description => '运行测试'
        // 因此 description       => '运行测试'

        switch (result.behavior) {
          case 'deny':
            resolve(result)
            return

          case 'ask':
            // ask 不立即 resolve
            handleInteractivePermission(
              {
                ctx,
                result,
                description,
                // ...
              },
              resolve,
            )
            return
        }
      })
    })
  }
}
```

`'运行测试'` 不是 Claude Code 源码里的固定文字。本文开头的 Tool Use 示例把 `input.description` 设为了 `'运行测试'`，而 `BashTool.description()` 会返回这个字段；没有传入时才返回 `'Run shell command'`。

`allow` 可以直接结束 Promise；`deny` 会先准备展示文字，然后结束 Promise。`ask` 则把请求放进确认队列，暂时保留 `resolveOnce`。

源码位置：`src/hooks/toolPermission/handlers/interactiveHandler.ts:57-190`

```javascript
function handleInteractivePermission(
  { ctx, result, description },
  resolve,
) {
  const {
    resolve: resolveOnce,
    isResolved,
    claim,
  } = createResolveOnce(resolve)

  const displayInput =
    result.updatedInput ?? ctx.input

  ctx.pushToQueue({
    tool: ctx.tool,
    input: displayInput,
    toolUseID: ctx.toolUseID,
    description,
    permissionResult: result,

    async onAllow(updatedInput, permissionUpdates) {
      if (!claim()) return

      resolveOnce(
        await ctx.handleUserAllow(
          updatedInput,
          permissionUpdates,
        ),
      )
    },

    onReject(feedback) {
      if (!claim()) return
      resolveOnce(ctx.cancelAndAbort(feedback))
    },

    async recheckPermission() {
      if (isResolved()) return
      // 权限上下文发生变化时重新检查；其余代码省略。
      // ...
    },
  })
}
```

`resolveOnce`、`claim` 和 `isResolved` 都来自 `createResolveOnce()`。

源码位置：`src/hooks/toolPermission/PermissionContext.ts:75-90`

```javascript
function createResolveOnce(resolve) {
  let claimed = false
  let delivered = false

  return {
    resolve(value) {
      if (delivered) return

      delivered = true
      claimed = true
      resolve(value)
    },

    isResolved() {
      return claimed
    },

    claim() {
      if (claimed) return false

      claimed = true
      return true
    },
  }
}
```

这段代码解释了 `ask` 的实际运行方式：不是先返回失败，等用户允许后重新执行整个请求；而是原来的 `canUseTool()` Promise 一直等待。用户点击按钮后，回调通过 `resolveOnce()` 恢复原调用链。

这样处理的直接结果是：确认前后的仍是同一次 Tool 调用，原来的 `toolUseID`、输入和已经完成的 Hook 结果都还在，不需要重新构造请求，也不会为了等待确认再跑一遍前面的检查。

这里不是说用户会连续选择多次。对于用户来说，确认框最终当然只有一个结果；但对程序来说，同一个待确认请求可以被多个独立来源结束：终端里的允许或拒绝、用户中断、权限规则变化后的重新检查，以及网页端或其他远程通道的确认结果。

这些回调可能先后到达。例如用户点击允许后，`onAllow()` 会等待 `ctx.handleUserAllow()` 保存权限；`await` 期间如果用户又按下中断键，`onAbort()` 也会被触发。JavaScript 虽然是单线程，但第一个异步回调等待时，事件循环仍然可以执行第二个回调。

原生 Promise 本来就只接受第一次 `resolve()`，但这还不够：第二个回调即使无法改变 Promise 的结果，仍然可能保存规则、记录日志或中止 Tool。

`claim()` 因此会在这些路径开始处理前「抢占处理权」。第一次调用返回 `true`，并立即把内部的 `claimed` 标记为 `true`；之后其他路径再调用只会得到 `false`，随即退出。如果 `onAllow()` 先抢到处理权，那么它等待保存权限期间发生的中断也不会再执行另一套收尾逻辑。

所以两个状态的含义不同：`claimed` 表示已经有路径抢到处理权，`delivered` 表示获胜路径已经把最终结果交给原 Promise。`claim()` 在 `await` 之前设置前者；异步处理结束后，`resolveOnce()` 再设置后者并调用原始 `resolve()`。

到这里可以确认：权限计算与界面交互通过 Promise 和队列连接，底层权限函数本身不直接渲染 React 界面。

## 第七段：点击选项后，当前调用和后续规则怎样处理

先把上一段和界面连接起来。第六段的 `canUseTool()` 创建了一个 Promise；遇到 `ask` 后，它把这个 Promise 的 `resolve` 传给 `handleInteractivePermission()`。后者调用 `ctx.pushToQueue({...})`，把 `onAllow()`、`onReject()` 等回调放进权限确认队列。

界面从队列中取出这个对象后，把它命名为 `toolUseConfirm`。因此 `toolUseConfirm` 不是新的权限判断，也没有再次调用 `canUseTool()`；它就是上一段 `ctx.pushToQueue()` 放进去的对象，内部回调仍然连接着原来那个尚未结束的 Promise。

对应关系是：`canUseTool()` 创建 Promise → `handleInteractivePermission()` 把回调加入队列 → 界面以 `toolUseConfirm` 接收队列元素 → 用户选择触发其中一个回调。

接下来只需要追踪 `toolUseConfirm` 的三个回调：

- 只允许本次：`onAllow(input, [])`；
- 允许并保存规则：`onAllow(input, [PermissionUpdate])`；
- 拒绝：`onReject()`。

前两条路径都返回 `allow`，区别只在 `onAllow()` 的第二个参数。下面按实际执行顺序来看。

### 1. 权限界面先拿到命令和规则建议

源码位置：`src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx:71-308、320、466`

```javascript
function BashPermissionRequest({ toolUseConfirm, ...props }) {
  const { command } = BashTool.inputSchema.parse(
    toolUseConfirm.input,
  )
  // toolUseConfirm.input
  // => { command: 'npm test', description: '运行测试' }
  // command => 'npm test'

  return (
    <BashPermissionRequestInner
      {...props}
      toolUseConfirm={toolUseConfirm}
      command={command}
    />
  )
}

function BashPermissionRequestInner({
  toolUseConfirm,
  command,
}) {
  const suggestions =
    toolUseConfirm.permissionResult.suggestions
  // => [{
  //   type: 'addRules',
  //   rules: [{
  //     toolName: 'Bash',
  //     ruleContent: 'npm test:*',
  //   }],
  //   behavior: 'allow',
  //   destination: 'localSettings',
  // }]

  const [editablePrefix, setEditablePrefix] =
    useState(() => {
      const two = getSimpleCommandPrefix(command)
      // getSimpleCommandPrefix('npm test') => 'npm test'

      if (two) return `${two}:*`
      // editablePrefix => 'npm test:*'

      const one = getFirstWordPrefix(command)
      if (one) return `${one}:*`
      return command
    })

  const onEditablePrefixChange = useCallback(value => {
    setEditablePrefix(value)
  }, [])

  // 继续在同一个组件中，把刚得到的两份数据交给辅助函数。
  const options = useMemo(
    () => bashToolUseOptions({
      suggestions,
      editablePrefix,
      onEditablePrefixChange,
      // 反馈输入等其他参数省略。
    }),
    [
      suggestions,
      editablePrefix,
      onEditablePrefixChange,
    ],
  )
  // options => [
  //   { value: 'yes', ... },
  //   { value: 'yes-prefix-edited', ... },
  //   { value: 'no', ... },
  // ]

  // 组件接下来返回 PermissionDialog，
  // 其中的 Select 使用上面的 options。
  // ...
}
```

这里有两份看起来相似的数据：

- `suggestions` 来自前面的权限计算结果，表示「可以保存什么规则」；
- `editablePrefix` 由界面根据当前命令生成，是用户在确认框里看到并可修改的值。

在简单的 `npm test` 例子中，两者都包含 `npm test:*`，但来源不同。

执行顺序是：`BashPermissionRequestInner()` 先调用 `bashToolUseOptions()` 得到 `options`，然后才渲染 `Select`。`Select` 不会调用 `bashToolUseOptions()`，只负责显示已经生成好的选项。

源码中的 `Select` 位于同一组件返回的 `PermissionDialog` 内。下面是 `src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx:466` 的 `<Select>` 调用，仅做了折行：

```javascript
<Select
  options={
    feature('BASH_CLASSIFIER')
      ? toolUseConfirm.classifierAutoApproved
        ? options.map(o => ({
            ...o,
            disabled: true,
          }))
        : options
      : options
  }
  isDisabled={
    feature('BASH_CLASSIFIER')
      ? toolUseConfirm.classifierAutoApproved
      : false
  }
  inlineDescriptions
  onChange={onSelect}
  onCancel={() => handleReject()}
  onFocus={handleFocus}
  onInputModeToggle={handleInputModeToggle}
/>
```

### 2. 打开 `bashToolUseOptions()`，看它怎样生成三个选项

源码位置：`src/components/permissions/BashPermissionRequest/bashToolUseOptions.tsx:31-145`

```javascript
function bashToolUseOptions({
  suggestions,
  editablePrefix,
  onEditablePrefixChange,
}) {
  // 固定先加入「只允许本次」。
  const options = [{
    label: 'Yes',
    value: 'yes',
  }]

  if (shouldShowAlwaysAllowOptions()) {
    // 本例当前配置允许显示「不再询问」。
    // shouldShowAlwaysAllowOptions() => true

    const hasNonBashSuggestions = suggestions.some(
      suggestion =>
        suggestion.type === 'addDirectories' ||
        suggestion.rules?.some(
          rule => rule.toolName !== 'Bash',
        ),
    )
    // suggestions 里只有 Bash 规则。
    // hasNonBashSuggestions => false

    if (
      editablePrefix !== undefined &&
      onEditablePrefixChange &&
      !hasNonBashSuggestions &&
      suggestions.length > 0
    ) {
      // 上面四个条件在本例中都成立，
      // 所以生成一个可编辑的「以后不再询问」选项。
      options.push({
        type: 'input',
        label: 'Yes, and don’t ask again for',
        value: 'yes-prefix-edited',
        initialValue: editablePrefix,
        // => 'npm test:*'
        onChange: onEditablePrefixChange,
      })
    }
  }

  // 最后加入拒绝选项。
  options.push({
    label: 'No',
    value: 'no',
  })

  // options => [
  //   { value: 'yes' },
  //   {
  //     value: 'yes-prefix-edited',
  //     initialValue: 'npm test:*',
  //   },
  //   { value: 'no' },
  // ]
  return options
}
```

这段代码只是在生成界面选项，还没有修改权限，也没有执行 `npm test`。

### 3. `Select` 显示选项，点击后进入 `onSelect()`

源码位置：`src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx:320-425、466`

上面的源码片段已经把三者连起来了：`bashToolUseOptions()` 负责生成选项，`Select` 负责展示选项，用户点击后才由 `onChange` 调用 `onSelect()`。

下面三个代码块来自同一个 `onSelect()`。这里只是按用户选择拆开显示，并不是源码里存在三个同名函数。

如果用户选择「Yes」，界面传入空数组：

```javascript
function onSelect(value) {
  switch (value) {
    case 'yes': {
      toolUseConfirm.onAllow(
        toolUseConfirm.input,
        [],
        // => 没有 PermissionUpdate，不保存新规则
      )
      break
    }
  }
}
```

如果用户选择「Yes, and don’t ask again for: npm test:*」，界面把可编辑前缀组装成 `PermissionUpdate`：

```javascript
function onSelect(value) {
  if (value === 'yes-prefix-edited') {
    const trimmedPrefix =
      (editablePrefix ?? '').trim()
    // editablePrefix => 'npm test:*'
    // trimmedPrefix  => 'npm test:*'

    const prefixUpdates = [{
      type: 'addRules',
      rules: [{
        toolName: BashTool.name,
        // => 'Bash'
        ruleContent: trimmedPrefix,
        // => 'npm test:*'
      }],
      behavior: 'allow',
      destination: 'localSettings',
    }]

    toolUseConfirm.onAllow(
      toolUseConfirm.input,
      prefixUpdates,
      // => 允许本次，并保存 Bash(npm test:*)
    )
    return
  }
}
```

如果用户选择「No」，则不会进入上述两条 `allow` 路径：

```javascript
function onSelect(value) {
  switch (value) {
    case 'no': {
      toolUseConfirm.onReject()
      break
    }
  }
}
```

因此，「只允许一次」并不是一种特殊权限规则，而是这次 `onAllow()` 没有携带任何 `PermissionUpdate`。

这里把两个容易混淆的动作拆开了：`onAllow(input, [])` 只批准当前 Tool Use；只有显式携带 `PermissionUpdate`，才会扩大后续调用的权限。一次性同意不会被悄悄转换成长期规则，长期规则的内容和保存位置也都是可见数据。

复合命令可能产生多条 `suggestions`。那条分支使用 `yes-apply-suggestions`，直接把后端给出的多条建议传给 `onAllow()`；本例只有一条 Bash 规则，走的是 `yes-prefix-edited`。

### 4. `onAllow()` 恢复等待中的 Promise

源码位置：`src/hooks/toolPermission/handlers/interactiveHandler.ts:154-181`

```javascript
function handleInteractivePermission({ ctx }, resolve) {
  const {
    resolve: resolveOnce,
    claim,
  } = createResolveOnce(resolve)

  ctx.pushToQueue({
    // 这里只保留本文会进入的 onAllow 分支。
    // ...
    async onAllow(updatedInput, permissionUpdates) {
      if (!claim()) return
      // 只有最先到达的结束路径可以继续处理。

      // 只允许本次时：
      // permissionUpdates => []

      // 允许并保存时：
      // permissionUpdates => [{
      //   type: 'addRules',
      //   rules: [{
      //     toolName: 'Bash',
      //     ruleContent: 'npm test:*',
      //   }],
      //   behavior: 'allow',
      //   destination: 'localSettings',
      // }]

      resolveOnce(
        await ctx.handleUserAllow(
          updatedInput,
          permissionUpdates,
        ),
      )
    },
  })
}
```

`resolveOnce()` 解开上一段一直等待的 Promise。在解开之前，`handleUserAllow()` 先处理第二个参数。

源码位置：`src/hooks/toolPermission/PermissionContext.ts:139-146`、`src/hooks/toolPermission/PermissionContext.ts:291-317`

```javascript
function createPermissionContext(/* ... */) {
  return {
    async persistPermissions(updates) {
      if (updates.length === 0) return false
      // 「只允许本次」在这里直接返回，
      // 不写磁盘，也不修改内存规则。

      persistPermissionUpdates(updates)
      // destination === 'localSettings'
      // => .claude/settings.local.json 增加：
      // {
      //   "permissions": {
      //     "allow": ["Bash(npm test:*)"]
      //   }
      // }

      const appState = toolUseContext.getAppState()

      setToolPermissionContext(
        applyPermissionUpdates(
          appState.toolPermissionContext,
          updates,
        ),
      )
      // => 当前会话的 allow 规则也立即加入
      //    Bash(npm test:*)

      // 本例 destination === 'localSettings'
      // updates.some(...) => true
      return updates.some(update =>
        supportsPersistence(update.destination),
      )
    },

    async handleUserAllow(
      updatedInput,
      permissionUpdates,
    ) {
      await this.persistPermissions(permissionUpdates)

      // 日志、用户反馈等与本例主线无关的字段省略。
      // ...

      const allowDecision =
        this.buildAllow(updatedInput)
      // allowDecision => {
      //   behavior: 'allow',
      //   updatedInput: {
      //     command: 'npm test',
      //     description: '运行测试',
      //   },
      // }

      return allowDecision
    },
  }
}
```

这里的 `persistPermissionUpdates()` 只负责持久化，也就是把可以写入配置文件的更新逐条保存。它本身不修改当前会话的内存权限。

源码位置：`src/utils/permissions/PermissionUpdate.ts:208-240、349-353`

```javascript
export function supportsPersistence(destination) {
  return (
    destination === 'localSettings' ||
    destination === 'userSettings' ||
    destination === 'projectSettings'
  )
}

export function persistPermissionUpdates(updates) {
  for (const update of updates) {
    persistPermissionUpdate(update)
  }
}

export function persistPermissionUpdate(update) {
  if (!supportsPersistence(update.destination)) return
  // destination 为 session 或 cliArg 时不写配置文件。

  switch (update.type) {
    case 'addRules': {
      addPermissionRulesToSettings(
        {
          ruleValues: update.rules,
          // => [{
          //   toolName: 'Bash',
          //   ruleContent: 'npm test:*',
          // }]
          ruleBehavior: update.behavior,
          // => 'allow'
        },
        update.destination,
        // => 'localSettings'
      )
      break
    }

    // addDirectories、removeRules、setMode 等分支省略。
  }
}
```

本例进入 `addRules` 分支。正常情况下，`addPermissionRulesToSettings()` 会读取现有的本地配置、过滤重复规则，再把 `Bash(npm test:*)` 追加到 `permissions.allow`，最后更新 `.claude/settings.local.json`。

随后执行的 `applyPermissionUpdates()` 才负责修改内存中的 `ToolPermissionContext`。所以同一条规则会更新到两处：内存状态供当前会话立即使用，配置文件供之后启动时重新加载。

对于本例的 `destination === 'localSettings'`，两步都需要：只写配置文件，当前会话仍可能继续使用已经加载的旧权限上下文；只改内存，重新启动后规则又会消失。源码把「怎样落盘」和「怎样改变运行状态」拆成两个函数，再由 `persistPermissions()` 连续调用。`session` 规则只更新内存，本来就不需要写入配置文件。

Promise 最终返回 `allow` 后，Tool 执行层才会继续向下运行。

源码位置：`src/services/tools/toolExecution.ts:921-931`、`src/services/tools/toolExecution.ts:1128-1132`、`src/services/tools/toolExecution.ts:1207-1222`

```javascript
async function checkPermissionsAndCallTool(
  tool,
  toolUseID,
  input,
  toolUseContext,
  canUseTool,
  assistantMessage,
) {
  let processedInput = input

  const resolved =
    await resolveHookPermissionDecision(/* ... */)
  // 点击允许前，这个 await 一直没有结束。

  const permissionDecision = resolved.decision
  // => {
  //   behavior: 'allow',
  //   updatedInput: {
  //     command: 'npm test',
  //     description: '运行测试',
  //   },
  // }

  if (permissionDecision.behavior !== 'allow') {
    return resultingMessages
  }

  if (permissionDecision.updatedInput !== undefined) {
    processedInput = permissionDecision.updatedInput
  }

  const result = await tool.call(
    processedInput,
    toolUseContext,
    // 其他参数省略
  )
  // => 到这里才真正执行 npm test

  // Tool Result 封装分支省略。
  // ...
}
```

整段链路可以收成一句话：界面先把用户选择转成 `onAllow(input, permissionUpdates)`，权限层再根据 `permissionUpdates` 是否为空决定要不要保存规则，最后返回 `allow` 让原来的 Tool 调用继续。

## 权限判断实际按什么顺序返回

`npm test` 的正常路径走完以后，再看权限判断的其他分支，可以发现 deny、显式 ask 和安全检查都位于普通 allow 与 `bypassPermissions` 之前。

![图 2：权限判断的先后顺序](https://windliangblog.oss-cn-beijing.aliyuncs.com/diagram-02.png)

这个顺序可以从源码确认：

1. 先检查整项 deny 与 ask；
2. Tool 内部再检查具体 deny、ask 和 `safetyCheck`；
3. 前面的分支都没有返回，才处理 `bypassPermissions` 和整项 allow；
4. 仍然无法决定时，转成 `ask`。

因此，当前实现具有下面这些可观察行为：

- 明确 deny 不会被后面的 allow 覆盖；
- `Bash(npm publish:*)` 这类显式 ask 不会被 `bypassPermissions` 跳过；
- 敏感路径产生的 `safetyCheck` 仍然优先；
- Hook 返回 allow 后，源码还会重新检查显式 deny 与 ask。

## 常见的五种 Permission Mode 改变了什么

Permission Mode 不是另一套权限规则。deny、ask、allow 规则仍然照常匹配，模式只在这条调用链的特定位置改变处理结果。

继续使用前面的 `npm test`：它没有命中任何规则，BashTool 返回 `passthrough`。下面分别看五种模式会怎样处理它。

### `default`：无法决定就询问

`default` 没有专门的判断分支。其他规则都没有给出结果时，`hasPermissionsToUseToolInner()` 最后把 `passthrough` 转成 `ask`。

```javascript
// src/utils/permissions/permissions.ts:1299-1310
const result =
  toolPermissionResult.behavior === 'passthrough'
    ? {
        ...toolPermissionResult,
        behavior: 'ask',
        // 本例从 passthrough 变成 ask
      }
    : toolPermissionResult
```

所以本例会显示权限确认框。

### `acceptEdits`：只放宽部分文件操作

这个模式由 BashTool 内部的 `checkPermissionMode()` 处理。它会自动允许 `mkdir`、`touch`、`rm`、`rmdir`、`mv`、`cp` 和 `sed` 这几类文件操作。

```javascript
// src/tools/BashTool/modeValidation.ts:23-55
const [baseCmd] = input.command.trim().split(/\s+/)
// baseCmd => 'npm'

if (
  toolPermissionContext.mode === 'acceptEdits' &&
  isFilesystemCommand(baseCmd)
  // isFilesystemCommand('npm') => false
) {
  return { behavior: 'allow' }
}

return { behavior: 'passthrough' }
```

`npm test` 的基础命令是 `npm`，不在自动允许列表中，因此它最终仍然得到 `ask`。如果本例换成 `mkdir logs`，这里会直接得到 `allow`。

### `dontAsk`：原本需要询问的调用直接拒绝

Inner 仍然先按普通规则得到 `ask`。外层 `hasPermissionsToUseTool()` 发现当前是 `dontAsk`，再把结果改成 `deny`。

```javascript
// src/utils/permissions/permissions.ts:503-517
if (result.behavior === 'ask') {
  const appState = context.getAppState()

  if (appState.toolPermissionContext.mode === 'dontAsk') {
    return {
      behavior: 'deny',
      // 本例从 ask 变成 deny
    }
  }
}
```

它的含义不是「拒绝所有 Tool」，而是「不要弹出确认框」。已经被规则允许的调用仍然可以执行；只有原本需要询问的调用会被拒绝。

### `bypassPermissions`：没有被前置规则拦住就允许

这个模式在 `hasPermissionsToUseToolInner()` 中处理。BashTool 完成命令级检查后，只要前面的 deny、显式 ask 和安全检查都没有返回，通用层就直接返回 `allow`。

```javascript
// src/utils/permissions/permissions.ts:1262-1280
const shouldBypassPermissions =
  appState.toolPermissionContext.mode ===
    'bypassPermissions' ||
  (
    appState.toolPermissionContext.mode === 'plan' &&
    appState.toolPermissionContext
      .isBypassPermissionsModeAvailable
  )
// 本例 mode === 'bypassPermissions'
// shouldBypassPermissions => true

if (shouldBypassPermissions) {
  return { behavior: 'allow' }
}
```

所以本例的 `npm test` 会被允许。但这个模式不会覆盖前面已经命中的明确 deny、显式 ask 或 `safetyCheck`。

### `plan`：权限结果取决于会话是否具有 bypass 权限

`plan` 也在 `hasPermissionsToUseToolInner()` 中处理。它会同时查看 `isBypassPermissionsModeAvailable`：

```javascript
// src/utils/permissions/permissions.ts:1268-1271
const shouldBypassPermissions =
  appState.toolPermissionContext.mode ===
    'bypassPermissions' ||
  (
    appState.toolPermissionContext.mode === 'plan' &&
    appState.toolPermissionContext
      .isBypassPermissionsModeAvailable
  )
```

这个字段在启动时生成：会话以 `bypassPermissions` 启动，或者启用了跳过权限检查的启动参数时，它才是 `true`。

- `mode === 'plan'`，字段为 `false`：本例最终得到 `ask`；
- `mode === 'plan'`，字段为 `true`：本例按 bypass 处理，得到 `allow`。

五种模式在本例中的结果可以收成一行：`default → ask`，`acceptEdits → ask`，`dontAsk → deny`，`bypassPermissions → allow`，`plan → 取决于 isBypassPermissionsModeAvailable`。

## 小结

本例中的 `npm test` 没有命中 deny、ask 或 allow 规则。BashTool 返回 `passthrough`，通用层再把它转成 `ask`，Tool 调用停在原来的 Promise 上等待用户。

这条调用链最需要记住的是顺序：限制规则先于整项 allow，避免宽泛的放行规则覆盖具体命令的 deny 或 ask。用户选择后也不会重新发起 Tool 调用，而是恢复同一个 Promise；只有选择「不再询问」时，才会额外更新内存规则和配置文件。
