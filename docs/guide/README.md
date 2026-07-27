# 开始使用

欢迎来到 Claude Code 学习笔记。

## 本地开发

安装依赖后，启动开发服务器：

```sh
npm run docs:dev
```

## 构建站点

生成可部署的静态文件：

```sh
npm run docs:build
```

构建产物位于 `docs/.vuepress/dist`。

## 添加页面

在 `docs` 目录中创建 Markdown 文件，然后将页面加入
`docs/.vuepress/config.ts` 的导航栏或侧边栏配置。
