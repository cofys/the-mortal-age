# Archived native definitions

Seasonal activities can retain native definitions removed from the active cache.
`DefinitionArchives` installs a complete, cache-bound bundle and sends its snapshot
through the existing content packet at login and after a successful update.
The default snapshot is empty. This service does not start an event or grant rewards.

## Preparing a bundle

Use `ArchivedDefinitionBundle` in `CacheDefinitions`' mirrored codec. Each row keeps
its original native bytes as base64, their unsigned CRC32, source ID and symbolic
name. `sourceCache` supplies the original decoder revision; `targetCache` identifies
the actual destination cache by name, game and revision.

Allocate NPC and scenery IDs starting at the destination's native counts, below the
16-bit wire sentinel. Keep each historical source ID separately. Never reuse an old
NPC ID merely because it once named the required actor: another live actor may now
use it. Existing item IDs may be restored only if the current native name is `Null`
and `expectedCurrentCrc` matches its complete current bytes.

Include the closure of native definition references: morph targets, note/bought/
placeholder templates and quantity variants. The registry remaps these links to
the assigned IDs and rejects unresolved references. A retired item's placeholder
template may also need a private appended copy; do not assume today's template
bytes match its historical version.

Check source models, animations and varbit layouts against the shipped cache.
Definition validation does not restore missing model files or prove gameplay,
timing or asset compatibility. Preserve source archive provenance and extraction
evidence. The test fixtures use Jagex's revision 235 cache from 17 December 2025,
[OpenRS2 cache 2392](https://archive.openrs2.org/caches/runescape/2392).

## Installing and using definitions

Content installs through the custom event, using `api.core` for the lookup:

```js
const request = { bundles };
api.emitCustomEvent("definition-archives:install", request);
if (!request.handled) throw new Error(request.error || "Archive installation failed");
const id = api.core.CacheDefinitions.getArchivedId(bundleId, "npc", symbol);
```

Install before spawning the content's actors and scenery. Register temporary
objects through `ObjectManager` and keep their normal lifecycle under the event's
ownership. Deregister affected objects before replacing or removing their archived
definitions. The service refuses a semantic scenery-definition change while a
registered world object still uses an affected ID. An identical snapshot remains
valid. This preserves the old definition until ordinary deregistration can remove
its collision; removing the definition first can otherwise leave invisible walls.

The guard covers `ObjectManager` registrations, including private and owner
objects. Raw replacement/template maps and procedural clipping that bypass that
registration are not supported archive consumers without equivalent lifetime
tracking. Keep archive IDs out of raw map/template data until that tracking exists.

Resolve archived IDs by bundle, kind and symbol. Do not add historical numeric IDs
to the current cache's generated identifiers or modify the active cache files.
The registry validates the entire candidate before publication; a rejected update
does not partially replace its mappings.

## Client lifecycle

The client decodes each row with its source revision inside the existing custom
NPC/item and item-template loaders. Content updates invalidate derived renderer,
type, model, pose and scene caches. Instance templates and runtime loc state are
retained for a rebuild. Obsolete pending scene results cannot publish into the
new definition generation. Workers receive the current snapshot during startup;
persistent map-square keys include its fingerprint. A new connection clears the
previous world's snapshot, including connections to servers without this dataset.

Partial content payloads preserve unrelated world overlays. New connections clear
those overlays explicitly instead of making every dataset erase them.
