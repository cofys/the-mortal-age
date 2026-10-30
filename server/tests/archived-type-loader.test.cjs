const assert = require('node:assert/strict');
const path = require('node:path');
const { before, test } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { ArchivedTypeLoader } = require('../dist/game/cache/codec/rs/config/ArchivedTypeLoader');
const { ArchiveNpcTypeLoader } = require('../dist/game/cache/codec/rs/config/npctype/NpcTypeLoader');
const { ArchiveObjTypeLoader } = require('../dist/game/cache/codec/rs/config/objtype/ObjTypeLoader');
const { NpcType } = require('../dist/game/cache/codec/rs/config/npctype/NpcType');
const { ObjType } = require('../dist/game/cache/codec/rs/config/objtype/ObjType');
const { CacheIndexDat2 } = require('../dist/game/cache/codec/rs/cache/CacheIndex');
const { ConfigType } = require('../dist/game/cache/codec/rs/cache/ConfigType');
const fixture = require('./fixtures/archived-cache-definitions.json');
const oldInfo = { name: 'osrs-235_2025-12-17', game: 'oldschool', environment: 'live', revision: 235,
  timestamp: '2025-12-17T11:45:07Z', size: 0 };
let npcBase, objBase;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  const cache = CachePipeline.getActive();
  const info = { ...oldInfo, name: cache.name, revision: cache.revision, timestamp: cache.timestamp };
  const configs = CacheIndexDat2.fromStore(2, CachePipeline.getStore());
  npcBase = new ArchiveNpcTypeLoader(info, configs.getArchive(ConfigType.DAT2.npcs));
  objBase = new ArchiveObjTypeLoader(info, configs.getArchive(ConfigType.DAT2.objs));
});
function source(symbol) {
  const row = fixture.definitions.find(row => row.symbol === symbol);
  assert.ok(row);
  return { cacheInfo: oldInfo, dataBase64: row.sourceBytes };
}
test('native archived platter keeps its actual name/actions without mutating the active cache', () => {
  const platter = fixture.definitions.find(row => row.symbol === 'xmas25_serving_platter');
  const original = objBase.load(platter.id);
  assert.equal(original.name, 'Null');
  const records = new Map([[platter.id, source(platter.symbol)]]);
  const loader = new ArchivedTypeLoader(objBase, ObjType, id => records.get(id), () => objBase.getCount());
  const restored = loader.load(platter.id);
  assert.equal(restored.name, 'Serving platter');
  assert.deepEqual(restored.inventoryActions, ['Inspect', null, null, null, 'Destroy']);
  assert.equal(restored.id, platter.id);
  assert.equal(restored.cacheInfo.revision, 235);
  assert.equal(objBase.load(platter.id), original);
  assert.equal(original.name, 'Null');
});
test('append an archived stool type while the reused live ID remains Scurrius', () => {
  const stool = fixture.definitions.find(row => row.symbol === 'xmas25_stool_empty');
  const target = npcBase.getCount();
  const loader = new ArchivedTypeLoader(npcBase, NpcType,
    id => id === target ? source(stool.symbol) : undefined, () => target + 1);
  const restored = loader.load(target);
  assert.equal(restored.id, target);
  assert.equal(restored.name, '<col=00ffff>Stool');
  assert.deepEqual(Array.from(restored.actions, action => action ?? null), [null, null, null, null, null]);
  assert.deepEqual(restored.modelIds, stool.sourceModels);
  assert.equal(loader.getCount(), target + 1);
  assert.equal(loader.load(stool.id), npcBase.load(stool.id));
  assert.equal(loader.load(stool.id).name, 'Scurrius');
});
test('descriptor replacement, removal and cache clearing use the current source owner', () => {
  const target = npcBase.getCount();
  let current = source('xmas25_stool_empty');
  const loader = new ArchivedTypeLoader(npcBase, NpcType, id => id === target ? current : undefined, () => target + 1);
  const first = loader.load(target);
  assert.equal(loader.load(target), first);
  current = source('xmas25_sir_prysin');
  assert.equal(loader.load(target).name, 'Sir Prysin');
  current = undefined;
  assert.equal(loader.load(target), npcBase.load(target));
  current = source('xmas25_stool_empty');
  loader.clearCache();
  assert.notEqual(loader.load(target), first);
  assert.equal(loader.load(target).name, '<col=00ffff>Stool');
});
test('complete archived records reject truncated or trailing bytes and recover after replacement', () => {
  const target = npcBase.getCount();
  const valid = source('xmas25_stool_empty');
  const bytes = Buffer.from(valid.dataBase64, 'base64');
  let current = { ...valid, dataBase64: bytes.subarray(0, -1).toString('base64') };
  const loader = new ArchivedTypeLoader(npcBase, NpcType, () => current, () => target + 1);
  assert.throws(() => loader.load(target), /terminator|truncated|overflow/i);
  current = { ...valid, dataBase64: Buffer.concat([bytes, Buffer.from([0])]).toString('base64') };
  assert.throws(() => loader.load(target), /trailing/i);
  current = valid;
  assert.equal(loader.load(target).name, '<col=00ffff>Stool');
});
test('changing source revision cannot mutate or reuse an already decoded definition', () => {
  const target = npcBase.getCount();
  const info = { ...oldInfo };
  const current = { ...source('xmas25_stool_empty'), cacheInfo: info };
  const loader = new ArchivedTypeLoader(npcBase, NpcType, () => current, () => target + 1);
  const first = loader.load(target);
  info.revision = 241;
  const second = loader.load(target);
  assert.notEqual(first, second);
  assert.equal(first.cacheInfo.revision, 235);
  assert.equal(second.cacheInfo.revision, 241);
  assert.equal(second.name, '<col=00ffff>Stool');
});
