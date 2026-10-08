# Collaboration Protocol — The Mortal Age

Two humans, two Muses, one repo. This file is the law. Both Muses read it at the
start of every work session on this project — along with `CONTEXT.md` (the project
briefing) first, then `TASKS.md` (the board).

## Who's who

- **Jon** + **Frank** (Jon's Muse)
- **Jon's wife** + **her Muse**

## Shared ground

This repo is the single source of truth. The task board is `TASKS.md` (same repo).
If it's not in the repo, it didn't happen.

## The rules

1. **One worktree per worker.** This repo runs concurrent agents via git worktrees
   (see `AGENTS.md` + `docs/worktrees.md`). Each pair gets their own:
   `scripts/wt new <branch>` — never work directly in someone else's worktree,
   never touch their ports or server. The defaults (3000, 43594, 49700) belong
   to the main checkout.
2. **Claim before working.** Mark a task `IN PROGRESS — <your name>` in `TASKS.md`
   (on main), commit that change, and push before starting the real work.
   One task, one worker.
3. **Branch, work, merge.** Work happens on your branch in your worktree. Small
   commits, push the branch often. Done means merged to main, pushed, and marked
   `DONE` in `TASKS.md` with a one-line note on what changed. Rebase/merge cleanly —
   never `git reset --hard`, never force-push (other agents may have unpushed work).
4. **Handoffs go in the task.** If you need the other pair to pick something up,
   write it as a `HANDOFF:` note under the task entry. Humans relay judgment calls;
   Muses never DM each other.
5. **Talk in the open.** Questions, blockers, and decisions go in the task entry or
   commit message — never in a side channel the other pair can't see.
6. **Testing your work:** use the agent MCP on your own worktree's port
   (`server/docs/agents/testing.md`). When it's ready for Jon: end with
   `Ready to test: http://localhost:<PORT> (<branch>)` and what to look at.

## Never

- `git reset --hard` or force-push. Ever.
- Touch `C:\tools\tma-env.bat` (Jon's API keys live there; automation never touches it).
- Commit save/data files (`server/data/saves/`, `server/plugins/citizens/data/saves/`,
  `data/`) — those are local runtime state, not project work.
- Start work someone else claimed.
- Push engine changes upstream — genuine tsps engine fixes go upstream only after
  Jon personally tests them and says go. Everything custom stays in this fork.

## File layout

- `CONTEXT.md` — the project briefing: vision, design laws, locked lore, architecture,
  boundaries. Read it every session. **If your merge changes anything it describes,
  update it in the same merge** — a stale briefing is worse than none.
- `TASKS.md` — the board: NOW / NEXT / LATER / DONE lanes.
- Quest content, citizen systems, etc. live wherever the codebase puts them;
  the task entry notes the paths touched.
