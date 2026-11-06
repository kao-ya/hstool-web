import { defineConfig } from "vitepress";
import { defineTeekConfig } from "vitepress-theme-teek/config";

// Teek 的 defineTeekConfig 只产出 { vite, markdown, themeConfig, ... }，
// 不含 title/nav 这些 VitePress 站点级配置，所以这里手动合并两层。
const teek = defineTeekConfig({
  teekTheme: true,
  teekHome: false, // 不用博客风格首页
  vpHome: true, // 保留 VitePress 首页（hero + features）
  pageStyle: "card", // 文章页单卡片
  themeSize: "default",
  sidebarTrigger: true,
  // 去掉侧栏/导航里跟着鼠标走的那条聚光灯指示条
  themeEnhance: {
    spotlight: { disabled: true },
  },
  anchorScroll: true,
  windowTransition: true,
  backTop: { enabled: true, showIcon: true },
  loading: false,
  articleAnalyze: { showAll: false },
});

export default defineConfig({
  ...teek,
  lang: "zh-CN",
  title: "HsTool",
  description: "炉石传说卡组构筑与解析工具 · 使用文档",
  cleanUrls: false,
  lastUpdated: true,
  head: [
    ...((teek.head as any[]) || []),
    ["link", { rel: "icon", href: "/logo.svg" }],
    ["meta", { name: "theme-color", content: "#c9a227" }],
  ],
  themeConfig: {
    ...((teek.themeConfig as any) || {}),
    logo: "/logo.svg",
    nav: [
      { text: "指南", link: "/guide/what-is", activeMatch: "/guide/" },
      { text: "设置项", link: "/settings/", activeMatch: "/settings/" },
      { text: "进阶", link: "/advanced/deckstring", activeMatch: "/advanced/" },
      { text: "常见问题", link: "/faq" },
      {
        text: "更多",
        items: [
          { text: "更新记录", link: "/changelog" },
          { text: "打开 HsTool", link: "https://hstool.pages.dev" },
          { text: "GitHub 仓库", link: "https://github.com/kao-ya/hstool-web" },
        ],
      },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "开始使用",
          collapsed: false,
          items: [
            { text: "这是什么", link: "/guide/what-is" },
            { text: "组一套卡组", link: "/guide/build-deck" },
            { text: "导入与导出", link: "/guide/import-export" },
          ],
        },
        {
          text: "使用技巧",
          collapsed: false,
          items: [
            { text: "搜索与筛选", link: "/guide/search" },
            { text: "卡牌详情", link: "/guide/card-detail" },
            { text: "分享你的卡组", link: "/guide/share" },
          ],
        },
      ],
      "/settings/": [
        {
          text: "设置项",
          collapsed: false,
          items: [{ text: "全部设置一览", link: "/settings/" }],
        },
      ],
      "/advanced/": [
        {
          text: "进阶",
          collapsed: false,
          items: [
            { text: "卡组代码（deckstring）", link: "/advanced/deckstring" },
            { text: "卡牌数据与图源", link: "/advanced/data" },
            { text: "常见报错排查", link: "/advanced/troubleshooting" },
          ],
        },
      ],
    },
    socialLinks: [{ icon: "github", link: "https://github.com/kao-ya/hstool-web" }],
    search: {
      provider: "local",
      options: {
        translations: {
          button: { buttonText: "搜索文档", buttonAriaLabel: "搜索文档" },
          modal: {
            noResultsText: "没有找到结果",
            resetButtonTitle: "清除",
            footer: { selectText: "选择", navigateText: "切换", closeText: "关闭" },
          },
        },
      },
    },
    outline: { level: [2, 3], label: "本页目录" },
    docFooter: { prev: "上一页", next: "下一页" },
    darkModeSwitchLabel: "外观",
    sidebarMenuLabel: "目录",
    returnToTopLabel: "回到顶部",
    lastUpdatedText: "最后更新",
    footer: {
      message: "基于 MIT 许可发布 · 卡牌数据来自 HearthstoneJSON",
      copyright: `Copyright © ${new Date().getFullYear()} HsTool`,
    },
  },
});
