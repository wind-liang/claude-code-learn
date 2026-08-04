---
title: 文档首页
---

美国东部时间2026年3月31日凌晨4点23分，安全研究者 [Chaofan Shou](https://x.com/Fried_rice) 在 X 发布[推文](https://x.com/Fried_rice/status/2038894956459290963?s=20), 发现 Anthropic 发布到 npm 的 Claude Code 包中，官方没有删除source map 文件, 这意味着 Claude Code 的完整 TypeScript 源码全部泄露, 包含 1902 个源文件以及 513,237 行代码.

系列文章基于 cc 源码， [https://github.com/wind-liang/claude-code-learn](https://github.com/wind-liang/claude-code-learn) 的 cc-src 目录。如果觉得不错感谢一个 star。

