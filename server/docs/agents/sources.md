# Where behaviour comes from

## Source-of-truth order

When behaviour is unclear, resolve in this order:

1. **OSRS Wiki** - gameplay intent, drop tables, requirements, mechanics:
   <https://oldschool.runescape.wiki/> (see also
   [Category:Game mechanics](https://oldschool.runescape.wiki/w/Category:Game_mechanics))
2. **osrs-docs** - engine-level mechanics the Wiki omits: collision, pathing, update masks,
   client/server internals: <https://osrs-docs.com/>
3. **osrsindex** - ids, definitions, cross-referenced cache data: <https://osrsindex.com/>
4. **OpenRune** - cache formats, tooling, definition layouts: <https://openrune.dev/>
5. **RuneLite** - client-side truth. Packet/opcode shapes, `gameval` id constants
   (`InterfaceID`, `VarbitID`, `VarPlayerID`, `ItemID`), and how the real client reacts to
   what the server sends.
6. **This server's own cache** - the final authority on ids and interface layout, read with
   the dump scripts in [cache.md](cache.md).

If a source conflicts with the cache in `server/caches`, the cache wins - it is what the
client actually loads. If sources conflict on behaviour, prefer the Wiki.

Do not cite another private server as justification. If a behaviour can only be found in
RSPS code, say so explicitly in the PR so it can be checked.

## Packet captures

Captures from live OSRS (for example with rsprox) are first-hand evidence for what the
server sends: packet order, varps/varbits, interface events, exact messages. Record the facts a
feature relies on in its docs page, not the raw logs (they carry account details), and check
every captured id against the cache - live may be a newer revision than `server/caches`.

## Pinned cache research reference

Use [Joshua-F/osrs-dumps at 6e5033af6215963581a51b348f452320ff18f0f6](https://github.com/Joshua-F/osrs-dumps/tree/6e5033af6215963581a51b348f452320ff18f0f6)
for readable client scripts, interface layouts and named cache definitions. This
2026-10-20 revision 241 snapshot matches `server/target.txt` (`osrs-241_2026-10-20`).
Its [snapshot commit](https://github.com/Joshua-F/osrs-dumps/commit/6e5033af6215963581a51b348f452320ff18f0f6)
identifies [OpenRS2 cache 2746](https://archive.openrs2.org/caches/runescape/2746) as its source.

- [script/](https://github.com/Joshua-F/osrs-dumps/tree/6e5033af6215963581a51b348f452320ff18f0f6/script):
  readable CS2 control flow, script arguments and varp/varbit dependencies.
- [interface/](https://github.com/Joshua-F/osrs-dumps/tree/6e5033af6215963581a51b348f452320ff18f0f6/interface):
  component layouts, on-load scripts and event listeners.
- [config/](https://github.com/Joshua-F/osrs-dumps/tree/6e5033af6215963581a51b348f452320ff18f0f6/config)
  and [symbols/](https://github.com/Joshua-F/osrs-dumps/tree/6e5033af6215963581a51b348f452320ff18f0f6/symbols):
  definitions, enums, database rows and name-to-id mappings.

For example, [adventurepath_init](https://github.com/Joshua-F/osrs-dumps/blob/6e5033af6215963581a51b348f452320ff18f0f6/script/%5Bclientscript%2Cadventurepath_init%5D.cs2)
shows how selected path/task variables restore the journal and trigger redraws.
Use these dumps alongside `yarn dump:cs2`, `dump:widget` and `dump:enum`; confirm ids
and layouts against the active local cache. Client scripts do not establish server
gameplay rules, drop rates or packet timing: the source order and capture guidance
above still apply.

Both Codex and Claude should cite links containing this full commit SHA, rather than
the moving `master` branch. When `server/target.txt` changes, recheck the snapshot's
revision **and date** and update this pin deliberately; revision 241 has multiple
dated snapshots. The pin is a research reference, not a runtime dependency.

## Reference codebases

External codebases, ranked by usefulness as reference material. Scores are overall quality,
with content and code noted separately where they diverge. These are references for
architecture, tooling and content - the order above still governs behaviour, except where a
source is called out as a behavior oracle.

- **RSProx** (unscored: a capture tool, not a server) — a local proxy that records the traffic
  between the real client and live OSRS (the captures above). Kotlin; packet decoders for each
  revision from 223 (`protocol/osrs-<revision>`), a transcriber and replay. MIT. Behavior
  oracle. <https://github.com/blurite/rsprox>, recordings at <https://rsprox.net/database>
- **Void** 9/10 — cleanest RSPS codebase; Kotlin, docs, CI, script system. 2011 rev634. BSD-3.
  <https://github.com/GregHib/void>
- **LostCity** 8/10 — TS engine + script-driven 2004 content; ideal architecture ref, not
  OSRS. MIT. <https://github.com/LostCityRS/Engine-TS> + `/Content`
- **OpenRune** 8/10 — RSMod fork, OSRS rev240, plugin loading, honest progress (20/23
  skills, 18/169 bosses). ISC. <https://github.com/OpenRune/OpenRune-Server>
- **Project Gielinor** 7/10 — RSMod fork rev239; cleaner docs, overlaps OpenRune. ISC.
  <https://github.com/Slashx124/Project-Gielinor>
- **Offline_Scape** 6/10 (content 8, code 6) — Near rev240, being de-customised toward
  vanilla OSRS; pristine OpenRS2 cache, auto-discovered early Sailing (boats/docks/cargo).
  Active, 1 dev. No license (NR lineage). Behavior oracle.
  <https://github.com/MouldyToast/Offline_Scape>
- **Near-Reality** 6/10 (content 9, code 3) — huge skills/bosses/skilling content; 2-commit
  leaked dump, no license, messy. Behavior oracle only.
  <https://github.com/kurdowns/RSPS-NEAR-REALITY>
