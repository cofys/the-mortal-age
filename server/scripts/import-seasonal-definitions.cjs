#!/usr/bin/env node
// Extract native Christmas 2025 definitions from a separately retained Jagex
// cache2392 reference. Never reads test fixtures or writes the active cache.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const server = path.resolve(__dirname, '..');
require('../dist/Server').Server.installProductionPathResolver();
const codec = '../dist/game/cache/codec/rs/';
const {ArchivedDefinitionRegistry} = require(codec+'config/ArchivedDefinitionRegistry');
const {decodeArchivedType} = require(codec+'config/ArchivedTypeLoader');
const {NpcType} = require(codec+'config/npctype/NpcType');
const {LocType} = require(codec+'config/loctype/LocType');
const {ObjType} = require(codec+'config/objtype/ObjType');
const kinds = ['npc','loc','obj'];
const constructors = {npc:NpcType,loc:LocType,obj:ObjType};
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function parseSymbols(text) {
  const ids = new Map(), names = new Set();
  for (const match of text.matchAll(/^\/\/ (\d+)\s*\r?\n\[([a-zA-Z_][a-zA-Z0-9_]*)\]/gm)) {
    const id = Number(match[1]), symbol = match[2];
    if (ids.has(id) || names.has(symbol)) throw new Error('Duplicate source symbol/id: '+symbol);
    ids.set(id,symbol); names.add(symbol);
  }
  if (!ids.size) throw new Error('No source symbols found');
  return ids;
}
function verifyFile(file, expected) {
  const bytes = fs.readFileSync(file);
  if (bytes.length !== expected.bytes && bytes.length !== expected.size) throw new Error('Source byte length mismatch: '+path.basename(file));
  if (digest(bytes).toLowerCase() !== expected.sha256.toLowerCase()) throw new Error('Source hash checksum mismatch: '+path.basename(file));
  return bytes;
}
function references(kind,type) {
  if (kind !== 'obj') return (type.transforms || []).filter(id=>id>=0);
  return ['note','noteTemplate','notedId','unnotedId','placeholder','placeholderTemplate']
    .map(field=>type[field]).filter(id=>id>=0)
    .concat((type.countObj || []).filter((id,index)=>type.countCo?.[index]>0));
}
function christmasRoots(symbols) {
  // Cosmetics remain live native items. Only the temporary serving tool was
  // retired; replacing still-live reward/template definitions would be wrong.
  return kinds.flatMap(kind=>[...symbols[kind]].filter(([,name])=>kind==='obj'
    ? name==='xmas25_serving_platter'||name==='placeholder_xmas25_serving_platter'
    : name.startsWith('xmas25_')||(kind==='loc'&&/^xmas22_pub01_rug(?:middle|corner|side)01$/.test(name))).map(([id])=>({kind,id})));
}
function createBundle({id,sourceCache,context,roots,readDefinition,symbolFor,restoreItems=[]}) {
  const restore = new Set(restoreItems);
  for (const item of restore) {
    if (!roots.some(row=>row.kind==='obj'&&row.id===item)) throw new Error('Invalid retired current replacement target: '+item);
  }
  const selected = new Map(), queue = [...roots];
  for (let index=0;index<queue.length;index++) {
    const row=queue[index],key=row.kind+':'+row.id;
    if (selected.has(key)) continue;
    if (!kinds.includes(row.kind)) throw new Error('Unknown archived kind');
    const bytes=readDefinition(row.kind,row.id);
    if (!bytes) throw new Error('Missing source definition '+key);
    const dataBase64=Buffer.from(bytes).toString('base64');
    const type=decodeArchivedType(constructors[row.kind],row.id,{cacheInfo:sourceCache,dataBase64});
    const symbol=symbolFor(row.kind,row.id);
    if (!symbol) throw new Error('Missing original symbolic identity '+key);
    selected.set(key,{kind:row.kind,sourceId:row.id,symbol,dataBase64,crc:zlib.crc32(bytes)});
    for (const dependency of references(row.kind,type)) queue.push({kind:row.kind,id:dependency});
  }
  const next={...context.counts};
  const definitions=[...selected.values()].sort((a,b)=>kinds.indexOf(a.kind)-kinds.indexOf(b.kind)||a.sourceId-b.sourceId)
    .map(row=>{
      const replacing=row.kind==='obj'&&restore.has(row.sourceId);
      if (replacing) {
        const current=context.currentDefinition(row.kind,row.sourceId);
        if (current.name.toLowerCase()!=='null'||!current.data) throw new Error('Current item is not a retired definition: '+row.sourceId);
        return {...row,id:row.sourceId,expectedCurrentCrc:zlib.crc32(current.data)};
      }
      return {...row,id:next[row.kind]++};
    });
  const bundle={id,targetCache:{name:context.cacheInfo.name,game:context.cacheInfo.game,revision:context.cacheInfo.revision},sourceCache,definitions};
  new ArchivedDefinitionRegistry(context).replace([bundle]);
  return bundle;
}

