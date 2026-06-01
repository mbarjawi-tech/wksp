import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'wksp',
  description: 'Workspace CLI for Claude Code — multi-repo development with git worktrees',
  base: '/wksp/',
  cleanUrls: true,

  themeConfig: {
    logo: { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>' },

    nav: [
      { text: 'Guide', link: '/concepts' },
      { text: 'Reference', link: '/reference' },
    ],

    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'What is wksp?', link: '/concepts' },
          { text: 'Installation', link: '/installation' },
        ],
      },
      {
        text: 'Examples',
        items: [
          { text: '1 · Getting Started', link: '/examples/01-getting-started' },
          { text: '2 · Multiple Repos', link: '/examples/02-multiple-repos' },
          { text: '3 · Concurrent Tasks', link: '/examples/03-concurrent-tasks' },
          { text: '4 · Task Options', link: '/examples/04-task-options' },
          { text: '5 · Archive Workflow', link: '/examples/05-archive-workflow' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'All Commands & Flags', link: '/reference' },
          { text: 'Migration Guide', link: '/migration' },
          { text: 'Export / Import', link: '/export-import' },
          { text: 'Changelog', link: '/changelog' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/mbarjawi-tech/wksp' },
    ],

    footer: {
      message: 'Released under the MIT License.',
    },

    search: {
      provider: 'local',
    },
  },
})
