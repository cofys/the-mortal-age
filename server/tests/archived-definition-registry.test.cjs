const assert = require('node:assert/strict');
const path = require('node:path');
const zlib = require('node:zlib');
const { before, test } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { ArchivedDefinitionRegistry } = require('../dist/game/cache/codec/rs/config/ArchivedDefinitionRegistry');
const { ArchivedTypeLoader } = require('../dist/game/cache/codec/rs/config/ArchivedTypeLoader');
const { CacheIndexDat2 } = require('../dist/game/cache/codec/rs/cache/CacheIndex');
const { ArchiveNpcTypeLoader } = require('../dist/game/cache/codec/rs/config/npctype/NpcTypeLoader');
const { ArchiveObjTypeLoader, PostProcessedObjTypeLoader } = require('../dist/game/cache/codec/rs/config/objtype/ObjTypeLoader');
const { ArchiveLocTypeLoader } = require('../dist/game/cache/codec/rs/config/loctype/LocTypeLoader');
const { NpcType } = require('../dist/game/cache/codec/rs/config/npctype/NpcType');
const { ObjType } = require('../dist/game/cache/codec/rs/config/objtype/ObjType');
const { LocType } = require('../dist/game/cache/codec/rs/config/loctype/LocType');
const raw = require('./fixtures/archived-seasonal-bundle.json');
let context, natives, archives, info;
let archivePluginRegistered = false;
function registerArchivePlugin() {
  if (archivePluginRegistered) return;
  const { PluginManager } = require('../dist/plugins/PluginManager');
  require('../plugins/world/DefinitionArchives.plugin').register(PluginManager.createApi('DefinitionArchives'));
  archivePluginRegistered = true;
}
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  const active = CachePipeline.getActive();
  info = { name: active.name, game: 'oldschool', environment: 'live', revision: active.revision, timestamp: active.timestamp, size: 0 };
  const configs = CacheIndexDat2.fromStore(2, CachePipeline.getStore());
  archives = { npc: configs.getArchive(9), loc: configs.getArchive(6), obj: configs.getArchive(10) };
  natives = { npc: new ArchiveNpcTypeLoader(info, archives.npc), loc: new ArchiveLocTypeLoader(info, archives.loc), obj: new ArchiveObjTypeLoader(info, archives.obj) };
  context = {
    cacheInfo: info,
    counts: Object.fromEntries(Object.entries(natives).map(([kind, loader]) => [kind, loader.getCount()])),
    currentDefinition: (kind, id) => ({ name: natives[kind].load(id).name, data: archives[kind].getFile(id)?.data }),
  };
});
function bundle() {
  const next = { ...context.counts };
  return {
    id: 'christmas-2025',
    targetCache: { name: info.name, game: info.game, revision: info.revision },
    sourceCache: { ...info, name: 'osrs-235_2025-12-17', revision: 235, timestamp: '2025-12-17T11:45:07Z' },
    definitions: raw.definitions.map(row => ({
      kind: row.kind, symbol: row.symbol, sourceId: row.id,
      id: row.kind === 'obj' && row.symbol !== 'template_for_placeholder' ? row.id : next[row.kind]++,
      dataBase64: row.sourceBytes, crc: zlib.crc32(Buffer.from(row.sourceBytes, 'base64')),
      ...(row.kind === 'obj' && row.symbol !== 'template_for_placeholder' ? { expectedCurrentCrc: zlib.crc32(Buffer.from(archives.obj.getFile(row.id).data)) } : {}),
    })),
  };
}
function view(registry, kind, Constructor) {
  return new ArchivedTypeLoader(natives[kind], Constructor,
    id => registry.getSource(kind, id), () => registry.getCount(kind));
}
test('real source bundle appends NPC/loc types, restores only the retired platter and remaps native morphs', () => {
  const registry = new ArchivedDefinitionRegistry(context);
  registry.replace([bundle()]);
  assert.equal(registry.getCount('npc'), context.counts.npc + 32);
  assert.equal(registry.getCount('loc'), context.counts.loc + 40);
  assert.equal(registry.getCount('obj'), context.counts.obj + 1);
  const npc = view(registry, 'npc', NpcType), loc = view(registry, 'loc', LocType), obj = view(registry, 'obj', ObjType);
  const root = npc.load(registry.resolve('christmas-2025', 'npc', 'xmas25_queue_npc_1'));
  assert.equal(root.transform({ getVarbit: () => 0, getVarp: () => 0 }, npc).name, 'Sir Prysin');
  assert.equal(root.transform({ getVarbit: () => 1, getVarp: () => 0 }, npc).name, 'Aggie');
  assert.equal(root.transform({ getVarbit: () => 99, getVarp: () => 0 }, npc), undefined);
  assert.equal(npc.load(15548), natives.npc.load(15548));
  assert.equal(npc.load(15548).name, 'Scurrius');
  assert.equal(obj.load(registry.resolve('christmas-2025', 'obj', 'xmas25_serving_platter')).name, 'Serving platter');
  assert.equal(natives.obj.load(32926).name, 'Null');
  const processed = new PostProcessedObjTypeLoader(obj);
  const placeholder = processed.load(registry.resolve('christmas-2025', 'obj', 'placeholder_xmas25_serving_platter'));
  assert.equal(placeholder.name, 'Serving platter');
  assert.equal(placeholder.placeholder, 32926);
  assert.equal(placeholder.placeholderTemplate, context.counts.obj);
  assert.equal(natives.obj.load(32927).name, 'Null');
  for (const row of raw.definitions.filter(row => row.kind === 'loc')) {
    assert.equal(loc.load(registry.resolve('christmas-2025', 'loc', row.symbol)).name, row.sourceName);
  }
});
test('rejected bundle cannot partially replace the previous registry', () => {
  const registry = new ArchivedDefinitionRegistry(context);
  registry.replace([bundle()]);
  const id = registry.resolve('christmas-2025', 'npc', 'xmas25_stool_empty');
  const previous = registry.getSource('npc', id);
  const bad = bundle();
  bad.definitions.at(-1).crc ^= 1;
  assert.throws(() => registry.replace([bad]), /checksum|CRC/i);
  assert.equal(registry.getSource('npc', id), previous);
  assert.equal(registry.resolve('christmas-2025', 'npc', 'xmas25_stool_empty'), id);
});
test('live IDs, duplicate targets, stale caches, missing morphs and invalid wire IDs are rejected', () => {
  const registry = new ArchivedDefinitionRegistry(context);
  const cases = [
    [b => delete b.id, /bundle/i],
    [b => b.definitions.find(row => row.kind === 'npc').id = 15548, /collision|existing/i],
    [b => b.definitions[1].id = b.definitions[0].id, /duplicate/i],
    [b => b.targetCache.revision--, /cache/i],
    [b => b.definitions = b.definitions.filter(row => row.symbol !== 'xmas25_sir_prysin'), /reference|morph/i],
    [b => b.definitions[0].id = 65536, /id|range/i],
    [b => b.definitions.find(row => row.kind === 'obj').expectedCurrentCrc ^= 1, /current|checksum|CRC/i],
    [b => {
      const row = b.definitions.find(row => row.symbol === 'xmas25_serving_platter');
      row.id = 32928;
      row.expectedCurrentCrc = zlib.crc32(Buffer.from(archives.obj.getFile(row.id).data));
    }, /retired|current/i],
  ];
  for (const [mutate, expected] of cases) {
    const bad = bundle(); mutate(bad);
    assert.throws(() => registry.replace([bad]), expected);
    assert.equal(registry.getCount('npc'), context.counts.npc);
    assert.equal(registry.resolve('christmas-2025', 'npc', 'xmas25_stool_empty'), null);
  }
});
test('changed reference allocations invalidate cached native morphs even when the original bytes stay unchanged', () => {
  const registry = new ArchivedDefinitionRegistry(context);
  registry.replace([bundle()]);
  const npc = view(registry, 'npc', NpcType);
  const id = registry.resolve('christmas-2025', 'npc', 'xmas25_queue_npc_1');
  const before = npc.load(id);
  const changed = bundle();
  const prysin = changed.definitions.find(row => row.symbol === 'xmas25_sir_prysin');
  prysin.id = context.counts.npc + 32;
  registry.replace([changed]);
  const after = npc.load(id);
  assert.notEqual(after, before);
  assert.equal(after.transforms[0], prysin.id);
  assert.equal(after.transform({ getVarbit: () => 0, getVarp: () => 0 }, npc).name, 'Sir Prysin');
});
test('input mutation and world clear cannot leak archived sources into the ordinary cache', () => {
  const registry = new ArchivedDefinitionRegistry(context), input = bundle();
  registry.replace([input]);
  const id = registry.resolve('christmas-2025', 'npc', 'xmas25_stool_empty');
  const npc = view(registry, 'npc', NpcType);
  assert.equal(npc.load(id).name, '<col=00ffff>Stool');
  input.sourceCache.revision = 241;
  input.definitions.find(row => row.symbol === 'xmas25_stool_empty').dataBase64 = 'AA==';
  assert.equal(npc.load(id).name, '<col=00ffff>Stool');
  assert.equal(npc.load(id).cacheInfo.revision, 235);
  registry.replace([]);
  assert.equal(registry.getCount('npc'), context.counts.npc);
  assert.equal(registry.getSource('npc', id), undefined);
  assert.equal(npc.load(id), natives.npc.load(id));
});
test('installed content uses real CacheDefinitions and invalidates only affected hydrated wrappers', t => {
  const { PluginManager: PM } = require('../dist/plugins/PluginManager');
  const { CacheDefinitions: C } = require('../dist/game/cache/CacheDefinitions');
  const { ItemDefinition } = require('../dist/game/definition/ItemDefinition');
  const { NpcDefinition } = require('../dist/game/definition/NpcDefinition');
  const { ObjectDefinition } = require('../dist/game/definition/ObjectDefinition');
  const { Player } = require('../dist/game/entity/impl/player/Player');
  const { PlayerSession } = require('../dist/net/PlayerSession');
  const { World } = require('../dist/game/World');
  registerArchivePlugin();
  ObjectDefinition.init();
  const originalLoc = ObjectDefinition.forId(1276);
  assert.ok(originalLoc);
  const packets = [];
  const channel = { kind: 'test', binaryTransport: true, remoteAddress: '127.0.0.1',
    isOpen: () => true, send: packet => { packets.push(packet); return true; },
    close() {}, onData() {}, onError() {}, onClose() {} };
  const player = new Player(new PlayerSession(channel));
  player.setUsername('archiveworld');
  World.getPlayers().add(player);
  t.after(() => World.getPlayers().remove(player));
  PM.emitPlayerLogin({ player, username: player.getUsername(), isNewAccount: false });
  player.getSession().flushPackets();
  assert.ok(packets.length > 0, 'login sends the ordinary empty registry');
  packets.length = 0;
  const originalNpc = NpcDefinition.forId(15548);
  const originalItem = ItemDefinition.forId(32926);
  assert.equal(originalItem.getName(), 'Null');
  t.after(() => PM.emitCustomEvent('definition-archives:install', { bundles: [] }));
  const request = { bundles: [bundle()] };
  PM.emitCustomEvent('definition-archives:install', request);
  assert.equal(request.handled, true);
  player.getSession().flushPackets();
  assert.ok(packets.length > 0, 'an online player receives a replacement registry without relogging');
  packets.length = 0;
  const stool = C.getArchivedId('christmas-2025', 'npc', 'xmas25_stool_empty');
  assert.equal(C.getCounts().npcs, context.counts.npc + 32);
  assert.equal(NpcDefinition.forId(stool).getName(), '<col=00ffff>Stool');
  assert.equal(ItemDefinition.forId(32926).getName(), 'Serving platter');
  assert.equal(NpcDefinition.forId(15548), originalNpc);
  assert.equal(originalNpc.getName(), 'Scurrius');
  const table = C.getArchivedId('christmas-2025', 'loc', 'xmas25_table01_empty01');
  assert.equal(ObjectDefinition.forId(table)?.getName(), 'Table',
    'the real world-object owner accepts appended definitions after its startup count was cached');
  assert.equal(ObjectDefinition.forId(1276), originalLoc);
  assert.equal(C.getItem(32927).name, 'Serving platter', 'the real placeholder postprocessor follows archived references');
  PM.emitCustomEvent('definition-archives:install', { bundles: [] });
  player.getSession().flushPackets();
  assert.ok(packets.length > 0, 'online players also receive archive removal');
  assert.equal(C.getCounts().npcs, context.counts.npc);
  assert.equal(ItemDefinition.forId(32926).getName(), 'Null');
  assert.equal(ObjectDefinition.forId(table), undefined, 'removed archived world objects leave no cached wrapper');
  assert.notEqual(NpcDefinition.forId(stool).getName(), '<col=00ffff>Stool');
  assert.equal(NpcDefinition.forId(15548), originalNpc);
});

