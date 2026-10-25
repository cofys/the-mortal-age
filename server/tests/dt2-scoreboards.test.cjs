const assert = require('node:assert/strict');
const path = require('node:path');
const {test, before} = require('node:test');
const {Server} = require('../dist/Server');
Server.installProductionPathResolver();
const {CachePipeline} = require('../dist/game/cache/CachePipeline');
const {CacheDefinitions: Cache} = require('../dist/game/cache/CacheDefinitions');
const {VarManager} = require('../dist/game/cache/codec/rs/config/vartype/VarManager');
const Scoreboards = require('../plugins/world/DesertTreasureScoreboards.plugin');
let scoreboardId;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  scoreboardId = Cache.getVarbitId('dt2_scoreboards');
});
function fixture(complete = false, state = 0) {
  const vars = new VarManager({load: id => Cache.getVarbit(id)}), events = new Map(), logins = [], sent = [];
  vars.setVarbit(scoreboardId, state);
  const sender = {getVarbit: id => vars.getVarbit(id), sendVarbit(id,value) {vars.setVarbit(id,value);sent.push([id,value]);return sender;}};
  const player = {getPacketSender: () => sender};
  const api = {core: {CacheDefinitions: Cache}, onPlayerLogin: fn => logins.push(fn),
    onCustomEvent(name,fn) {events.set(name,fn);},
    emitCustomEvent(name,event) {if(name === 'quest:is-complete' && event.key === 'desert_treasure_ii')event.complete=complete;}};
  Scoreboards.register(api);
  return {vars, player, sent, login() {for(const fn of logins)fn({player});},
    finish(key='desert_treasure_ii') {complete=true;events.get('quest:completed')?.({player,key});}};
}
test('completed DT2 login repairs the native scoreboard without clobbering adjacent varp bits', () => {
  const f=fixture(true), def=Cache.getVarbit(scoreboardId);
  f.vars.setVarp(def.baseVar, 0x40000125);
  f.login();
  assert.equal(f.vars.getVarbit(scoreboardId),1);
  assert.equal(f.vars.getVarp(def.baseVar),0x40010125);
  assert.deepEqual(f.sent,[[scoreboardId,1]]);
});
test('quest completion repairs the boards immediately, while an unrelated quest does not', () => {
  const f=fixture();f.login();assert.equal(f.sent.length,0);
  f.finish('cooks_assistant');assert.equal(f.sent.length,0);
  f.finish();assert.equal(f.vars.getVarbit(scoreboardId),1);
});
test('normal and awakened scoreboard access are not downgraded or repeatedly resent', () => {
  for(const state of [1,2]){const f=fixture(true,state);f.login();f.finish();assert.equal(f.vars.getVarbit(scoreboardId),state);assert.deepEqual(f.sent,[]);}
});
test('the cache-backed Leviathan pillar resolves to Read after the shared quest unlock', () => {
  const f=fixture(true), parent=Cache.getObject(Cache.getLocId('leviathan_scoreboard'));
  const loader={load:id=>Cache.getObject(id)};
  assert.equal(parent.transform(f.vars,loader).id,47587);
  f.login();
  const board=parent.transform(f.vars,loader);
  assert.equal(board.id,47588);assert.ok(board.actions.includes('Read'));
});
test('the shared unlock exposes all four bosses, including both Whisperer realm models', () => {
  const f=fixture(true),loader={load:id=>Cache.getObject(id)};
  f.login();
  for(const [name,id] of [['duke_sucellus_scoreboard',47563],['leviathan_scoreboard',47588],
    ['whisperer_scoreboard',47582],['whisperer_scoreboard_shadow',47580],['vardorvis_scoreboard',47597]]){
    const parent=Cache.getObject(Cache.getLocId(name));
    assert.equal(parent.transformVarbit,scoreboardId,name);
    const model=parent.transform(f.vars,loader);
    assert.equal(model.id,id,name);assert.ok(model.actions.includes('Read'),name);
  }
});
