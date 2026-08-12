---
title: 1、从 claude 命令到 Agent 主循环
---

平常我们在终端里输入：

```bash
claude
```

很快就会进入 Claude Code 的交互界面。但从源码看，这中间其实经过了不少东西：

- Shell 先找到已经安装好的 `claude` 可执行文件；
- `cli.tsx` 处理 `--version` 一类的快速命令；
- `main.tsx` 判断这次是什么运行模式；
- Commander 解析参数并选中对应的 `.action()`；
- `.action()` 加载权限、Tools、Skills、Agents 和 MCP；
- 最后进入 REPL 或 Headless，由 `query()` 进入 `queryLoop()`。

核心涉及两个文件：`src/entrypoints/cli.tsx` 和 `src/main.tsx`。

![](https://windliangblog.oss-cn-beijing.aliyuncs.com/image-20260727165540792.png)

下边会结合源码把每一步都串起来。

## `cli.tsx` 先处理简单命令

`cli.tsx` 没有一上来就加载完整的 Claude Code，而是先看当前参数能不能直接处理。

例如：

```ts
// src/entrypoints/cli.tsx
async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (
    args.length === 1 &&
    ['--version', '-v', '-V'].includes(args[0])
  ) {
    console.log(`${MACRO.VERSION} (Claude Code)`)
    return
  }

  // Chrome、Daemon、Bridge 等特殊入口……

  if (args.includes('--bare')) {
    process.env.CLAUDE_CODE_SIMPLE = '1'
  }

  const {
    main: cliMain,
  } = await import('../main.js')

  await cliMain()
}
```

大概流程如下：

![](https://windliangblog.oss-cn-beijing.aliyuncs.com/01-claude-command-to-agent-loop-diagram-03.png)

值得注意的地方是执行主函数的时候没有在文件开头 import，而是这里动态 import：

```js
const {
  main: cliMain,
} = await import('../main.js')
```

动态加载最直观的好处是启动更快。例如执行 `claude --version` 时，根本不用加载 React、MCP 和 Tools。

还有个作用是提前处理参数和环境变量，再允许后续模块执行顶层初始化代码。

假设把代码改成静态导入：

```ts
import { main } from '../main.js'

if (args.includes('--bare')) {
  process.env.CLAUDE_CODE_SIMPLE = '1'
}
```

ES Module 会先加载并执行 `main.js` 以及它依赖的模块，然后才执行当前文件里的普通代码。

如果某个工具模块在顶层读取：

```ts
const simpleMode =
  process.env.CLAUDE_CODE_SIMPLE === '1'
```

此时等入口再设置环境变量就晚了，因为依赖模块已经读取过旧值。

主要的几个作用：

1. 快速命令不用初始化完整 Agent 系统。
2. `--bare` 等早期配置能在模块求值前生效。
3. Chrome、Daemon、REPL、SDK 等路径互不污染。
4. 完整运行时中的模块出问题时，不会影响 `--version` 这类独立快速路径。

## 从 `main()` 到 `.action()`

进入 `main.tsx` 后会连续看到 `main()`、`run()` 和 `.action()`，这三个名字很容易混。

先不用看里边的所有代码，可以把它们理解成三层：

![](https://windliangblog.oss-cn-beijing.aliyuncs.com/01-claude-command-to-agent-loop-diagram-04.png)

### `main()`：处理进程级初始化

位置 `src/main.tsx:585` ，主要代码：

```js
export async function main() {
  // Windows：避免从当前目录误执行恶意同名程序
  process.env.NoDefaultCurrentDirectoryInExePath = '1'

  initializeWarningHandler()

  process.on('exit', () => {
    resetCursor()
  })

  process.on('SIGINT', () => {
    // Print 模式有自己的优雅退出处理
    if (
      process.argv.includes('-p') ||
      process.argv.includes('--print')
    ) {
      return
    }

    process.exit(0)
  })

  // 提前处理 cc://、Deep Link、Assistant、SSH 等参数……

  const cliArgs = process.argv.slice(2)
  const hasPrintFlag =
    cliArgs.includes('-p') ||
    cliArgs.includes('--print')
  const hasInitOnlyFlag =
    cliArgs.includes('--init-only')
  const hasSdkUrl =
    cliArgs.some(arg => arg.startsWith('--sdk-url'))

  const isNonInteractive =
    hasPrintFlag ||
    hasInitOnlyFlag ||
    hasSdkUrl ||
    !process.stdout.isTTY

  setIsInteractive(!isNonInteractive)
  initializeEntrypoint(isNonInteractive)

  const clientType = (() => {
    if (
      process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-ts'
    ) {
      return 'sdk-typescript'
    }

    if (
      process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-py'
    ) {
      return 'sdk-python'
    }

    // Desktop、Remote、CLI 等其他分支……
    return 'cli'
  })()

  setClientType(clientType)

  eagerLoadSettings()

  await run()
}
```

可以看到，`main()` 还没有加载完整工具池，也没有调用模型。它主要做下边这些事情：

- 建立进程级安全设置；
- 安装退出和中断处理；
- 改写特殊启动参数；
- 提前判断交互、Print、SDK；
- 标记调用方是 CLI、Python SDK、TypeScript SDK、Desktop 还是 Remote；
- 在初始化前加载 `--settings`；
- 最后把控制权交给 `run()`。

### `run()`：注册并解析命令

位置：`src/main.tsx:884`。

`run()` 先创建 Commander 实例：

```ts
const program =
  new CommanderCommand()
    .configureHelp(createSortedHelpConfig())
    .enablePositionalOptions()
```

接着注册根命令的参数：

```ts
program
  .name('claude')
  .description(
    'Claude Code - starts an interactive session by default...',
  )
  .argument('[prompt]', 'Your prompt', String)
  .option('-p, --print', 'Print response and exit')
  .option('--model <model>', 'Model for the current session')
  .option('--permission-mode <mode>', 'Permission mode')
  .option('--mcp-config <configs...>', 'Load MCP servers')
  // ...
  .action(async (prompt, options) => {
    // 默认 Claude 会话
  })
```

然后再注册子命令：

```ts
program.command('mcp')
program.command('plugin')
program.command('doctor')
program.command('config')
// ...
```

本文这条交互路径会等子命令注册完成后，在 `src/main.tsx:4504` 统一解析参数：

```ts
await program.parseAsync(process.argv)
```

Print 模式为了减少启动开销，会在 `src/main.tsx:3887` 提前调用 `parseAsync()`，直接进入根命令的 `.action()`。

Commander 会根据 `argv` 选择对应的处理函数：

![](https://windliangblog.oss-cn-beijing.aliyuncs.com/01-claude-code-command-to-agent-loop-diagram-05.png)

在真正执行 action 以前，还会先执行一个公共的 `preAction`：

```ts
program.hook('preAction', async () => {
  await init()
  initSinks()
  // 初始化设置、认证、日志基础设施……
})
```

所以 `run()` 不是自己决定执行哪个分支，而是先把所有分支注册好，再由 Commander 根据参数选择：

![](https://windliangblog.oss-cn-beijing.aliyuncs.com/01-claude-command-to-agent-loop-diagram-06.png)

### `.action()`：准备一次 Claude 会话

用户执行默认的 `claude` 命令后，会进入根命令的 `.action()`。

它拿到两个主要参数：

```ts
prompt
options
```

例如用户执行：

```bash
claude \
  --model sonnet \
  --permission-mode plan \
  --mcp-config ./mcp.json \
  "检查登录模块"
```

经过 Commander 解析后，可以近似理解成：

```ts
prompt = '检查登录模块'

options = {
  model: 'sonnet',
  permissionMode: 'plan',
  mcpConfig: ['./mcp.json'],
  print: undefined,
  inputFormat: undefined,
  outputFormat: undefined,
  sdkUrl: undefined,
}
```

这里的 `options` 实际还有很多字段，上边只列出后续主流程会用到的部分。没有传入的可选参数大多是 `undefined`，之后再和用户设置、项目设置以及默认值合并。

接下来 `.action()` 会准备五组主要数据：

![](https://windliangblog.oss-cn-beijing.aliyuncs.com/image-20260727183416849.png)

这也是 `main.tsx` 看起来特别长的原因。它不是在实现某一个复杂算法，而是在把输入、配置、权限和各种能力接到一次会话上。

下面按图中的顺序看：先准备 ①～④，再组装成 ⑤ 会话容器，最后选择 `launchRepl()` 或 `runHeadless()`。

#### ① inputPrompt

```js
const effectivePrompt = prompt || '';
    let inputPrompt = await getInputPrompt(effectivePrompt, (inputFormat ?? 'text') as 'text' | 'stream-json');
```

默认其实就是终端拿到的 prompt，但也兼容了一些其他情况：

`stdin` 是进程的标准输入，`isTTY` 表示它是否直接连接着交互终端：

```ts
process.stdin.isTTY
// 用户在终端运行 claude 时 => true

process.stdin.isTTY
// stdin 来自管道或 SDK 子进程时通常 => undefined
```

`getInputPrompt()` 的主逻辑可以简化成：

```ts
if (process.stdin.isTTY || process.argv.includes('mcp')) {
  return prompt
}

if (inputFormat === 'stream-json') {
  return process.stdin
}

process.stdin.setEncoding('utf8')
let data = '';
const onData = (chunk: string) => {
  data += chunk;
};
process.stdin.on('data', onData);
// If no data arrives in 3s, stop waiting and warn. Stdin is likely an
// inherited pipe from a parent that isn't writing (subprocess spawned
// without explicit stdin handling). 3s covers slow producers like curl,
// jq on large files, python with import overhead. The warning makes
// silent data loss visible for the rare producer that's slower still.
const timedOut = await peekForStdinData(process.stdin, 3000);
process.stdin.off('data', onData);
if (timedOut) {
  process.stderr.write('Warning: no stdin data received in 3s, proceeding without it. ' + 'If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.\n');
}
return [prompt, data].filter(Boolean).join('\n')
```

对应三种常见情况：

| 命令                                    | prompt 最终值                  |
| --------------------------------------- | ------------------------------ |
| `claude "检查登录模块"`                 | `'检查登录模块'`               |
| `cat error.log \| claude -p "分析日志"` | `'分析日志\n' + error.log内容` |
| SDK 的 `stream-json` 模式               | `process.stdin` 输入流         |

三秒计时器只保护“迟迟收不到第一段数据”的阶段。收到第一段 `data` 后，计时器会被清除，代码继续等待 `end`，确保读完全部内容；空管道如果已经关闭，也会直接触发 `end`。因此它能防止父进程既不写数据也不关闭 stdin 时卡住启动，但如果对方写了一段数据后永远不关闭，读取仍然会等待。

#### ② 工具系统：`toolPermissionContext + tools`

这段代码分成两个阶段：

- **启动时**：选权限模式、合并规则、生成模型可见的工具列表；
- **运行时**：模型真的调用工具时，再判断这一次调用能否执行。

为了看清每个参数怎样影响结果，用这个例子看一下后续代码的执行：

```bash
claude "修改登录模块并运行测试" \
  --permission-mode acceptEdits \
  --tools "Read,Edit,Bash,Grep" \
  --allowed-tools "Read,Grep,Bash(npm:*)" \
  --disallowed-tools "Bash(rm:*)" \
  --add-dir ../shared
```

下面把源码和这条命令产生的中间值写在一起。Commander 进入 `.action()` 后，参数已经被解析成变量：

```ts
prompt             // => '修改登录模块并运行测试'
permissionModeCli  // => 'acceptEdits'
baseTools          // => ['Read,Edit,Bash,Grep']
allowedTools       // => ['Read,Grep,Bash(npm:*)']
disallowedTools    // => ['Bash(rm:*)']
addDir             // => ['../shared']

// 1. 选出本次会话的总体权限模式
const { mode: permissionMode } =
  initialPermissionModeFromCLI({
    permissionModeCli,             // => 'acceptEdits'
    dangerouslySkipPermissions,    // => undefined
  })
// permissionMode => 'acceptEdits'

// 2. 把 CLI、settings 和目录规则合并成一张权限表
const { toolPermissionContext } =
  await initializeToolPermissionContext({
    allowedToolsCli: allowedTools,       // => ['Read,Grep,Bash(npm:*)']
    disallowedToolsCli: disallowedTools, // => ['Bash(rm:*)']
    baseToolsCli: baseTools,             // => ['Read,Edit,Bash,Grep']
    permissionMode,                      // => 'acceptEdits'
    allowDangerouslySkipPermissions,     // => false
    addDirs: addDir,                     // => ['../shared']
  })
// 假设 settings 没有额外规则，并且没有开启实验性工具，
// 本文场景下 toolPermissionContext 的关键字段近似是：
// => {
//   mode: 'acceptEdits',
//
//   alwaysAllowRules: {
//     cliArg: ['Read', 'Grep', 'Bash(npm:*)'],
//   },
//
//   alwaysDenyRules: {
//     cliArg: [
//       'Bash(rm:*)',     // --disallowed-tools 明确添加
//       'Agent',          // 下列工具都因为不在 --tools 中而被添加
//       'TaskOutput',
//       'Glob',
//       'ExitPlanMode',
//       'Write',
//       'NotebookEdit',
//       'WebFetch',
//       'TodoWrite',
//       'WebSearch',
//       'TaskStop',
//       'AskUserQuestion',
//       'Skill',
//       'EnterPlanMode',
//     ],
//   },
//
//   alwaysAskRules: {},
//
//   additionalWorkingDirectories: new Map([
//     [
//       '/Users/me/shared',
//       {
//         path: '/Users/me/shared',
//         source: 'cliArg',
//       },
//     ],
//   ]),
//
//   isBypassPermissionsModeAvailable: false,
// }

// 3. 根据权限表筛出模型本轮能够看到的 Tool 对象
const tools = getTools(toolPermissionContext)
// tools.map(tool => tool.name)
// => ['Bash', 'Grep', 'Read', 'Edit']
```

这里五个参数的作用不同：

- `--tools` 控制哪些内置工具可以进入候选集合；
- `--allowed-tools` 为具体工具或命令增加 allow 规则；
- `--disallowed-tools` 增加 deny 规则；
- `--permission-mode` 设置默认处理方式；
- `--add-dir` 扩大允许访问的工作目录。

下面按执行顺序阅读。代码是删去日志、埋点和兼容分支后的主干，`...` 表示暂时不影响理解的细节。

##### `initialPermissionModeFromCLI()`：选择模式

源码：`src/utils/permissions/permissionSetup.ts`

```ts
function initialPermissionModeFromCLI({
  permissionModeCli,
  dangerouslySkipPermissions,
}) {
  // settings 可能提供 permissions.defaultMode
  const settings = getSettings_DEPRECATED() ?? {}
  // settings.permissions?.defaultMode => undefined
  // 本例假设 settings 没有额外设置默认模式

  // 数组顺序就是优先级：危险参数最高，settings 最低
  const candidates = [
    dangerouslySkipPermissions
      ? 'bypassPermissions'
      : undefined,
    permissionModeCli
      ? permissionModeFromString(permissionModeCli)
      : undefined,
    settings.permissions?.defaultMode,
  ]
  // candidates
  // => [undefined, 'acceptEdits', undefined]

  // 取第一个有值的模式；都没提供时使用 default
  const mode = candidates.find(Boolean) ?? 'default'
  // mode => 'acceptEdits'

  return { mode }
}
```

选择顺序就是：

```text
危险跳过权限参数
→ --permission-mode
→ settings.permissions.defaultMode
→ default
```

真实源码还会跳过被组织策略禁用的模式。这里仅仅选模式，还没有判断任何工具。

对外模式有五种；开启相关功能后还会出现 `auto`。源码中的 `bubble` 是内部状态，不能通过 CLI 选择。

| 模式                | 遇到原本需要确认的调用时                            |
| ------------------- | --------------------------------------------------- |
| `default`           | 询问用户                                            |
| `acceptEdits`       | 工作目录内的常规文件修改自动允许，其他调用继续判断  |
| `plan`              | 先探索和生成计划，经批准后再实施                    |
| `dontAsk`           | 不询问，直接拒绝                                    |
| `bypassPermissions` | 普通确认直接允许，但显式 deny、ask 和安全检查仍优先 |
| `auto`              | 交给分类器判断，需要相应功能开关                    |

`plan` 改变的是 Agent 的工作流程，并不等于直接从工具列表中删掉 `Edit` 和 `Bash`。

##### `initializeToolPermissionContext()`：合并规则

源码：`src/utils/permissions/permissionSetup.ts`

```ts
async function initializeToolPermissionContext(args) {
  // "Read,Grep,Bash(npm:*)" 被拆成三条规则
  const allowRules =
    parseToolListFromCLI(args.allowedToolsCli)
  // args.allowedToolsCli => ['Read,Grep,Bash(npm:*)']
  // allowRules => ['Read', 'Grep', 'Bash(npm:*)']

  // "Bash(rm:*)" 是一条只针对 rm 命令的 deny 规则
  let denyRules =
    parseToolListFromCLI(args.disallowedToolsCli)
  // args.disallowedToolsCli => ['Bash(rm:*)']
  // denyRules => ['Bash(rm:*)']

  if (args.baseToolsCli?.length) {
    // --tools 只保留 Read、Edit、Bash、Grep
    const baseTools = new Set(
      parseBaseToolsFromCLI(args.baseToolsCli),
    )
    // baseTools
    // => Set { 'Read', 'Edit', 'Bash', 'Grep' }

    // 其他内置工具转成整项 deny 规则
    const toolsOutsideBase =
      getToolsForDefaultPreset().filter(
        name => !baseTools.has(name),
      )
    // toolsOutsideBase
    // => ['Agent', 'TaskOutput', 'Glob', 'Write',
    //     'WebFetch', 'WebSearch', ...]

    denyRules = [...denyRules, ...toolsOutsideBase]
    // denyRules
    // => ['Bash(rm:*)', 'Agent', 'TaskOutput', 'Glob',
    //     'Write', 'WebFetch', 'WebSearch', ...]
  }

  // 先建立只包含 CLI 规则的权限上下文
  let context = {
    mode: args.permissionMode,
    alwaysAllowRules: { cliArg: allowRules },
    alwaysDenyRules: { cliArg: denyRules },
    alwaysAskRules: {},
    additionalWorkingDirectories: new Map(),
  }
  // context.mode => 'acceptEdits'
  // context.alwaysAllowRules.cliArg
  // => ['Read', 'Grep', 'Bash(npm:*)']
  // context.alwaysDenyRules.cliArg
  // => ['Bash(rm:*)', 'Agent', 'TaskOutput', ...]

  // 再合并用户、项目、本地和组织策略中的规则
  context = applyPermissionRulesToPermissionContext(
    context,
    loadAllPermissionRulesFromDisk(),
  )
  // 本例假设磁盘上没有额外规则，上面的关键值不变

  const settings = getSettings_DEPRECATED() || {}
  const allAdditionalDirectories = [
    ...(settings.permissions?.additionalDirectories || []),
    ...args.addDirs,
  ]
  // 本例 settings 中没有附加目录
  // allAdditionalDirectories => ['../shared']

  const validationResults = await Promise.all(
    allAdditionalDirectories.map(dir =>
      validateDirectoryForWorkspace(dir, context),
    ),
  )
  // validationResults
  // => [{
  //   resultType: 'success',
  //   absolutePath: '/Users/me/shared',
  // }]

  for (const result of validationResults) {
    if (result.resultType === 'success') {
      // 把通过验证的目录写回权限上下文
      context = applyPermissionUpdate(context, {
        type: 'addDirectories',
        directories: [result.absolutePath],
        destination: 'cliArg',
      })
      // context.additionalWorkingDirectories
      // => Map {
      //   '/Users/me/shared' => {
      //     path: '/Users/me/shared',
      //     source: 'cliArg',
      //   },
      // }
    }
  }

  // 返回前的核心状态：
  // context.mode => 'acceptEdits'
  // allow 规则 => 3 条
  // deny 规则 => 多条
  // 附加工作目录 => 1 个
  return { toolPermissionContext: context }
}
```

注意，`Bash(rm:*)` 只禁止匹配的命令，不会让整个 `Bash` 工具消失；`WebFetch` 这种没有括号内容的规则才是整项 deny。

这一步只整理规则，不执行工具。

##### `getTools()`：筛选模型可见的工具

源码：`src/tools.ts`

```ts
function getTools(permissionContext) {
  // 候选池中包含当前构建可能提供的全部内置工具
  const allTools = getAllBaseTools()
  // allTools.map(tool => tool.name)
  // => [
  //   'Agent', 'TaskOutput', 'Bash', 'Glob', 'Grep',
  //   'ExitPlanMode', 'Read', 'Edit', 'Write',
  //   'NotebookEdit', 'WebFetch', 'WebSearch', ...
  // ]

  // 这里只过滤“整项 deny”：
  // Agent 会被删除，Bash(rm:*) 不会删除 Bash
  const allowedTools = filterToolsByDenyRules(
    allTools,
    permissionContext,
  )
  // allowedTools.map(tool => tool.name)
  // => ['Bash', 'Grep', 'Read', 'Edit']

  // 最后再检查 Feature Flag、运行环境等启用条件
  const enabledTools =
    allowedTools.filter(tool => tool.isEnabled())
  // enabledTools.map(tool => tool.name)
  // => ['Bash', 'Grep', 'Read', 'Edit']

  return enabledTools
}
```

它取得候选工具，再去掉整项 deny 和当前环境未启用的工具。真实源码还处理 Simple、REPL、Coordinator 以及需要按条件添加的特殊工具。

`getTools()` 返回的类型是 `readonly Tool[]`，也就是 **Tool 对象数组**，不是工具名字符串数组。

为什么 `Bash` 还在？因为 `Bash(rm:*)` 只拒绝一部分命令；为什么 `WebFetch` 不在？因为 `--tools` 没有选择它，初始化时已经生成了整项 deny 规则。

数组中的每一项近似是下面这样的对象：

```ts
tools.find(tool => tool.name === 'Read')
// {
//   name: 'Read',
//   searchHint: 'read files, images, PDFs, notebooks',
//   inputSchema: ZodObject(...),
//   isEnabled: [Function],
//   isReadOnly: [Function],
//   checkPermissions: [AsyncFunction],
//   call: [AsyncFunction],
//   ...
// }
```

其中 `inputSchema` 告诉模型参数怎么传，`checkPermissions()` 检查本次调用，`call()` 才真正读取文件。具体有哪些工具会随环境变量、Feature Flag、REPL 状态和 deny 规则变化。

关键点只有一句：

> 出现在 `tools` 中只代表模型看得见，不代表调用一定能执行。

##### `hasPermissionsToUseTool()`：运行时检查调用

源码：`src/utils/permissions/permissions.ts`

执行工具时，它会作为 `canUseTool` 回调。模型每次调用工具前，都会走一次。下面先代入 `Bash("npm test -- login")`，把本次调用的值直接写在源码旁：

```ts
async function hasPermissionsToUseTool(
  tool,
  input,
  context,
) {
  // tool.name    => 'Bash'
  // input.command => 'npm test -- login'

  // 读取当前时刻的权限上下文，用户可能在会话中切换模式
  const permissionContext =
    context.getAppState().toolPermissionContext
  // permissionContext.mode => 'acceptEdits'
  // permissionContext.alwaysAllowRules.cliArg
  // => ['Read', 'Grep', 'Bash(npm:*)']
  // permissionContext.alwaysDenyRules.cliArg
  // => ['Bash(rm:*)', 'Agent', 'TaskOutput', ...]

  // 第一层：整个工具是否被禁止
  const denyRule =
    getDenyRuleForTool(permissionContext, tool)
  // denyRule => undefined
  // Bash(rm:*) 只约束参数，不是对 Bash 的整项禁止

  if (denyRule) {
    return { behavior: 'deny' }
  }

  // 第二层：是否配置成每次调用都询问
  const askRule =
    getAskRuleForTool(permissionContext, tool)
  // askRule => undefined

  if (askRule) {
    return { behavior: 'ask' }
  }

  // 第三层：让具体工具检查本次参数
  // Edit 检查 file_path，Bash 检查 command
  const toolResult =
    await tool.checkPermissions(input, context)
  // command 命中 Bash(npm:*)
  // toolResult
  // => {
  //   behavior: 'allow',
  //   decisionReason: { type: 'rule', ... },
  // }

  // 显式规则和安全检查优先，直接返回
  if (
    toolResult.behavior === 'deny' ||
    toolResult.decisionReason?.type === 'rule' ||
    toolResult.decisionReason?.type === 'safetyCheck'
  ) {
    // 本例在这里结束：
    // => { behavior: 'allow', ... }
    return toolResult
  }

  // 本次 npm 调用已经返回；下边是其他调用未命中规则时
  // 才会继续执行的模式兜底逻辑。

  // bypassPermissions 跳过普通确认
  if (permissionContext.mode === 'bypassPermissions') {
    return { behavior: 'allow' }
  }

  // Read 这种整项 allow 规则在这里命中
  if (toolAlwaysAllowedRule(permissionContext, tool)) {
    return { behavior: 'allow' }
  }

  // 工具没有明确决定时，默认需要询问用户
  let result = toolResult.behavior === 'passthrough'
    ? { behavior: 'ask' }
    : toolResult

  // dontAsk 无法弹窗，把 ask 转成 deny
  if (
    permissionContext.mode === 'dontAsk' &&
    result.behavior === 'ask'
  ) {
    return { behavior: 'deny' }
  }

  // auto 不弹普通确认框，改由分类器判断
  if (
    permissionContext.mode === 'auto' &&
    result.behavior === 'ask'
  ) {
    return classifyYoloAction(/* ... */)
  }

  return result
}
```



整条权限链如下：

![图 8：初始化权限和 Tools](https://windliangblog.oss-cn-beijing.aliyuncs.com/01-claude-command-to-agent-loop-diagram-08.png)

> `getTools()` 决定模型能看见什么，`hasPermissionsToUseTool()` 决定这一次能不能做。

#### ③ 扩展能力：Skills、Commands、Agents 和 MCP

先把关系理顺：这四个词并不在同一层。

| 名称             | 本质                         | 运行时怎么用                                            |
| ---------------- | ---------------------------- | ------------------------------------------------------- |
| Command          | 用户或模型可以触发的命令入口 | 找到命令后，执行它的处理函数或展开提示词                |
| Skill            | 一份可复用的任务说明         | 通常被转换成 Command；展开后仍由模型调用 Tools 完成工作 |
| Agent Definition | 一个子 Agent 的配置模板      | `Agent` Tool 根据模板创建子 Agent                       |
| MCP              | 外部 Server 提供能力的协议   | 连接 Server 后得到额外的 Tools、Commands 和资源         |

所以这里真正需要准备的是三组数据：

下面只是先展示三个变量的职责，具体赋值源码会在后面逐段标出。

```ts
commands
// commands.map(item => item.name)
// => ['simplify', 'verify', 'review', 'test-login', ...]

agentDefinitions
// agentDefinitions.activeAgents 中的 agentType
// => ['general-purpose', 'code-reviewer', ...]

mcp
// 启动界面时 => { clients: [], tools: [], commands: [] }
// Server 连上后 tools 中可能出现 => 'mcp__project-server__search'
```

整条装配关系如下：

![](https://windliangblog.oss-cn-beijing.aliyuncs.com/01-claude-command-to-agent-loop-diagram-09.png)

下面使用 `/Users/me/shop` 这个示例项目。假设项目中有：

```text
/Users/me/shop/
├── .claude/commands/review.md
├── .claude/skills/test-login/SKILL.md
├── .claude/agents/code-reviewer.md
└── .mcp.json
```

分别代表一个项目命令、一个项目 Skill、一个项目 Agent 和一份 MCP 配置。

##### 第一步：注册内置 Skills

源码先把随 Claude Code 一起发布的 Plugin 和 Skill 注册到内存：

源码位置：`src/main.tsx:1918-1929`、`src/skills/bundled/index.ts:24`

```ts
if (
  process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent'
) {
  initBuiltinPlugins()
  initBundledSkills()
}

// 注册完成后，内存中的 Bundled Skills 可能包含：
// => [
//   'simplify',
//   'verify',
//   'skillify',
//   'update-config',
//   'debug',
//   'batch',
//   ...
// ]
```

这里只是注册元数据和提示词，没有运行任何 Skill。

以 `/simplify` 为例，注册代码的核心只是返回一段提示词：

源码位置：`src/skills/bundled/simplify.ts:56-68`

```ts
registerBundledSkill({
  name: 'simplify',
  description:
    'Review changed code for reuse, quality, and efficiency, then fix any issues found.',
  userInvocable: true,

  async getPromptForCommand(args) {
    // 用户输入 /simplify 重点检查重复代码 时：
    // args => '重点检查重复代码'
    let prompt = SIMPLIFY_PROMPT
    // prompt => SIMPLIFY_PROMPT 的完整文本

    if (args) {
      prompt += `\n\n## Additional Focus\n\n${args}`
      // prompt => SIMPLIFY_PROMPT
      //   + '\n\n## Additional Focus\n\n重点检查重复代码'
    }

    // 返回值 => [{ type: 'text', text: prompt }]
    return [{ type: 'text', text: prompt }]
  },
})
```

假设用户输入：

```text
/simplify 重点检查重复代码
```

这段函数的值是：

运行值对应：`src/skills/bundled/simplify.ts:61-66`

```ts
args
// => '重点检查重复代码'

prompt
// => SIMPLIFY_PROMPT
//  + '\n\n## Additional Focus\n\n重点检查重复代码'
```

展开后的 `prompt` 会交给模型。真正搜索、修改和测试代码的仍然是 `Grep`、`Read`、`Edit` 和 `Bash`。

![图 10：Skill 展开后怎样执行](https://windliangblog.oss-cn-beijing.aliyuncs.com/01-claude-command-to-agent-loop-diagram-10.png)

这就是 Skill 和 Tool 最重要的区别：

> Skill 告诉模型“这类任务应该怎么做”，Tool 负责“真正执行某个动作”。

##### 第二步：`setup()` 准备会话环境并确定最终工作目录

`setup()` 不是加载 Commands、Skills 或 Agents 的函数。它负责把后面这些能力依赖的基础环境先准备好。

调用位置：`src/main.tsx:1918-1934`

```ts
const preSetupCwd = getCwd()
// => '/Users/me/shop'

const setupPromise = setup(
  preSetupCwd,                       // => '/Users/me/shop'
  permissionMode,                    // => 'plan'
  allowDangerouslySkipPermissions,   // => false
  worktreeEnabled,                   // => false
  worktreeName,                      // => undefined
  tmuxEnabled,                       // => false
  sessionId
    ? validateUuid(sessionId)
    : undefined,                     // => undefined
  worktreePRNumber,                  // => undefined
  messagingSocketPath,               // => undefined
)
// setupPromise => Promise<void>

await setupPromise
// setup() 没有返回工作目录，完成后的解析值 => undefined
// 当前 getCwd() => '/Users/me/shop'
```

`setup()` 内部主要做四类事情：

| 工作                                         | 为什么要在这里完成               |
| -------------------------------------------- | -------------------------------- |
| 检查 Node.js、会话 ID 和危险权限模式         | 确保会话可以安全启动             |
| 设置当前目录，读取 Hooks 并启动文件变化监听  | 后续能力必须使用正确的项目配置   |
| 根据参数创建 worktree 和 tmux session        | 这一步可能改变实际工作目录       |
| 启动 Session Memory、Plugin Hooks 等基础服务 | 保证第一轮执行前基础设施已经就绪 |

与当前装配图直接相关的是第二、三项。源码先设置普通工作目录：

源码位置：`src/setup.ts:160-176`

```ts
setCwd(cwd)
// cwd => '/Users/me/shop'
// getCwd() => '/Users/me/shop'

captureHooksConfigSnapshot()
initializeFileChangedWatcher(cwd)

if (worktreeEnabled) {
  // 本文示例 worktreeEnabled => false，不进入该分支
  // 如果传入 --worktree feature-login，这里会创建并切换目录
}
```

如果用户传入 `--worktree feature-login`，`setup()` 会真正改变进程和会话记录的目录：

源码位置：`src/setup.ts:271-284`

```ts
process.chdir(worktreeSession.worktreePath)
setCwd(worktreeSession.worktreePath)
setOriginalCwd(getCwd())
setProjectRoot(getCwd())

// worktreeSession.worktreePath 可能
// => '/Users/me/shop/.claude/worktrees/feature-login'
// process.cwd() => '/Users/me/shop/.claude/worktrees/feature-login'
// getCwd()     => '/Users/me/shop/.claude/worktrees/feature-login'
```

所以图里的 `setup()` 可以理解成一道分界线：

> 普通模式下，`preSetupCwd` 已经是最终目录，可以和 `setup()` 并行加载；开启 worktree 时，目录可能被 `setup()` 改变，必须等它完成后再读取项目 Commands、Skills、Agents 和 Hooks。

##### 第三步：根据最终工作目录加载 Commands 和 Agents

项目级 Command、Skill 和 Agent 都与目录有关，因此源码先确定工作目录：

源码位置：`src/main.tsx:1918-2029`

```ts
const preSetupCwd = getCwd()
// => '/Users/me/shop'

const setupPromise = setup(/* ... */)

// 普通模式不会切换目录，可以提前并行读取
const commandsPromise =
  worktreeEnabled
    ? null
    : getCommands(preSetupCwd)
// worktreeEnabled => false
// commandsPromise => Promise<Command[]>

const agentDefsPromise =
  worktreeEnabled
    ? null
    : getAgentDefinitionsWithOverrides(preSetupCwd)
// agentDefsPromise => Promise<AgentDefinitionsResult>

await setupPromise

const currentCwd =
  worktreeEnabled ? getCwd() : preSetupCwd
// currentCwd => '/Users/me/shop'

const [commands, agentDefinitionsResult] =
  await Promise.all([
    commandsPromise ?? getCommands(currentCwd),
    agentDefsPromise ??
      getAgentDefinitionsWithOverrides(currentCwd),
  ])
```

`getCommands()` 把多种来源统一成一张 Command 列表：

源码位置：`src/commands.ts:449-468`

```ts
return [
  ...bundledSkills,       // 内置 Skills
  ...builtinPluginSkills, // 内置 Plugin 的 Skills
  ...skillDirCommands,    // .claude/skills/
  ...workflowCommands,
  ...pluginCommands,
  ...pluginSkills,
  ...COMMANDS(),          // Claude Code 自带命令
]
// 合并后的 name 示例
// => ['simplify', 'verify', 'review', 'test-login', ...]
```

代入示例项目后，可以只看名字：

运行值来自：`src/main.tsx:2029` 返回的 `commands`

```ts
commands.map(command => command.name)
// => [
//   'simplify',  // 内置 Skill
//   'verify',    // 内置 Skill
//   'review',    // .claude/commands/review.md
//   'test-login',// .claude/skills/test-login/SKILL.md
//   ...
// ]
```

常见误解是：Skill 和普通 Command 加载后会分别存放、分别查找。

实际不是。它们的**来源和概念不同**，但加载阶段都会被转换成统一的 `Command` 运行时结构，然后合并进同一个 `commands` 数组。因此用户输入 `/simplify`、`/review` 或 `/test-login` 时，程序都从这张数组中查找。

这里的“统一结构”只表示共用同一套查找和调用机制，不表示 Skill 与 Command 是同一个概念：普通 Command 可以直接执行处理逻辑，Skill 的主要作用仍是展开一份任务说明，再交给模型和 Tools 完成。

Agents 走的是另一条加载链：

源码位置：`src/tools/AgentTool/loadAgentsDir.ts:296-380`

```ts
const agentDefinitionsResult =
  await getAgentDefinitionsWithOverrides(currentCwd)

agentDefinitionsResult.activeAgents.map(agent => ({
  agentType: agent.agentType,
  model: agent.model,
  tools: agent.tools,
}))
// => [
//   {
//     agentType: 'code-reviewer',
//     model: 'inherit',
//     tools: ['Read', 'Grep'],
//   },
//   // 还会有内置或 Plugin 提供的 Agent
// ]
```

当模型要委派代码审查时，它会调用已有的 `Agent` Tool：

调用参数定义：`src/tools/AgentTool/AgentTool.tsx:76-130`  
查找 Agent Definition：`src/tools/AgentTool/AgentTool.tsx:286`

```ts
// 这是模型生成的 Agent Tool 调用参数，不是普通函数的同步返回值
Agent({
  subagent_type: 'code-reviewer',
  description: 'Review login changes',
  prompt: '检查登录模块的改动，重点关注鉴权漏洞',
})
// Agent Tool 查到的定义可能
// => { agentType: 'code-reviewer', model: 'inherit',
//      tools: ['Read', 'Grep'], ... }
```

`Agent` Tool 再去 `agentDefinitions.activeAgents` 中查找 `code-reviewer`，用它指定的提示词、模型和 Tools 创建子 Agent。Agent Definition 本身不是 Tool，也不会因为被加载就自动执行。

如果使用 `--worktree feature-login`，`setup()` 会切换到新 worktree。此时源码不会提前读取旧目录，而是在 `setup()` 完成后使用新的 `currentCwd` 加载：

对应分支：`src/main.tsx:1928-2029`

```ts
commandsPromise  // => null
agentDefsPromise // => null
currentCwd       // => '/Users/me/shop/.claude/worktrees/feature-login'
```

原因很直接：`.claude/commands/`、`.claude/skills/` 和 `.claude/agents/` 都可能因工作目录不同而变化。

##### 第四步：确认目录可信后连接 MCP

MCP 与前两组能力不同。Commands 和 Agents 主要是读取文件；连接 MCP 可能会启动外部进程。

Claude Code 可以提前读取配置：

源码位置：`src/main.tsx:1800-1816`

```ts
const mcpConfigPromise =
  getClaudeCodeMcpConfigs(dynamicMcpConfig)

const { servers: existingMcpConfigs } =
  await mcpConfigPromise

// 假设 .mcp.json 文件中配置了：
// {
//   "mcpServers": {
//     "project-server": {
//       "command": "node",
//       "args": ["./server.js"]
//     }
//   }
// }

existingMcpConfigs
// => {
//   'project-server': {
//     command: 'node',
//     args: ['./server.js'],
//   },
// }

mcpClients // => []
mcpTools   // => []
```

此时只是读取 JSON，并没有执行 `node ./server.js`。交互模式先确认目录可信，再审批项目 `.mcp.json` 中的 Server，通过后才会连接：

信任界面：`src/main.tsx:2239-2242`  
MCP 连接：`src/main.tsx:2408-2455`

```ts
await showSetupScreens(/* ... */)

const localMcpPromise =
  prefetchAllMcpResources(regularMcpConfigs)

const mcpPromise = Promise.all([
  localMcpPromise,
  claudeaiMcpPromise,
]).then(([local, claudeai]) => ({
  clients: [...local.clients, ...claudeai.clients],
  tools: uniqBy(
    [...local.tools, ...claudeai.tools],
    'name',
  ),
  commands: uniqBy(
    [...local.commands, ...claudeai.commands],
    'name',
  ),
}))
// mcpPromise 最终解析值示例：
// => {
//   clients: [
//     { name: 'project-server', ... },
//   ],
//   tools: [
//     { name: 'mcp__project-server__search', ... },
//   ],
//   commands: [
//     { name: 'search-project', ... },
//   ],
// }

// 交互界面不等待慢 MCP Server，启动时仍然是空数组
const mcpClients = []
// => []
const mcpTools = []
// => []
const mcpCommands = []
// => []
```

`mcpPromise` 会在后台继续连接。Server 连接成功后，连接管理逻辑再把结果更新到 `AppState.mcp`，因此慢 Server 不会卡住界面。

![](https://windliangblog.oss-cn-beijing.aliyuncs.com/01-claude-command-to-agent-loop-diagram-12.png)

MCP Server 最终可以贡献三类东西：

- `clients`：Claude Code 与外部 Server 的连接；
- `tools`：模型可以调用的外部动作；
- `commands`：外部 Server 提供的提示词命令。

##### 本节最终得到什么

扩展能力这一节最后只产生三组结果；它们会在第⑤步与输入、权限和模型配置一起装进会话：

```ts
commands
// => 内置、项目和 Plugin 提供的 Commands / Skills

agentDefinitions
// => 内置、项目和 Plugin 提供的 Agent Definitions

mcpPromise
// => 后台连接 MCP，最终产生 clients、tools 和 commands
```

到这里，四个概念就能对应起来了：

| 用户或模型想做什么     | 实际路径                                              |
| ---------------------- | ----------------------------------------------------- |
| 执行 `/simplify`       | `commands` 找到 Skill → 展开提示词 → 模型调用 Tools   |
| 执行 `/review`         | `commands` 找到项目 Command → 展开命令内容            |
| 委派给 `code-reviewer` | `Agent` Tool → 查找 `agentDefinitions` → 创建子 Agent |
| 搜索外部项目系统       | 模型调用 `mcp__project-server__search` → MCP Server   |

Commands 是入口表，Skills 是可复用的方法，Agent Definitions 是子 Agent 模板，MCP 是外部能力来源。它们最后都会增强会话，但装载位置和运行方式并不相同。

这一节只回答“能力从哪里来、怎样被触发”。这些数据怎样进入会话、执行时又怎样传给 Tool 和 Agent，要等第⑤步组装完会话后再看。

#### ④ `systemPrompt / model / thinking`：准备模型配置

假如是下边的命令：

```bash
claude \
  --model sonnet \
  --permission-mode plan \
  --mcp-config ./mcp.json \
  "检查登录模块"
```

这条命令传了 `--model sonnet`，没有传 System Prompt 和 Thinking 参数。下面按源码执行顺序看三个结果怎样产生。

##### `systemPrompt`：替换还是追加系统指令

Claude Code 支持两组不同参数：

- `--system-prompt` / `--system-prompt-file`：替换默认 System Prompt；
- `--append-system-prompt` / `--append-system-prompt-file`：在最终 System Prompt 后追加内容。

源码位置：`src/main.tsx:1343-1392`

```ts
// 本例没有传 --system-prompt
let systemPrompt = options.systemPrompt
// options.systemPrompt => undefined
// systemPrompt         => undefined

if (options.systemPromptFile) {
  // 本例 options.systemPromptFile => undefined，不进入分支
  const filePath = resolve(options.systemPromptFile)
  systemPrompt = readFileSync(filePath, 'utf8')
}

// 本例也没有传 --append-system-prompt
let appendSystemPrompt = options.appendSystemPrompt
// options.appendSystemPrompt => undefined
// appendSystemPrompt         => undefined

if (options.appendSystemPromptFile) {
  // 本例 options.appendSystemPromptFile => undefined，不进入分支
  const filePath = resolve(
    options.appendSystemPromptFile,
  )
  appendSystemPrompt =
    readFileSync(filePath, 'utf8')
}
```

所以这一阶段得到：

```ts
systemPrompt       // => undefined
appendSystemPrompt // => undefined
```

这不表示模型没有 System Prompt，只表示 CLI 没有要求替换或追加。交互模式真正发起一轮请求前，还会构造最终值。

最终构造位置：`src/screens/REPL.tsx:2768-2787`
合并规则：`src/utils/systemPrompt.ts:41-112`

```ts
const [
  ,
  ,
  defaultSystemPrompt,
  // ...
] = await Promise.all([
  // ...
  getSystemPrompt(
    freshTools,
    // freshTools.map(tool => tool.name)
    // => ['Read', 'Edit', 'Bash', 'Grep', ...]

    mainLoopModelParam,
    // => 'claude-sonnet-4-6'

    Array.from(
      toolPermissionContext
        .additionalWorkingDirectories.keys(),
    ),
    // => []

    freshMcpClients,
    // => []
  ),
  // ...
])

const systemPrompt = buildEffectiveSystemPrompt({
  mainThreadAgentDefinition,
  // => undefined

  toolUseContext,
  customSystemPrompt,
  // => undefined

  defaultSystemPrompt,
  appendSystemPrompt,
  // => undefined
})

// 本例没有选择主线程 Agent，也没有 CLI 覆盖：
// systemPrompt => defaultSystemPrompt
```

这里有三个容易混淆的变量：

| 变量                                                 | 本文示例中的值                                              |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| `main.tsx` 中的 `systemPrompt`                       | `undefined`，表示没有传入 `--system-prompt`                 |
| `getSystemPrompt()` 生成的 `defaultSystemPrompt`     | Claude Code 动态生成的默认系统提示词                        |
| `buildEffectiveSystemPrompt()` 返回的 `systemPrompt` | 最终发送给模型的 `string[]`；本文就是 `defaultSystemPrompt` |

###### 默认 System Prompt 具体是什么

它不是写死在一个 `DEFAULT_SYSTEM_PROMPT` 常量中的大字符串，而是 `getSystemPrompt()` 根据当前 Tools、目录、模型、配置和 MCP 连接动态拼成的 `string[]`。

生成位置：`src/constants/prompts.ts:444-547`

省略缓存边界和按 Feature Flag 开关的区块后，主干可以写成：

```ts
return [
  // 1. 身份和基本边界
  getSimpleIntroSection(outputStyleConfig),
  // => 'You are an interactive agent that helps users
  //     with software engineering tasks...'

  // 2. 系统规则：权限、Hooks、Prompt Injection、上下文压缩
  getSimpleSystemSection(),
  // => '# System\n - All text you output outside...'

  // 3. 怎样完成软件工程任务
  getSimpleDoingTasksSection(),
  // => '# Doing tasks\n - The user will primarily request...'

  // 4. 高风险操作需要谨慎确认
  getActionsSection(),
  // => '# Executing actions with care\n...'

  // 5. 当前 Tools 的使用规则
  getUsingYourToolsSection(enabledTools),
  // enabledTools => Set(['Read', 'Edit', 'Bash', 'Grep', ...])
  // 返回值开头 => '# Using your tools'

  // 6. 输出风格
  getSimpleToneAndStyleSection(),
  getOutputEfficiencySection(),
  // => '# Tone and style\n...'
  // => '# Output efficiency\n...'

  // 7. 随当前会话变化的区块
  ...resolvedDynamicSections,
  // 可能包含：
  // => '# Session-specific guidance'
  // => CLAUDE.md / Memory 内容
  // => '# Environment'
  // => '# MCP Server Instructions'
  // => Scratchpad、Language、Output Style 等配置
].filter(section => section !== null)
```

代入本文的示例环境，缩短后的运行值大致是：

```ts
defaultSystemPrompt
// => [
//   'You are an interactive agent that helps users
//    with software engineering tasks...',
//
//   '# System\n
//    - Tools are executed in a user-selected permission mode...
//    - Tool results may include data from external sources...',
//
//   '# Doing tasks\n
//    - Read existing code before proposing changes...
//    - Do not add functionality beyond the request...
//    - Avoid introducing security vulnerabilities...',
//
//   '# Executing actions with care\n
//    Confirm destructive or externally visible operations...',
//
//   '# Using your tools\n
//    Prefer Read/Edit/Grep 等专用 Tool，不要全部交给 Bash...',
//
//   '# Tone and style\n...',
//   '# Output efficiency\n...',
//   '# Session-specific guidance\n...',
//
//   '# Environment\n
//    - Primary working directory: /Users/me/shop
//    - Is a git repository: true
//    - Shell: zsh
//    - You are powered by the model named Claude Sonnet 4.6...',
//
//   // 如果项目存在 CLAUDE.md，这里还会加入项目说明；
//   // 如果 MCP Server 提供 instructions，也会加入对应说明。
// ]
```

因此默认 System Prompt 的核心可以概括成：

> 你是帮助用户完成软件工程任务的交互式 Agent；遵守权限和安全边界，先理解现有代码，再使用当前可用 Tools 完成任务；同时读取当前项目、模型、目录、Memory、CLAUDE.md 和 MCP 提供的动态上下文。

还有一个特殊分支：如果使用 `--bare`，入口会设置 `CLAUDE_CODE_SIMPLE=1`，默认提示词会缩成最小版本。

简化模式位置：`src/constants/prompts.ts:450-456`

```ts
if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
  return [
    `You are Claude Code, Anthropic's official CLI for Claude.

CWD: ${getCwd()}
Date: ${getSessionStartDate()}`,
  ]
}
// --bare 模式中的返回值只有身份、当前目录和日期
// => ['You are Claude Code... CWD: /Users/me/shop ...']
```

本文示例没有主线程 Agent 或 Coordinator 覆盖，所以传入 `--system-prompt "只做代码审查"` 时，`customSystemPrompt` 会代替默认提示词；传入 `--append-system-prompt "回答必须使用中文"` 时，则会在最终提示词末尾追加内容。若指定了主线程 Agent，它自己的 Prompt 优先级更高，实际取值由 `buildEffectiveSystemPrompt()` 统一决定。

##### `model`：把别名解析成实际模型

模型选择的优先级是：

1. CLI 的 `--model`；
2. 当前主线程 Agent Definition 中的 `model`；
3. 环境变量 `ANTHROPIC_MODEL`；
4. Settings 中的 `model`；
5. Claude Code 内置默认模型。

源码位置：`src/main.tsx:2019-2020`、`src/main.tsx:2107-2116`、`src/utils/model/model.ts:61-88`

```ts
const userSpecifiedModel =
  options.model === 'default'
    ? getDefaultMainLoopModel()
    : options.model
// options.model       => 'sonnet'
// userSpecifiedModel  => 'sonnet'

let effectiveModel = userSpecifiedModel
// effectiveModel => 'sonnet'

if (
  !effectiveModel &&
  mainThreadAgentDefinition?.model &&
  mainThreadAgentDefinition.model !== 'inherit'
) {
  // 本例 effectiveModel 已经有值，不进入分支
  effectiveModel = parseUserSpecifiedModel(
    mainThreadAgentDefinition.model,
  )
}

setMainLoopModelOverride(effectiveModel)

setInitialMainLoopModel(
  getUserSpecifiedModelSetting() || null,
)

const initialMainLoopModel =
  getInitialMainLoopModel()
// initialMainLoopModel => 'sonnet'

const resolvedInitialModel =
  parseUserSpecifiedModel(
    initialMainLoopModel ??
      getDefaultMainLoopModel(),
  )
// resolvedInitialModel => 'claude-sonnet-4-6'
```

`sonnet` 只是方便用户输入的别名。`parseUserSpecifiedModel()` 会把它转换成当前版本真正发送给模型服务的名称。

别名解析位置：`src/utils/model/model.ts:445-496`  
本文源码版本的 Sonnet 默认值：`src/utils/model/configs.ts:80-83`

环境变量 `ANTHROPIC_DEFAULT_SONNET_MODEL` 可以覆盖这个默认值；本文示例按未覆盖的普通 First-Party 环境展示，所以结果是 `claude-sonnet-4-6`。

##### `thinkingConfig`：决定模型怎样思考

源码先取默认值，再用 CLI 或环境变量覆盖。

本文示例假设没有设置 `MAX_THINKING_TOKENS`，并且 `settings.alwaysThinkingEnabled` 没有被设为 `false`。在这个条件下，源码的默认值是 `true`。

源码位置：`src/main.tsx:2457-2487`  
默认值来源：`src/utils/thinking.ts:146-159`

```ts
let thinkingEnabled =
  shouldEnableThinkingByDefault()
// 本例没有关闭默认 Thinking
// thinkingEnabled => true

let thinkingConfig =
  thinkingEnabled !== false
    ? { type: 'adaptive' }
    : { type: 'disabled' }
// thinkingConfig => { type: 'adaptive' }

if (
  options.thinking === 'adaptive' ||
  options.thinking === 'enabled'
) {
  thinkingEnabled = true
  thinkingConfig = { type: 'adaptive' }
} else if (options.thinking === 'disabled') {
  thinkingEnabled = false
  thinkingConfig = { type: 'disabled' }
} else {
  const maxThinkingTokens =
    process.env.MAX_THINKING_TOKENS
      ? parseInt(
          process.env.MAX_THINKING_TOKENS,
          10,
        )
      : options.maxThinkingTokens
  // options.thinking                 => undefined
  // process.env.MAX_THINKING_TOKENS  => undefined
  // options.maxThinkingTokens        => undefined
  // maxThinkingTokens                => undefined

  // maxThinkingTokens 没有值，不进入预算覆盖分支
}
```

因此本文示例最终得到：

```ts
systemPrompt        // => undefined
appendSystemPrompt  // => undefined
resolvedInitialModel
// => 'claude-sonnet-4-6'
thinkingConfig
// => { type: 'adaptive' }
```

这里的 Thinking 和前文的 `permissionMode: 'plan'` 没有直接关系：

- `plan` 决定 Agent 先规划还是直接实施，以及相应权限流程；
- `thinkingConfig` 决定一次模型请求使用 adaptive thinking、固定预算还是关闭 Thinking。

#### ⑤ `initialState / sessionConfig`：组装会话

前四组数据准备好后，`.action()` 把它们放进两个对象：

源码位置：`src/main.tsx:2926-3090`

```ts
const initialState = {
  mainLoopModel: initialMainLoopModel,
  // initialMainLoopModel => 'sonnet'

  toolPermissionContext: effectiveToolPermissionContext,
  // effectiveToolPermissionContext.mode => 'plan'

  agentDefinitions,
  // activeAgents 中可能包含 => 'code-reviewer'

  mcp: {
    clients: [],  // => []，MCP 后台仍在连接
    tools: [],    // => []
    commands: [], // => []
    resources: {}, // => {}
    pluginReconnectKey: 0, // => 0
  },
  initialMessage: inputPrompt
    ? {
        message: createUserMessage({
          content: inputPrompt, // => '检查登录模块'
        }),
      }
    : null,
  // initialMessage.message.message.content => '检查登录模块'

  thinkingEnabled, // => true
  todos: {},       // => {}
  notifications: { current: null, queue: [] },
  // notifications => { current: null, queue: [] }
  // ...
}

const sessionConfig = {
  commands: [...commands, ...mcpCommands],
  // commands 的 name 可能
  // => ['simplify', 'verify', 'review', 'test-login', ...]

  initialTools: mcpTools, // => []，慢 MCP 尚未连上
  mcpClients,             // => []
  mainThreadAgentDefinition, // => undefined
  systemPrompt,              // => undefined，使用默认系统提示词
  appendSystemPrompt,        // => undefined
  thinkingConfig,            // => { type: 'adaptive' }
  // ...
}
```

为什么要分成两个对象？看 `launchRepl()` 把它们交给谁就明白了：

源码位置：`src/replLauncher.tsx:12-21`

```tsx
<App {...appProps}>
  <REPL {...replProps} />
</App>

// appProps.initialState => initialState
// replProps             => { ...sessionConfig, ... }
```

`main.tsx` 只是把数据分成两包：

| 对象            | 交给谁        | 放什么                                  |
| --------------- | ------------- | --------------------------------------- |
| `initialState`  | 外层 `<App>`  | 权限、MCP 状态、Todos、通知等共享状态   |
| `sessionConfig` | 内层 `<REPL>` | Commands、模型配置、Prompt 覆盖项和回调 |

一句话：`initialState` 初始化外层 App，`sessionConfig` 配置内层 REPL。

### `ToolUseContext`：构造每轮执行现场

前面准备的是“整个会话拥有什么”，但 Command、Skill 和 Tool 真正执行时，不能每个函数都单独传十几个参数。`ToolUseContext` 就是它们共用的一次执行上下文。

类型定义：`src/Tool.ts:158-245`

```ts
export type ToolUseContext = {
  options: {
    commands: Command[]
    tools: Tools
    mainLoopModel: string
    thinkingConfig: ThinkingConfig
    mcpClients: MCPServerConnection[]
    agentDefinitions: AgentDefinitionsResult
    refreshTools?: () => Tools
  }

  abortController: AbortController

  // 每次调用时读取最新会话状态
  getAppState(): AppState
  setAppState(
    update: (prev: AppState) => AppState,
  ): void

  // 还包含 messages、文件缓存、通知和 UI 回调等
  // ...
}

// 这只是类型定义；交互示例真正构造出的关键字段可能是：
// options.mainLoopModel => 'sonnet'
// options.tools 中的 name => ['Read', 'Edit', 'Bash', 'Grep', ...]
// options.mcpClients => []
// getAppState().toolPermissionContext.mode => 'plan'
```

可以把它理解为本轮执行的“工作台”：

- `options` 放本轮可用的 Commands、Tools、Agents、MCP 和模型配置；
- `getAppState()` 读取当前权限、MCP 连接和其他动态状态；
- `setAppState()` 把 Tool 产生的状态变化写回会话；
- `abortController` 负责用户按下中断键时停止当前工作。

交互模式会在用户每次提交输入时创建它。下面沿用上一节的权限示例和本节的扩展能力示例，把中间值直接放到源码旁。

创建位置：`src/screens/REPL.tsx:2392-2475`

```ts
const getToolUseContext = useCallback((
  messages,
  newMessages,
  abortController,
  mainLoopModel,
) => {
  // 不使用旧的 React 闭包，而是读取当前 AppState
  const s = store.getState()

  const computeTools = () => {
    const state = store.getState()

    // 把内置 Tools 与此刻已经连接的 MCP Tools 合并
    const assembled = assembleToolPool(
      state.toolPermissionContext,
      state.mcp.tools,
    )

    return mergeAndFilterTools(
      combinedInitialTools,
      assembled,
      state.toolPermissionContext.mode,
    )
  }

  return {
    abortController,

    options: {
      commands,
      // commands.map(command => command.name)
      // => ['simplify', 'verify', 'review', 'test-login', ...]

      tools: computeTools(),
      // options.tools.map(tool => tool.name)
      // => ['Bash', 'Grep', 'Read', 'Edit',
      //     'mcp__project-server__search']

      mainLoopModel,
      // => 当前会话选择的模型

      thinkingConfig,

      mcpClients: mergeClients(
        initialMcpClients,
        s.mcp.clients,
      ),
      // options.mcpClients.map(client => client.name)
      // => ['project-server']

      agentDefinitions: s.agentDefinitions,
      // activeAgents 中包含 code-reviewer

      // MCP 可能在本轮执行过程中连接成功，
      // 因此需要一个重新计算 Tools 的函数
      refreshTools: computeTools,
    },

    getAppState: () => store.getState(),
    setAppState,
    messages,
    // ...
  }
})
```

这里正好解释了为什么它重要：`initialState` 和 `sessionConfig` 只是保存数据，`ToolUseContext` 才把当前时刻的这些数据送到执行现场。

例如权限检查和 Agent Tool 都直接依赖它：

权限检查位置：`src/utils/permissions/permissions.ts:1158-1176`  
Agent 查找位置：`src/tools/AgentTool/AgentTool.tsx:286`

```ts
// 权限检查读取当前模式和规则
const appState = context.getAppState()
const permissionContext =
  appState.toolPermissionContext
// => { mode: 'acceptEdits', ... }

// Agent Tool 读取当前可用的 Agent Definitions
const agentDef =
  toolUseContext.options.agentDefinitions
    .activeAgents
    .find(agent =>
      agent.agentType === subagent_type,
    )
// subagent_type => 'code-reviewer'
// agentDef      => { agentType: 'code-reviewer', ... }
```

Skill 也会收到同一个对象。项目 Skill 如果需要执行内嵌 Shell、读取权限或访问会话信息，可以从这里取得，不需要自己重新构造一套运行环境。

Skill 使用位置：`src/skills/loadSkillsDir.ts:344-390`

所以完整关系不是“加载完 Skills、Agents 和 MCP 就结束”，而是先把扩展能力写入 `initialState / sessionConfig`，每轮再创建 `ToolUseContext`，最后由 Command、Skill、Tool 和 Agent 共用它执行。

到这里再补上执行阶段的最后一段就顺了：

| 执行时需要什么                                    | 从哪里取得                     |
| ------------------------------------------------- | ------------------------------ |
| 本轮可用的 Tools、Commands、Agents 和 MCP Clients | `toolUseContext.options`       |
| 当前权限模式、MCP Tools 和其他动态会话状态        | `toolUseContext.getAppState()` |
| Tool 执行后产生的状态变化                         | `toolUseContext.setAppState()` |

理解了这层运行时桥梁，再回到最外层看 Claude Code 如何选择交互或 Headless 适配器。

## 选择运行适配器：交互、Print 和 SDK

从使用方式看，Claude Code 有三种模式：

1. 交互式 CLI；
2. Print / Headless；
3. SDK。

但从源码最外层的控制流看，实际上只有两个分支：

1. `launchRepl()`；
2. `runHeadless()`。

SDK 没有单独复制一套 Agent 逻辑，它是 `runHeadless()` 中使用流式输入输出协议的一种模式。

![图 13：交互、Print 和 SDK 是怎么区分的](https://windliangblog.oss-cn-beijing.aliyuncs.com/01-claude-command-to-agent-loop-diagram-13.png)

对于本文示例，分流变量是：

```ts
print
// => undefined

inputFormat
// => undefined

outputFormat
// => undefined

sdkUrl
// => undefined

isNonInteractiveSession
// => false

// 最终选择
// => launchRepl(...)
```

如果只把命令改成：

```bash
claude -p "检查登录模块"
```

那么关键值就会变成：

```ts
print
// => true

isNonInteractiveSession
// => true

// 最终选择
// => runHeadless(...)
```

### SDK 模式是怎么识别的

如果传入：

```bash
--sdk-url wss://...
```

入口会自动补齐：

```ts
// 假设用户传入 --sdk-url wss://agent.example/ws
// sdkUrl => 'wss://agent.example/ws'
// inputFormat => undefined
// outputFormat => undefined
// options.verbose => undefined
// options.print => undefined
if (sdkUrl) {
  // 条件 => true
  if (!inputFormat) {
    inputFormat = 'stream-json'
    // inputFormat => 'stream-json'
  }

  if (!outputFormat) {
    outputFormat = 'stream-json'
    // outputFormat => 'stream-json'
  }

  if (options.verbose === undefined) {
    verbose = true
    // verbose => true
  }

  if (!options.print) {
    print = true
    // print => true
  }
}
```

本地 Python/TypeScript SDK 通常使用：

```text
-p
--input-format stream-json
--output-format stream-json
--verbose
```

并通过 `CLAUDE_CODE_ENTRYPOINT` 标记调用方：

```text
sdk-py
sdk-ts
sdk-cli
```

因此源码里没有只依赖一个 `isSdkMode`。判断 SDK 要结合下边几项：

- 是否非交互；
- 输入输出格式；
- `sdkUrl`；
- `CLAUDE_CODE_ENTRYPOINT`。

---

启动部分到这里就结束了：`launchRepl()` 和 `runHeadless()` 接收前面准备好的会话数据，分别适配交互式终端与 Print / SDK。

这两条路径最终都会进入同一套执行内核：REPL 在 `src/screens/REPL.tsx:2793` 直接消费 `query()` 产生的事件；Headless 通过 `QueryEngine` 在 `src/QueryEngine.ts:675` 消费 `query()`。而 `query()` 的主干就是把控制权交给 `queryLoop()`：

```ts
// src/query.ts:224-241
export async function* query(params: QueryParams) {
  const consumedCommandUuids: string[] = []
  const terminal =
    yield* queryLoop(params, consumedCommandUuids)

  // queryLoop 正常结束后处理命令生命周期
  // ...
  return terminal
}
```

因此本文标题中的“到 Agent 主循环”，指的就是启动流程最终抵达 `queryLoop()`；循环内部怎样请求模型、执行 Tool 和决定下一轮，这里不再展开。

## 从 Claude Code 源码里可以学到什么

如果只是想知道 Claude Code 怎么启动，看到这里主流程已经结束了。

但源码更有意思的地方，是它怎么处理一个真实 Agent 产品会遇到的问题。下边这些做法不一定需要原样照搬，不过自己写 Agent、CLI 或本地开发工具时都可以参考。

### 入口文件尽量轻

`cli.tsx` 没有导入所有模块以后再判断参数，而是先处理 `--version`、Chrome、Daemon 等简单分支，最后才动态加载 `main.tsx`：

```ts
// src/entrypoints/cli.tsx:33-300
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  // 执行 claude --model sonnet "检查登录模块" 时
  // => ['--model', 'sonnet', '检查登录模块']

  if (
    args.length === 1 &&
    ['--version', '-v', '-V'].includes(args[0])
  ) {
    // 本例条件 => false
    console.log(`${MACRO.VERSION} (Claude Code)`)
    return
  }

  // 先处理环境变量和特殊入口……

  const { main: cliMain } =
    await import('../main.js')
  // cliMain => src/main.tsx 导出的 async main 函数

  await cliMain()
  // 完成后的解析值 => undefined
}
```

这里能学到的不是简单的“使用动态 import”，而是把启动分成了两个阶段：

![图 15：入口文件尽量轻](https://windliangblog.oss-cn-beijing.aliyuncs.com/01-claude-command-to-agent-loop-diagram-15.png)

对于一个普通脚本，静态加载所有模块问题不大。但 Agent 产品通常会包含 UI、模型 SDK、浏览器、MCP、工具系统和大量配置。把入口保持得足够轻，可以得到几个好处：

- 简单命令启动更快；
- 完整运行时中的模块出问题时，不会影响 `--version` 这类独立快速路径；
- 可以先设置环境变量，再执行依赖模块的顶层代码；
- 不同运行入口不会无条件加载对方的依赖。

迁移到自己的 Agent CLI 时，入口也只需要保留三件事：识别快速命令、设置必须提前生效的环境变量、动态加载真正的运行模块。

### 命令入口和业务入口分开

从源码看，Claude Code 有三层入口：

![图 16：Claude Code 的三层入口](https://windliangblog.oss-cn-beijing.aliyuncs.com/01-claude-command-to-agent-loop-diagram-16.png)

这三层看起来有点绕，但职责并不一样：

- `cli.tsx::main()` 解决“这个进程应该加载哪个程序”；
- `main.tsx::main()` 解决“本次进程以什么模式运行”；
- `.action()` 解决“这一次 Claude 会话需要哪些数据”。

自己写 CLI 时很容易把参数解析、环境初始化、工具创建、UI 启动和模型调用都放进同一个 `main()`。代码量少的时候没什么问题；功能变多以后，测试一个 `--version` 都可能需要初始化数据库或模型客户端。

Claude Code 的处理方式说明，可以按照“进程启动、命令路由、会话组装、任务执行”拆开。以后新增子命令或新的运行模式时，不需要把所有逻辑重新塞回 `main()`。

## 小结

仍然代入本文的命令：

```bash
claude \
  --model sonnet \
  --permission-mode plan \
  --mcp-config ./mcp.json \
  "检查登录模块"
```

整条启动链最终可以压缩成下表：

| 阶段               | 关键源码位置                                                 | 本文示例产生的结果                                           |
| ------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| Shell 启动轻量入口 | `src/entrypoints/cli.tsx:1-302`                              | 进入普通会话分支，动态加载 `main.tsx`                        |
| 初始化并解析 CLI   | `src/main.tsx:585`、`src/main.tsx:884`                       | Commander 选择根命令的 `.action()`                           |
| 处理输入           | `src/main.tsx:857-881`                                       | `inputPrompt => '检查登录模块'`                              |
| 准备权限和 Tools   | `src/utils/permissions/permissionSetup.ts:689-1055`、`src/tools.ts:271-321` | `permissionMode => 'plan'`，生成 `toolPermissionContext` 和 `tools` |
| 加载扩展能力       | `src/main.tsx:1918-2455`                                     | 得到 `commands`、`agentDefinitions`；MCP 在后台连接          |
| 准备模型配置       | `src/main.tsx:1343-1392`、`src/main.tsx:2019-2116`、`src/main.tsx:2457-2487` | `resolvedInitialModel => 'claude-sonnet-4-6'`，`thinkingConfig => { type: 'adaptive' }` |
| 组装会话           | `src/main.tsx:2926-3090`                                     | 生成 `initialState` 和 `sessionConfig`                       |
| 选择运行外壳       | `src/main.tsx:2829`、`src/main.tsx:3798`                     | 本例没有 `-p`，所以进入 `launchRepl()`                       |
| 构造本轮执行现场   | `src/Tool.ts:158-245`、`src/screens/REPL.tsx:2392-2475`      | 创建 `ToolUseContext`，把当前 Tools、权限、Agents、MCP、模型和状态交给执行代码 |

最后把三个对象放在一起：

| 数据             | 交给谁             | 作用                   |
| ---------------- | ------------------ | ---------------------- |
| `initialState`   | `<App>`            | 初始化会话共享状态     |
| `sessionConfig`  | `<REPL>`           | 配置交互层             |
| `ToolUseContext` | Tool、Skill、Agent | 提供本轮执行所需的数据 |

所以 `ToolUseContext` 不是另一种 Tool，也不是新的扩展来源。它是会话容器与执行代码之间的桥梁。