test('live archived world objects retain their definition until normal deregistration clears real collision', t => {
  const { PluginManager: PM } = require('../dist/plugins/PluginManager');
  const { ObjectDefinition } = require('../dist/game/definition/ObjectDefinition');
  const { GameObject } = require('../dist/game/entity/impl/object/GameObject');
  const { ObjectManager } = require('../dist/game/entity/impl/object/ObjectManager');
  const { PrivateArea } = require('../dist/game/model/areas/impl/PrivateArea');
  const { Location } = require('../dist/game/model/Location');
  const { RegionManager } = require('../dist/game/collision/RegionManager');
  registerArchivePlugin();
  ObjectDefinition.init();
  const input = bundle();
  input.definitions = input.definitions.filter(row => row.symbol === 'xmas25_table01_empty01');
  const id = input.definitions[0].id;
  const install = bundles => { const request = { bundles }; PM.emitCustomEvent('definition-archives:install', request); return request; };
  assert.equal(install([input]).handled, true);
  const area = new PrivateArea(), location = new Location(3200, 3200, 0);
  area.setClip(location, 0);
  const object = new GameObject(id, location, 10, 0, area);
  ObjectManager.register(object, true);
  t.after(() => { ObjectManager.deregister(object, true); install([]); });
  const flags = RegionManager.getClipping(3200, 3200, 0, area);
  assert.ok(flags, 'the real registered table materializes collision');
  assert.equal(install([input]).handled, true, 'an identical snapshot remains valid with live objects');
  const removal = install([]);
  assert.equal(removal.handled, false);
  assert.match(removal.error, /despawn/i);
  assert.equal(ObjectDefinition.forId(id).getName(), 'Table');
  const replacement = JSON.parse(JSON.stringify(input));
  const pile = raw.definitions.find(row => row.symbol === 'xmas25_snowball_pile');
  replacement.definitions[0] = { kind: 'loc', symbol: pile.symbol, sourceId: pile.id, id,
    dataBase64: pile.sourceBytes, crc: zlib.crc32(Buffer.from(pile.sourceBytes, 'base64')) };
  assert.equal(install([replacement]).handled, false, 'a changed footprint is also refused while registered');
  assert.equal(RegionManager.getClipping(3200, 3200, 0, area), flags);
  ObjectManager.deregister(object, true);
  assert.equal(RegionManager.getClipping(3200, 3200, 0, area), 0);
  assert.equal(install([replacement]).handled, true);
  assert.equal(ObjectDefinition.forId(id).getName(), 'Snowball pile');
  assert.equal(install([]).handled, true);
  assert.equal(ObjectDefinition.forId(id), undefined);
});
