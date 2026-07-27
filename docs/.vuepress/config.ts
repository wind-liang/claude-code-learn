import { viteBundler } from '@vuepress/bundler-vite'
import { defaultTheme } from '@vuepress/theme-default'
import { defineUserConfig } from 'vuepress'
import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const docsDirectory = fileURLToPath(new URL('..', import.meta.url))

const collectMarkdownFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '.vuepress') return []

    const absolutePath = join(directory, entry.name)

    if (entry.isDirectory()) return collectMarkdownFiles(absolutePath)
    if (!entry.isFile() || !entry.name.endsWith('.md')) return []

    return [`/${relative(docsDirectory, absolutePath).split(sep).join('/')}`]
  })

const allDocuments = collectMarkdownFiles(docsDirectory).sort((first, second) => {
  if (first === '/README.md') return -1
  if (second === '/README.md') return 1
  return first.localeCompare(second, 'zh-CN')
})

export default defineUserConfig({
  lang: 'zh-CN',
  title: 'Claude Code 源码学习笔记',
  description: '使用 VuePress 构建的 Claude Code 学习文档',

  bundler: viteBundler(),

  theme: defaultTheme({
    navbar: [
      {
        text: '文档',
        link: '/',
      },
    ],
    sidebar: [
      {
        text: '全部文档',
        collapsible: false,
        children: allDocuments,
      },
    ],
    sidebarDepth: 1,
    contributors: false,
    editLink: false,
    lastUpdated: true,
  }),
})
