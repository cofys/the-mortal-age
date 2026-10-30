# Christmas 2025 native source extraction

`scripts/import-seasonal-definitions.cjs` extracts the Christmas serving-tool,
actor and scenery definitions from a separate historical reference directory.
The generated plugin data is inactive until the activity installs its bundle.
It does not start the event, spawn actors, select progression or grant rewards.

Build the server, then run from `server/`:

```powershell
node scripts/import-seasonal-definitions.cjs --reference <reference-folder> --output plugins/world/seasonal/data/christmas-2025-archive.json
node scripts/import-seasonal-definitions.cjs --reference <reference-folder> --output plugins/world/seasonal/data/christmas-2025-archive.json --check
```

The reference is Jagex's [cache2392](https://archive.openrs2.org/caches/runescape/2392),
revision235 from17December2025. Symbol dumps are from Joshua-F/osrs-dumps commit
`6f75a611629a4fd7d294650f3842b0358172d7f2`. Inputs are external to this repository;
the importer requires the retained source manifests and verifies every consumed
file's byte length and SHA256, then the original reference-table/group CRCs.
The generated output records provenance and hashes rather than local paths.
Native game definitions/assets remain Jagex's copyrighted material; no ownership
or separate redistribution licence is asserted here.

Required reference layout:

- `SOURCE.json`, `dump.npc`, `dump.loc`, `dump.obj`, `dump.varbit`;
- `archives/SOURCE.json`:255/2,255/7,2/6,2/9,2/10,2/14, plus changed historical
  model groups7/312,7/15106,7/17526 and7/26422;
- `archives/SOURCE.maps.json`:255/5, original keys.json and original map
  groups5/2098(l50_53),5/805(l50_153); the retained neighbouring map is also
  verified when listed in that manifest;
- `archives/SOURCE.sequences.json`:2/12.

The exporter follows native morph/item references to a closed78-definition
bundle:32 NPCs,43 scenery types and3 item definitions. Current live cosmetic
rewards are excluded. The retired platter/placeholder retain guarded original
item IDs; all actors/scenery and the historical placeholder template receive
private appended identities. The actual production registry validates the full
candidate before output; it cannot substitute a modern unrelated type for a
missing historical dependency. All output validation finishes before replacement
of the destination file.

The source maps provide125 original scenery placements:24 event-specific objects,
including7 cellar crates, and101 rug decorations reused from Christmas2022.
The original red pub carpet uses54 tiles downstairs and47 upstairs. These are
the exact original placements/rotations, rather than a rectangular replacement
of the ordinary blue carpet. All three `xmas22_pub01_rug*` source definitions
are included explicitly; an `xmas25_`-only filter would omit them. Other reused
seasonal decorations have not yet been included.
They do not provide NPC spawn positions. All26 gameplay-varbit layouts and12
directly referenced sequence definitions match the target cache. All156 referenced
model identities exist;152 model CRCs match. The four changed shared actor model
payloads are recorded and retained as current assets, not globally rolled back.
Definition equality does not prove frame-resource equality, scripted timings,
pathing, rewards or cutscene behaviour. Those still need activity source and native
game checks. The active cache and pinned current dump are never modified.
