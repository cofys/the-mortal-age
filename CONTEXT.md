# Project Briefing — The Mortal Age

Read this at the start of every work session, before `TASKS.md`. It is the
project's shared brain. If your work changes anything in here, update it in the
same merge.

## What this is

A heavily customized RuneScape private server — an alternate-reality Gielinor,
not a replica. Think Turtle WoW's relationship to vanilla WoW: keep what made it
special, improve on it, diverge where it serves the vision. TypeScript fork of
[tsps](https://github.com/rspsapp/tsps), browser client, zero install.

Repo: `github.com/cofys/the-mortal-age`. Upstream tsps merges nightly (~3am).

## Design laws (non-negotiable)

1. **Every life is a full game.** WoW-style exploration and raiding, Albion-style
   player-driven crafting economy, deep kingdom management. Economy first.
2. **Every person is real.** No static NPCs. Shops, offices, and roles are
   obtainable and staffed by citizens or players interchangeably — an AI
   shopkeeper and a human shopkeeper are the same kind of thing.
3. **Citizens are players, not props.** They are indistinguishable from real
   players: friends and enemies, clan invites, boss runs, every player function,
   each with their own goals and personality. They also seed the server's RP
   culture — they model in-character behavior so real players join it rather
   than breaking silence.
4. **Skilling is denser, not slower.** Risk/reward methods whose output feeds the
   war effort and the economy. No grind for grind's sake.
5. **Token frugality is a feature.** Citizen AI runs extreme token optimization:
   simulated behavior when no player is near, LLM only on real interaction.

## Locked lore (do not contradict)

- King Roald has a hidden bastard son.
- Lowerniel's fate is live (in play).
- The old player kingdoms likely wiped out — the world is post-fall.

## Architecture

- `client/` — browser (WebGL) client. `server/` — game server (TypeScript).
- `server/plugins/citizens/` — the citizen AI system (the main build front).
- `server/plugins/` — content plugins (quests, areas, systems).
- Concurrent work via git worktrees: `scripts/wt new <branch>` (see `AGENTS.md`).
- Deploys to Jon's PC go: kill server → `git pull` → verify → start → re-enable
  the watchdog scheduled task. Server keys live in `C:\tools\tma-env.bat` —
  automation never touches that file.

## Scope right now (Phase 1)

Home-city pick at character creation, the starting experience, citizens in the
streets. Custom quests are deferred to Phase 10 — do not build quest content yet.

## Hard boundaries

- Never exceed any AI free tier; never spend Jon's money without his explicit say-so.
- Engine fixes go upstream to tsps only after Jon personally tests them and says go.
  Everything custom stays in this fork.
- Never `git reset --hard`, never force-push, never commit save/data files.
- Full working protocol: `COLLAB.md`. Task board: `TASKS.md`.

## Key terms

- **Citizen**: an AI player. Not an NPC. Treat them as people in every design decision.
- **Worktree**: an isolated checkout + branch + ports for one worker.
- **The fallback**: if the origin/home-city choice ever fails, the design default is
  already decided — don't invent a new one, ask in the task.