async function extractChristmas(reference) {
  const {CachePipeline}=require('../dist/game/cache/CachePipeline');
  const {ByteBuffer}=require(codec+'io/ByteBuffer');
  const {Container}=require(codec+'cache/Container');
  const {ReferenceTable}=require(codec+'cache/ref/ReferenceTable');
  const {Archive}=require(codec+'cache/Archive');
  const {CacheIndexDat2}=require(codec+'cache/CacheIndex');
  const {ArchiveNpcTypeLoader}=require(codec+'config/npctype/NpcTypeLoader');
  const {ArchiveLocTypeLoader}=require(codec+'config/loctype/LocTypeLoader');
  const {ArchiveObjTypeLoader}=require(codec+'config/objtype/ObjTypeLoader');
  const {VarBitType}=require(codec+'config/vartype/bit/VarBitType');
  const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
  const source=readJson(path.join(reference,'SOURCE.json'));
  const groups=readJson(path.join(reference,'archives/SOURCE.json'));
  const maps=readJson(path.join(reference,'archives/SOURCE.maps.json'));
  const seq=readJson(path.join(reference,'archives/SOURCE.sequences.json'));
  assert.equal(source.commit,'6f75a611629a4fd7d294650f3842b0358172d7f2');
  for (const manifest of [source,groups,seq]) assert.equal(manifest.revision,235);
  for (const manifest of [groups,maps,seq]) assert.equal(manifest.cache,2392);
  const verified = new Map();
  for (const manifest of [groups,maps,seq]) for (const row of manifest.files) {
    const file=path.join(reference,'archives',row.file);
    if (path.dirname(path.resolve(file))!==path.resolve(reference,'archives')) throw new Error('Invalid source filename');
    const bytes=verifyFile(file,row);
    if (verified.has(row.file)&&!verified.get(row.file).equals(bytes)) throw new Error('Conflicting source bytes');
    verified.set(row.file,bytes);
  }
  const symbols={};
  for (const kind of [...kinds,'varbit']) {
    const name='dump.'+kind,row=source.files.find(row=>row.name===name);
    assert.ok(row,'Missing source symbols '+kind);
    symbols[kind]=parseSymbols(verifyFile(path.join(reference,name),row).toString('utf8'));
  }
  const raw=name=>{const data=verified.get(name);if(!data)throw new Error('Missing verified archive '+name);return new Int8Array(data);};
  const container=(name,key)=>Container.decode(new ByteBuffer(raw(name)),key);
  // Pinned public reference-table CRC binds the child CRCs used below.
  assert.equal(zlib.crc32(raw('255-2.dat')),601061141);
  const configTable=ReferenceTable.decode(new ByteBuffer(container('255-2.dat').data));
  const archive=group=>{
    const ref=configTable.getArchiveReference(group),name=`2-${group}.dat`;
    assert.equal(zlib.crc32(raw(name)),ref.crc>>>0,'Source config CRC '+group);
    return Archive.decode(group,ref.lastFileId,ref.fileCount,ref.fileIds,ref.fileNameHashes,new ByteBuffer(container(name).data));
  };
  const original={npc:archive(9),loc:archive(6),obj:archive(10)};
  await CachePipeline.initialize(server);
  const active=CachePipeline.getActive();
  const cacheInfo={name:active.name,game:'oldschool',environment:'live',revision:active.revision,timestamp:active.timestamp,size:0};
  const configs=CacheIndexDat2.fromStore(2,CachePipeline.getStore());
  const natives={npc:new ArchiveNpcTypeLoader(cacheInfo,configs.getArchive(9)),loc:new ArchiveLocTypeLoader(cacheInfo,configs.getArchive(6)),obj:new ArchiveObjTypeLoader(cacheInfo,configs.getArchive(10))};
  const context={cacheInfo,counts:Object.fromEntries(kinds.map(kind=>[kind,natives[kind].getCount()])),currentDefinition:(kind,id)=>({name:natives[kind].load(id).name,data:natives[kind].archive.getFile(id)?.data})};
  const roots=christmasRoots(symbols);
  const sourceCache={...cacheInfo,name:'osrs-235_2025-12-17',revision:235,timestamp:'2025-12-17T11:45:07Z'};
  const bundle=createBundle({id:'christmas-2025',sourceCache,context,roots,readDefinition:(kind,id)=>original[kind].getFile(id)?.data,symbolFor:(kind,id)=>symbols[kind].get(id),restoreItems:roots.filter(r=>r.kind==='obj').map(r=>r.id)});
  const varbits=[],oldBits=archive(14),oldSeq=archive(12),sequences=new Set(),modelIds=new Set();
  for (const row of bundle.definitions) {
    const type=decodeArchivedType(constructors[row.kind],row.sourceId,{cacheInfo:sourceCache,dataBase64:row.dataBase64});
    for (const [field,id] of Object.entries(type)) if ((field==='seqId'||field.endsWith('SeqId'))&&Number.isInteger(id)&&id>=0) sequences.add(id);
    for (const id of [type.modelIds??type.models??type.model??[],type.chatheadModelIds??[]].flat(Infinity)) if(Number.isInteger(id)&&id>=0)modelIds.add(id);
  }
  for (const [id,symbol] of symbols.varbit) if (/^xmas_?25_/.test(symbol)) {
    const before=new VarBitType(id,sourceCache),after=new VarBitType(id,cacheInfo);
    before.decode(oldBits.getFile(id).getDataAsBuffer());after.decode(configs.getFile(14,id).getDataAsBuffer());
    const layout=type=>[type.baseVar,type.startBit,type.endBit];
    assert.deepEqual(layout(after),layout(before),'Gameplay varbit layout '+symbol);
    varbits.push({symbol,id,baseVar:before.baseVar,startBit:before.startBit,endBit:before.endBit});
  }
  const sequenceChecks=[...sequences].sort((a,b)=>a-b).map(id=>{
    const before=oldSeq.getFile(id)?.data,after=configs.getFile(12,id)?.data;
    assert.ok(before&&after,'Missing sequence '+id);
    assert.deepEqual(Buffer.from(after),Buffer.from(before),'Changed animation definition '+id);
    return {id,sha256:digest(before)};
  });
  assert.equal(zlib.crc32(raw('255-7.dat')),(-1308188626)>>>0,'Source model reference CRC');
  const oldModels=ReferenceTable.decode(new ByteBuffer(container('255-7.dat').data));
  const currentModels=CacheIndexDat2.fromStore(7,CachePipeline.getStore());
  const modelChecks=[...modelIds].sort((a,b)=>a-b).map(id=>{
    const before=oldModels.getArchiveReference(id),after=currentModels.getArchiveReference(id);
    assert.ok(before&&after,'Missing native model '+id);
    const result={id,sourceCrc:before.crc>>>0,currentCrc:after.crc>>>0};
    if(result.sourceCrc!==result.currentCrc) {
      const name=`7-${id}.dat`;assert.equal(zlib.crc32(raw(name)),result.sourceCrc,'Source model CRC '+id);
      result.sourceSha256=digest(container(name).data);
      result.currentSha256=digest(currentModels.getArchive(id).getFile(0).data);
    }
    return result;
  });
  const mapTable=ReferenceTable.decode(new ByteBuffer(container('255-5.dat').data));
  const keys=JSON.parse(Buffer.from(raw('keys.json')).toString('utf8'));
  const locs=new Map(bundle.definitions.filter(r=>r.kind==='loc').map(r=>[r.sourceId,r]));
  const placements=[];
  for (const name of ['l50_53','l50_153']) {
    const key=keys.find(row=>row.name===name);assert.ok(key,'Missing original map '+name);
    const file=`5-${key.group}.dat`,ref=mapTable.getArchiveReference(key.group);
    assert.equal(zlib.crc32(raw(file)),ref.crc>>>0,'Original map CRC '+name);
    const buffer=new ByteBuffer(container(file,key.key).data);let id=-1,delta;
    while ((delta=buffer.readSmart3())!==0) {
      id+=delta;let position=0,change;
      while ((change=buffer.readUnsignedSmart())!==0) {
        position+=change-1;const flags=buffer.readUnsignedByte(),row=locs.get(id);
        if (row) placements.push({symbol:row.symbol,sourceId:id,x:(key.mapsquare>>8)*64+((position>>6)&63),y:(key.mapsquare&255)*64+(position&63),z:position>>12,shape:flags>>2,rotation:flags&3});
      }
    }
    assert.equal(buffer.remaining,0,'Trailing original map bytes');
  }
  // The 2025 map reuses the 2022 pub rug; an xmas25-only name filter misses
  // its red floor decorations and leaves the ordinary blue carpet visible.
  assert.equal(placements.filter(row=>row.symbol.startsWith('xmas25_')).length,24,'Original event scene placement count');
  const rugs=placements.filter(row=>row.symbol.startsWith('xmas22_pub01_rug'));
  assert.equal(rugs.filter(row=>row.z===0).length,54,'Original ground-floor pub rug placement count');
  assert.equal(rugs.filter(row=>row.z===1).length,47,'Original upstairs pub rug placement count');
  assert.equal(rugs.length,101,'Original reused pub rug placement count');
  return {source:{url:source.openrs2,revision:235,symbolCommit:source.commit,symbolFiles:source.files,files:[...verified].map(([file,bytes])=>({file,bytes:bytes.length,sha256:digest(bytes)}))},bundle,placements,varbits,sequences:sequenceChecks,models:modelChecks};
}
async function main(args) {
  let reference,output,check=false;
  for(let index=0;index<args.length;index++) {
    if(args[index]==='--reference')reference=args[++index];
    else if(args[index]==='--output')output=args[++index];
    else if(args[index]==='--check')check=true;
    else throw new Error('Unknown argument '+args[index]);
  }
  if(!reference||!output)throw new Error('Usage: node scripts/import-seasonal-definitions.cjs --reference <historical reference directory> --output <file> [--check]');
  const result=await extractChristmas(path.resolve(reference)),bytes=JSON.stringify(result,null,2)+'\n';
  const target=path.resolve(output);
  if(check)assert.equal(fs.readFileSync(target,'utf8'),bytes,'Generated archive differs');
  else {const temporary=target+'.'+process.pid+'.tmp';try {fs.writeFileSync(temporary,bytes);fs.renameSync(temporary,target);} finally {if(fs.existsSync(temporary))fs.unlinkSync(temporary);}}
  console.log(JSON.stringify({definitions:result.bundle.definitions.length,placements:result.placements.length,varbits:result.varbits.length,sequences:result.sequences.length,sha256:digest(bytes),checked:check}));
}
module.exports={createBundle,parseSymbols,verifyFile,extractChristmas,christmasRoots};
if(require.main===module)main(process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
