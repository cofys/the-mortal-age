const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const {before, test} = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const {CachePipeline} = require('../dist/game/cache/CachePipeline');
const {CacheIndexDat2} = require('../dist/game/cache/codec/rs/cache/CacheIndex');
const {ArchiveNpcTypeLoader} = require('../dist/game/cache/codec/rs/config/npctype/NpcTypeLoader');
const {ArchiveLocTypeLoader} = require('../dist/game/cache/codec/rs/config/loctype/LocTypeLoader');
const {ArchiveObjTypeLoader} = require('../dist/game/cache/codec/rs/config/objtype/ObjTypeLoader');
const {ArchivedDefinitionRegistry} = require('../dist/game/cache/codec/rs/config/ArchivedDefinitionRegistry');
const {createBundle, parseSymbols, verifyFile, christmasRoots} = require('../scripts/import-seasonal-definitions.cjs');
const raw = require('./fixtures/archived-seasonal-bundle.json');
let context;
const sourceCache = {name:'osrs-235_2025-12-17',game:'oldschool',environment:'live',revision:235,timestamp:'2025-12-17T11:45:07Z',size:0};
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname,'..'));
  const cache = CachePipeline.getActive(), cacheInfo={...sourceCache,name:cache.name,revision:cache.revision,timestamp:cache.timestamp};
  const configs=CacheIndexDat2.fromStore(2,CachePipeline.getStore());
  const archives={npc:configs.getArchive(9),loc:configs.getArchive(6),obj:configs.getArchive(10)};
  const natives={npc:new ArchiveNpcTypeLoader(cacheInfo,archives.npc),loc:new ArchiveLocTypeLoader(cacheInfo,archives.loc),obj:new ArchiveObjTypeLoader(cacheInfo,archives.obj)};
  context={cacheInfo,counts:Object.fromEntries(Object.entries(natives).map(([k,v])=>[k,v.getCount()])),currentDefinition:(kind,id)=>({name:natives[kind].load(id).name,data:archives[kind].getFile(id)?.data})};
});
function options() {
  const rows=new Map(raw.definitions.map(r=>[`${r.kind}:${r.id}`,r]));
  return {id:'christmas-2025',sourceCache,context,
    roots:raw.definitions.filter(r=>r.symbol!=='template_for_placeholder').map(r=>({kind:r.kind,id:r.id})),
    readDefinition:(kind,id)=>{const row=rows.get(`${kind}:${id}`);return row&&Buffer.from(row.sourceBytes,'base64');},
    symbolFor:(kind,id)=>rows.get(`${kind}:${id}`)?.symbol,
    restoreItems:[32926,32927]};
}
test('production import closes original native references, preserves current NPCs and is deterministic',()=>{
  const first=createBundle(options());
  assert.equal(first.definitions.length,75);
  assert.deepEqual(createBundle({...options(),roots:options().roots.reverse()}),first);
  const registry=new ArchivedDefinitionRegistry(context); registry.replace([first]);
  assert.equal(context.currentDefinition('npc',15548).name,'Scurrius');
  assert.equal(registry.resolve('christmas-2025','obj','xmas25_serving_platter'),32926);
  assert.equal(registry.resolve('christmas-2025','obj','template_for_placeholder'),context.counts.obj);
  assert.equal(registry.getCount('npc'),context.counts.npc+32);
  assert.equal(registry.getCount('loc'),context.counts.loc+40);
});
test('missing source reference cannot silently become a current unrelated type',()=>{
  const opts=options(),read=opts.readDefinition;
  opts.readDefinition=(kind,id)=>kind==='obj'&&id===14401?undefined:read(kind,id);
  assert.throws(()=>createBundle(opts),/missing.*obj.*14401/i);
});
test('rejects incompatible current replacements and out-of-wire allocation before returning a bundle',()=>{
  const opts=options();opts.restoreItems=[14401];
  assert.throws(()=>createBundle(opts),/current|retired|checksum/i);
  const overflow=options();overflow.context={...context,counts:{...context.counts,npc:65534}};
  assert.throws(()=>createBundle(overflow),/wire|range|id/i);
});
test('symbol parser rejects duplicate IDs and symbols instead of guessing an identity',()=>{
  assert.deepEqual([...parseSymbols('// 12\n[xmas25_a]\nname=A\n// 13\n[xmas25_b]\n')],[[12,'xmas25_a'],[13,'xmas25_b']]);
  assert.throws(()=>parseSymbols('// 12\n[xmas25_a]\n// 12\n[xmas25_b]\n'),/duplicate/i);
  assert.throws(()=>parseSymbols('// 12\n[xmas25_a]\n// 13\n[xmas25_a]\n'),/duplicate/i);
});
test('source provenance verifies actual bytes before decoding',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'holiday-import-'));
  try {
    const file=path.join(dir,'group.dat'),data=Buffer.from([0,1,2,3]);fs.writeFileSync(file,data);
    const expected={bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')};
    assert.deepEqual(verifyFile(file,expected),data);
    fs.writeFileSync(file,Buffer.from([3,2,1,0]));
    assert.throws(()=>verifyFile(file,expected),/hash|checksum/i);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('Christmas extraction archives retired gameplay items and retains live reward definitions',()=>{
  const symbols={npc:new Map([[14814,'xmas25_queue_npc_1']]),loc:new Map([[60608,'xmas25_crate01_carrot01'],
    [46501,'xmas22_pub01_rugmiddle01'],[46502,'xmas22_pub01_rugcorner01'],[46503,'xmas22_pub01_rugside01'],[46504,'xmas22_canopy01_small01']]),
    obj:new Map([[32926,'xmas25_serving_platter'],[32927,'placeholder_xmas25_serving_platter'],[32928,'xmas25_bib'],[32930,'xmas25_beer_belly_sweater'],[32932,'xmas25_contest_jumper'],[32934,'xmas25_christmas_dinner']])};
  assert.deepEqual(christmasRoots(symbols).filter(r=>r.kind==='obj').map(r=>r.id),[32926,32927]);
  assert.deepEqual(christmasRoots(symbols).filter(r=>r.kind==='loc').map(r=>r.id),[60608,46501,46502,46503],
    'the original 2025 pub map reuses these 2022 rug types; unrelated older Christmas scenery is not implied');
});
