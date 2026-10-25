# Exclude obsolete monster pages from NPC loot

Shellbane gryphon (NPC 14860) resolves to two cached Wiki pages. The first,
`Shellbane Gryphon`, has a stale 13-slot table, so kills select it before the
current lowercase page's 128-slot table. The old Wiki title now redirects.

Import the regenerated export from [source fix #19](https://github.com/RSPSApp/osrsreboxed-db/pull/19).
The source loader now uses the existing monster category title listing to exclude
obsolete incremental-cache entries. No generated JSON was hand edited. The
128-slot table takes the stable `shellbane_gryphon` key and NPC 14860 references
it once. Its 1/75 Belle's folly pre-roll, guaranteed bones and feathers are
executable through the actual drop roller.

Reproduction uses source integration
`2fe648dd71d1ed35b859061757d43a16fd8a5eeb`, combining the loader fix with
the existing canonical God Wars #15 pipeline (`1bbeae14`). This preserves this
game branch's exact existing loot source baseline. Two complete regenerated
dumps match byte for byte. NPC export SHA-256:
`8b7264a4d446befc28c17bffd5198c05977f9f8460fea0e6fcc953600551f03f`.
Shared tables remain byte-identical.

The existing authored overrides for Mogre variants 15231/15233 now reference only
the surviving `mogre_sea` table. A regression checks that every authored NPC
override references an existing generated table, preventing dangling old aliases.

The audit excludes 32 obsolete cached pages. Seven obsolete table keys disappear,
with only Shellbane changed among surviving tables. Five retired Hazeel cultist
NPCs and old manta variant 15221 lose their stale mappings; the cultists' current
Wiki page explicitly records that they cannot be attacked. Other old titles
redirect: Manta ray (Sailing), Mogre (Sailing), Scorpion (Sailing), Snake
(Varlamore), Superior venator. Current category-listed encounter pages remain
independent; no blanket NPC-ID deduplication is added.

The source's existing cached revisions are retained. This fixes source selection,
not every rate/mechanic or the freshness of all Wiki captures. Claude's Shellbane
boss, quest, client and plugin files are untouched.

Validation: source loader regression failed before the fix; 40 source parser/
schema/reference checks pass. The game loader regression failed on the two-table
mapping and now verifies one current table plus actual obtainable unique and
guaranteed rewards. Existing reward-preservation checks retain quest variants,
God Wars pools and unrelated loot. Focused game verification: 12/12 passed after
a fresh TypeScript build. Full upstream server suite: 5,829/5,830 passed, with
the sole failure in the unrelated browser-host polling timing fixture. That
complete file passed 7/7 independently afterward. No full-suite skip. Independent
final integration review is clear.
