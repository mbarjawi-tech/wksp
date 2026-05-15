---
layout: home

hero:
  name: wksp
  text: Workspace CLI for Claude Code
  tagline: Multi-repo development with git worktrees. Each task gets its own isolated set of branches — work on multiple features simultaneously without ever branch-switching.
  actions:
    - theme: brand
      text: Get Started
      link: /concepts
    - theme: alt
      text: Installation
      link: /installation
    - theme: alt
      text: Reference
      link: /reference

features:
  - icon: 🌿
    title: Isolated task branches
    details: Each task gets its own git worktrees — one per repo — so multiple tasks can live on different branches of the same repo simultaneously. No more branch-switching, no more "already checked out" errors.
  - icon: 🤖
    title: Claude Code integration
    details: wksp task launches Claude with all your worktrees pre-loaded as additional directories. Conversation history is automatically resumed so context carries over between sessions.
  - icon: 📦
    title: Smart archive
    details: Archive a completed task to free up worktrees while preserving your CLAUDE.md, notes, and branch metadata. Unarchive smoothly later — even when branches have been merged, deleted, or moved.
  - icon: 🗂️
    title: Multi-repo, single workspace
    details: Every task generates a VS Code multi-root workspace file that opens all repos in the sidebar, scoped to the task's branches. Switch tasks by switching workspace files.
---
