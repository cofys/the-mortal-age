// Run after `yarn build`: node --test tests/core-disconnect-guards.test.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { MobileList } = require('../dist/game/entity/impl/MobileList');
const { PlayerSession } = require('../dist/net/PlayerSession');
const { NetworkConstants } = require('../dist/net/NetworkConstants');
const { GameConstants } = require('../dist/game/GameConstants');
const { World } = require('../dist/game/World');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { decodeClientPackets } = require('../dist/net/protocol/ClientProtocol');
const { Location } = require('../dist/game/model/Location');
const net = require('../dist/net/NetworkBuilder');
const { WebSocketBinaryChannel } = require('../dist/net/BinaryChannel');

const REVISION = 435;

test('only a loopback WebSocket proxy can supply a validated player IP', () => {
  const channel = (address, realIp) => new WebSocketBinaryChannel({}, {
    socket: { remoteAddress: address }, headers: { 'x-real-ip': realIp },
  });
  assert.equal(channel('127.0.0.1', '203.0.113.4').remoteAddress, '203.0.113.4');
  assert.equal(channel('::ffff:127.0.0.1', '2001:db8::1').remoteAddress, '2001:db8::1');
  assert.equal(channel('203.0.113.5', '203.0.113.4').remoteAddress, '203.0.113.5');
  assert.equal(channel('127.0.0.1', 'invalid').remoteAddress, '127.0.0.1');
  assert.equal(channel('127.0.0.1', ['203.0.113.4']).remoteAddress, '127.0.0.1');
});

function stubMobile(overrides = {}) {
  return {
    registered: false,
    index: -1,
    isRegistered() { return this.registered; },
    setRegistered(value) { this.registered = value; },
    getIndex() { return this.index; },
    setIndex(value) { this.index = value; },
    onAdd() {},
    onRemove() {},
    ...overrides,
  };
}

function stubChannel() {
  return {
    kind: 'test',
    remoteAddress: '127.0.0.1',
    data: null,
    closeCb: null,
    isOpen: () => true,
    send() { return true; },
    close() {},
    onData(callback) { this.data = callback; },
    onError() {},
    onClose(callback) { this.closeCb = callback; },
  };
}

function stubPersistence(overrides = {}) {
  return {
    load: () => null,
    exists: () => false,
    save: () => {},
    flush: async () => {},
    checkPassword: async () => true,
    encryptPassword: async () => 'hash',
    ...overrides,
  };
}

test('interaction stop cancels queued walking without routing back to an old tile', async () => {
  const connection = new net.ClientConnection(stubChannel());
  const stopped = [];
  connection.player = {
    getAttribute: () => undefined,
    getMovementQueue: () => ({
      reset: () => stopped.push('route'),
      walkToReset: () => stopped.push('walk-task'),
    }),
    getCombat: () => ({ reset() {} }),
    setFollowing() {},
    setMobileInteraction() {},
    setPositionToFace() {},
  };
  connection.inject([{ type: 'interaction_stop' }]);
  await connection.idle();
  assert.deepEqual(stopped, ['route', 'walk-task']);
});

test('a throwing removal hook cannot corrupt list size or leak its slot', () => {
  const list = new MobileList(4);
  const doomed = stubMobile({ onRemove() { throw new Error('save failed'); } });
  assert.equal(list.add(doomed), true);
  assert.equal(list.sizeReturn(), 1);

  assert.throws(() => list.remove(doomed), /save failed/);
  assert.equal(list.sizeReturn(), 0, 'size still decremented after the hook threw');

  const next = stubMobile();
  assert.equal(list.add(next), true);
  assert.equal(next.getIndex(), 1, 'the freed slot is reused');
});

test('a critically backpressured socket is closed instead of buffering', () => {
  let closed = null;
  const channel = {
    isOpen: () => true,
    bufferedAmount: NetworkConstants.OUTBOUND_WS_BUFFER_CRITICAL_BYTES,
    send() { throw new Error('must not send on a backpressured socket'); },
    close(code, reason) { closed = { code, reason }; },
  };
  const session = new PlayerSession(channel);
  assert.equal(session.sendClientPacket(Buffer.from([1, 2, 3])), false);
  assert.deepEqual(closed, { code: 1013, reason: 'backpressure' });
});

test('synchronous packets coalesce into a single browser frame', async () => {
  const frames = [];
  const channel = {
    isOpen: () => true,
    bufferedAmount: 0,
    send(frame) { frames.push(frame); return true; },
    close() {},
  };
  const session = new PlayerSession(channel);
  assert.equal(session.sendClientPacket(Buffer.from([1])), true);
  assert.equal(session.sendClientPacket(Buffer.from([2])), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(frames.length, 1, 'both packets share one frame');
  assert.deepEqual([...frames[0]], [1, 2]);
});

test('an accepted logout first sets clicks back to walking, then logs out', () => {
  const frames = [];
  const channel = {
    isOpen: () => true,
    bufferedAmount: 0,
    send(frame) { frames.push(frame); return true; },
    close() {},
  };
  new PlayerSession(channel).logout();
  const bytes = [...Buffer.concat(frames)];
  // SET_INTERACTION_MODE (145): default world (-2), walk, all entities (rsprox: before every
  // logout_withreason), then LOGOUT_RESPONSE (4).
  assert.deepEqual(bytes.slice(0, 5), [145, 0xff, 0xfe, 1, 1]);
  assert.equal(bytes[5], 4);
});

test('malformed client frames are rejected at the boundary without a throw downstream', async () => {
  assert.throws(() => decodeClientPackets(Buffer.from([0])), /Unsupported client opcode 0/);
  assert.throws(() => decodeClientPackets(Buffer.from([255])), /Truncated client opcode 255/);
  assert.throws(() => decodeClientPackets(Buffer.from([16])), /Truncated client opcode 16/);

  const channel = stubChannel();
  const connection = new net.ClientConnection(channel);
  channel.data(Buffer.from([0]));
  channel.data(Buffer.from([255, 0, 8]));
  await connection.idle();
  assert.equal(connection.getPlayer(), undefined, 'no session was desynced by the bad frames');
});

function stubNpc(index, overrides = {}) {
  return {
    getIndex: () => index,
    isRegistered: () => true,
    isVisible: () => true,
    isNeedsPlacement: () => false,
    getLocation: () => new Location(3201, 3200, 0),
    getPrivateArea: () => null,
    getArea: () => undefined,
    ...overrides,
  };
}

test('NPC visibility honours the cap, private areas and owner-only actors', () => {
  const makePlayer = (localNpcs) => ({
    getIndex: () => 1,
    getLocation: () => new Location(3200, 3200, 0),
    getPrivateArea: () => null,
    getArea: () => undefined,
    getLocalNpcs: () => localNpcs,
    getAttribute: () => undefined,
  });

  const crowdView = [];
  World.updateLocalNpcs(makePlayer(crowdView), Array.from({ length: 300 }, (_, index) => stubNpc(index + 10)));
  assert.equal(crowdView.length, 255, 'the list never exceeds MAX_LOCAL_NPCS');

  const otherArea = { countsAsMainWorld: () => false };
  const outsider = stubNpc(400, { getPrivateArea: () => otherArea });
  const foreignOwner = stubNpc(401, { isOwnerOnly: () => true, getOwner: () => ({}) });
  const filteredView = [];
  const owner = makePlayer(filteredView);
  const ownedPet = stubNpc(402, { isOwnerOnly: () => true, getOwner: () => owner });
  World.updateLocalNpcs(owner, [outsider, foreignOwner, ownedPet]);
  assert.deepEqual(filteredView.map((npc) => npc.getIndex()), [402],
    'only same-area, player-owned actors are added');
});

test('player visibility adds at most MAX_NEW_LOCAL_PLAYERS_PER_CYCLE per tick', () => {
  const candidate = (index) => ({
    getIndex: () => index,
    getLocation: () => new Location(3200, 3200, 0),
    getPrivateArea: () => null,
    getArea: () => undefined,
    isNeedsPlacement: () => false,
    resizeViewDistance() {},
    getViewDistance: () => 16,
  });
  const registered = Array.from({ length: 300 }, (_, index) => candidate(index + 1000));
  World.playerUpdateBuckets.set('0:400:400', registered);

  const localPlayers = [];
  World.updateLocalPlayers({ ...candidate(99), getLocalPlayers: () => localPlayers });
  assert.equal(localPlayers.length, 25, 'one tick adds at most the new-player budget');

  World.playerUpdateBuckets.clear();
});

test('a throwing player removal cannot abort the world remove phase', () => {
  const player = stubMobile({
    getUsername: () => 'edgeboom',
    readyToLeaveWorld: () => true,
    getDisconnectSource: () => 'socket_close',
    isPlayerBot: () => false,
    onRemove() { throw new Error('save failed'); },
  });
  assert.equal(World.getPlayers().add(player), true);
  World.getRemovePlayerQueue().push(player);

  assert.doesNotThrow(() => World.process());
  assert.equal(World.getRemovePlayerQueue().length, 0, 'the queue entry is not retained forever');
  assert.equal(World.getPlayers().get(player.getIndex()), null, 'the player is deregistered');
});

function stubLoggedInPlayer(name, overrides = {}) {
  const sent = [];
  const player = stubMobile({
    getUsername: () => name,
    isPlayerBot: () => false,
    disconnectSource: null,
    setDisconnectSource(source) { if (this.disconnectSource === null) this.disconnectSource = source; },
    getDisconnectSource() { return this.disconnectSource; },
    readyToLeaveWorld: () => true,
    logoutRefusal: () => null,
    session: {
      getChannel: () => ({ readyState: 1 }),
      refuseLogout: (reason) => sent.push(['refused', reason]),
      logout: () => sent.push(['logout']),
    },
    getSession() { return this.session; },
    ...overrides,
  });
  return { player, sent };
}

function withDisconnectEvents(run) {
  const events = [];
  const original = PluginManager.emitPlayerDisconnect;
  PluginManager.emitPlayerDisconnect = (event) => events.push(event);
  try {
    run(events);
  } finally {
    PluginManager.emitPlayerDisconnect = original;
  }
}

// These players are registered but kept out of the world list, so the tick's other
// phases (movement, sync, sailing) never see the stubs.
test('the logout button is answered on the tick and refused in combat', () => {
  const { player, sent } = stubLoggedInPlayer('edgefighter', {
    logoutRefusal: () => "You can't log out until 10 seconds after the end of combat.",
  });
  player.setRegistered(true);
  World.queueLogoutRequest(player);
  assert.deepEqual(sent, [], 'nothing is answered before the tick');
  World.process();
  assert.deepEqual(sent, [['refused', "You can't log out until 10 seconds after the end of combat."]]);
  assert.equal(World.getRemovePlayerQueue().includes(player), false, 'a refused player stays logged in');
});

test('an accepted logout leaves the world on the same tick with the logout source', () => {
  const { player, sent } = stubLoggedInPlayer('edgeleaver');
  player.setRegistered(true);
  withDisconnectEvents((events) => {
    World.queueLogoutRequest(player);
    World.process();
    assert.deepEqual(sent, [['logout']]);
    assert.equal(World.getRemovePlayerQueue().includes(player), false, 'removed this tick');
    assert.deepEqual(events.map((event) => event.source), ['logout']);
  });
});

test('a player removed in combat stays in the world and fires disconnect only on leaving', () => {
  let ready = false;
  const { player } = stubLoggedInPlayer('edgexlog', { readyToLeaveWorld: () => ready });
  player.setRegistered(true);
  withDisconnectEvents((events) => {
    player.setDisconnectSource('socket_close');
    World.getRemovePlayerQueue().push(player);
    World.process();
    assert.equal(World.getRemovePlayerQueue().includes(player), true, 'held while in combat');
    assert.deepEqual(events, [], 'disconnect hooks wait for the player to leave');
    ready = true;
    World.process();
    assert.equal(World.getRemovePlayerQueue().includes(player), false);
    assert.deepEqual(events.map((event) => event.source), ['socket_close']);
  });
});

test('a disconnected player leaves out of combat, after 16 ticks of no hits, or after 60 seconds', () => {
  let cycle = 1000;
  const originalCycle = World.getProcessCycle;
  World.getProcessCycle = () => cycle;
  try {
    const removing = (ticksSinceAttacked) => ({
      forcedLogoutTimer: { isRunning: () => false },
      logoutHoldCycle: -1,
      inLogoutCombat: Player.prototype.inLogoutCombat,
      getCombat: () => ({ ticksSinceAttacked: () => ticksSinceAttacked }),
    });
    const leaves = (player) => Player.prototype.readyToLeaveWorld.call(player);
    assert.equal(leaves(removing(Infinity)), true, 'never hit');
    assert.equal(leaves(removing(16)), true, '16 ticks after the last hit');
    const fighting = removing(15);
    assert.equal(leaves(fighting), false, 'hit 15 ticks ago');
    cycle += 99;
    assert.equal(leaves(fighting), false, 'still inside the 60 second hold');
    cycle += 1;
    assert.equal(leaves(fighting), true, 'forced out after 100 ticks');
  } finally {
    World.getProcessCycle = originalCycle;
  }
});

test('a disconnect during login cannot build a half-logged-in player', async () => {
  CachePipeline.getActive = () => ({ revision: REVISION });

  let releaseEncrypt;
  GameConstants.PLAYER_PERSISTENCE = stubPersistence({
    encryptPassword: () => new Promise((resolve) => { releaseEncrypt = resolve; }),
  });

  const channel = stubChannel();
  const connection = new net.ClientConnection(channel);
  connection.inject([{ type: 'login', username: 'edgeguard', password: 'secret', revision: REVISION }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof releaseEncrypt, 'function', 'login reached the async password hash');

  channel.closeCb();
  releaseEncrypt('hash');
  await connection.idle();
  connection.inject([{ type: 'handshake', name: 'edgeguard', clientType: 0 }]);
  await connection.idle();

  assert.equal(connection.getPlayer(), undefined, 'no player for a closed socket');
  assert.equal(net.ClientConnection.pendingNames.has('edgeguard'), false, 'the name is released');

  // A fresh socket must be able to claim the name the aborted login released.
  let releaseSecond;
  GameConstants.PLAYER_PERSISTENCE = stubPersistence({
    encryptPassword: () => new Promise((resolve) => { releaseSecond = resolve; }),
  });
  const second = new net.ClientConnection(stubChannel());
  second.inject([{ type: 'login', username: 'edgeguard', password: 'secret', revision: REVISION }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(net.ClientConnection.pendingNames.has('edgeguard'), true, 'the released name is claimable');
  releaseSecond('hash');
  await second.idle();
});


test('inventory Drop and Release reach item action hooks before the ground/drop fallback', () => {
  const { CacheDefinitions } = require('../dist/game/cache/CacheDefinitions');
  const { PluginManager } = require('../dist/plugins/PluginManager');
  const { DropItemPacketListener } = require('../dist/net/packet/impl/DropItemPacketListener');
  const originalDefinition = CacheDefinitions.getItem;
  const originalAction = PluginManager.emitItemAction;
  const originalCanUse = PluginManager.emitCanUseItem;
  const originalDrop = DropItemPacketListener.drop;
  const calls = [];
  const item = { getId: () => 29519 };
  const inventory = { getItems: () => [item], capacity: () => 28 };
  const connection = new net.ClientConnection(stubChannel());
  connection.player = { getInventory: () => inventory, clearPendingAction() {} };
  CacheDefinitions.getItem = () => ({ inventoryActions: [null,null,null,'Drop','Release'] });
  PluginManager.emitCanUseItem = () => true;
  DropItemPacketListener.drop = () => calls.push('fallback');
  try {
    PluginManager.emitItemAction = event => { calls.push(event.option); return true; };
    connection.inventoryAction({ slot:0,itemId:29519,widgetId:3214,option:'Drop' });
    connection.inventoryAction({ slot:0,itemId:29519,widgetId:3214,option:'Release' });
    assert.deepEqual(calls,['Drop','Release']);
    PluginManager.emitItemAction = () => false;
    connection.inventoryAction({ slot:0,itemId:29519,widgetId:3214,option:'Drop' });
    assert.equal(calls.at(-1),'fallback');
  } finally {
    CacheDefinitions.getItem = originalDefinition;
    PluginManager.emitItemAction = originalAction;
    PluginManager.emitCanUseItem = originalCanUse;
    DropItemPacketListener.drop = originalDrop;
  }
});


test('alchemy policy keeps rune and spellbook checks before neutralising a permitted item', () => {
  const {PluginManager}=require('../dist/plugins/PluginManager');
  const {MagicOnItemPacketListener}=require('../dist/net/packet/impl/MagicOnItemPacketListener');
  const {MagicSpellbook}=require('../dist/game/model/MagicSpellbook');
  const original=PluginManager.emitCustomEvent, events=[];
  const amounts=new Map([[29573,1],[561,1],[554,5]]), item={getId:()=>29573,isTradeable:()=>false,isSellable:()=>false,
    getDefinition:()=>({getHighAlchValue:()=>0,getLowAlchValue:()=>0})};
  const inventory={capacity:()=>28,getItems:()=>[item],contains:id=>(amounts.get(id)||0)>0,getAmount:id=>amounts.get(id)||0,
    deleteNumber:(id,n)=>amounts.set(id,(amounts.get(id)||0)-n),adds:(id,n)=>amounts.set(id,(amounts.get(id)||0)+n)};
  const player={getInventory:()=>inventory,getEquipment:()=>({getWeapon:()=>null}),getSkillManager:()=>({getCurrentLevel:()=>99,addExperiences(){}}),
    getSpellbook:()=>MagicSpellbook.NORMAL,sendMessage(){},performAnimation(){},performGraphic(){},
    getPacketSender:()=>({sendTab(){}})};
  try {
    PluginManager.emitCustomEvent=(name,event)=>{events.push(name);if(name==='magic:alchemy-policy'){event.allowed=true;event.coins=0;}};
    const listener=new MagicOnItemPacketListener();
    amounts.set(561,0);listener.castOnItem(player,1178,29573,0);assert.equal(amounts.get(29573),1);
    assert.ok(!events.includes('magic:alchemy-completed'));
    amounts.set(561,1);listener.castOnItem(player,1178,29573,0);
    assert.equal(amounts.get(29573),0);assert.equal(amounts.get(561),0);assert.equal(amounts.get(554),0);
    assert.ok(events.includes('magic:alchemy-completed'));assert.ok(!amounts.has(995),'zero-value neutralisation creates no coins');
  } finally {PluginManager.emitCustomEvent=original;}
});

test('blood ancient spells heal one quarter of damage unless the target suppresses spell effects', () => {
  const {PluginManager}=require('../dist/plugins/PluginManager'),{CombatSpells}=require('../dist/game/content/combat/magic/CombatSpells');
  const original=PluginManager.emitCustomEvent;let healed=0,currentHp=10;
  const attacker={heal:n=>{healed+=Math.min(n,12-currentHp);currentHp=Math.min(12,currentHp+n);}};
  const hit={isAccurate:()=>true,getAttacker:()=>attacker,getTarget:()=>({}),getTotalDamage:()=>39};
  const bloodSpells=[CombatSpells.BLOOD_RUSH,CombatSpells.BLOOD_BURST,CombatSpells.BLOOD_BLITZ,CombatSpells.BLOOD_BARRAGE];
  try {
    PluginManager.emitCustomEvent=(name,e)=>{if(name==='magic:hit-effects')e.allowed=false;};
    for(const spell of bloodSpells){spell.onHitCalc(hit);assert.equal(healed,0);assert.equal(hit.getTotalDamage(),39);}
    PluginManager.emitCustomEvent=()=>{};
    for(const spell of bloodSpells){spell.onHitCalc({...hit,isAccurate:()=>false});assert.equal(healed,0,`${spell.spellId()} does not heal on a miss`);}
    for(const spell of bloodSpells){spell.onHitCalc(hit);assert.equal(healed,2,`${spell.spellId()} heals floor(39 × 25%), capped at max HP`);healed=0;currentHp=10;}
  } finally {PluginManager.emitCustomEvent=original;}
});


test('Casting a utility spell cannot immediately select its newly opened choice dialogue', async () => {
 const {LunarSpells}=require('../dist/game/content/combat/magic/LunarSpells');
 const {SpellTeleports}=require('../dist/game/content/combat/magic/SpellTeleports');
 const {PlayerStatus}=require('../dist/game/model/PlayerStatus');
 const original=LunarSpells.handleSelf,teleport=SpellTeleports.handleSelf;let active=false,selected=0;
 const connection=new net.ClientConnection(stubChannel());
 connection.resolveSpellName=()=> 'Astral Contact';
 connection.player={getAttribute(){},getInterfaceId:()=>-1,getStatus:()=>PlayerStatus.NONE,
  getQuickPrayers:()=>({handleWidgetAction:()=>false}),getDialogueManager:()=>({isActive:()=>active,getCurrent:()=>active?{}:null,handleOption:()=>selected++})};
 try {
  SpellTeleports.handleSelf=()=>false;LunarSpells.handleSelf=()=>{active=true;return true;};
  await connection.dispatch([{type:'widget_action',widgetId:(218<<16)|113,groupId:218,childId:113,buttonNum:1,itemId:9109}]);
  assert.equal(active,true);assert.equal(selected,0);
 }finally{LunarSpells.handleSelf=original;SpellTeleports.handleSelf=teleport;}
});
test('changing floors in one map region refreshes ground items, including Draynor fish food', () => {
  const { State } = require('../dist/game/entity/impl/grounditem/ItemOnGround');
  const { ItemIdentifiers } = require('../dist/util/ItemIdentifiers');
  const { MapRegionReplacementManager } = require('../dist/game/collision/MapRegionReplacementManager');
  const oldItems = World.getItems;
  const oldReplacements = MapRegionReplacementManager.sendVisibleReplacementsToPlayer;
  const snapshots = [];
  let location = new Location(3109, 3357, 0);
  const fish = {
    getPosition: () => new Location(3109, 3357, 1),
    isPendingRemoval: () => false,
    getPrivateArea: () => null,
    getState: () => State.SEEN_BY_EVERYONE,
    getOwner: () => undefined,
    isStaticSpawn: () => true,
    getItem: () => ({ getId: () => ItemIdentifiers.FISH_FOOD }),
  };
  World.getItems = () => [fish];
  MapRegionReplacementManager.sendVisibleReplacementsToPlayer = () => {};
  const channel = { isOpen: true };
  const session = new PlayerSession(channel);
  session.sendRebuildNormal = () => false; // Stop after the actual region/plane bookkeeping.
  session.lastMusicRegion = ((3109 >> 6) << 8) | (3357 >> 6);
  session.lastMusicMode = 1;
  const player = {
    getUsername: () => 'fish537',
    getLocation: () => location,
    getArea: () => null,
    getPrivateArea: () => null,
    getAudioSettings: () => ({ 18: 1 }),
    getPacketSender: () => ({ sendGroundItems: (items) => snapshots.push(items) }),
  };
  session.setPlayer(player);
  try {
    session.flush();
    assert.deepEqual(snapshots, [[]]);
    location = new Location(3109, 3357, 1);
    session.flush();
    assert.deepEqual(snapshots, [[], [fish]], 'upper-floor spawns are sent without changing map square');
    session.flush();
    assert.equal(snapshots.length, 2, 'standing still does not resend');
    location = new Location(3109, 3357, 0);
    session.flush();
    assert.deepEqual(snapshots.at(-1), [], 'upper-floor items clear on returning downstairs');
  } finally {
    World.getItems = oldItems;
    MapRegionReplacementManager.sendVisibleReplacementsToPlayer = oldReplacements;
  }
});


test('generic object hooks receive the actual clicked cache action', () => {
  const { PluginManager } = require('../dist/plugins/PluginManager');
  const hooks = [...PluginManager.objectInteractionHooks], order = PluginManager.nextObjectHookOrder;
  const seen = [];
  try {
    PluginManager.createApi('ObjectActionTest').onObjectInteraction(event => {
      seen.push(event.option); event.handled = true;
    });
    const definition = { getName: () => 'Statue Space', getInteractions: () => ['Inspect', 'Build'] };
    for (const clickType of [2, 1]) {
      const event = { player: {}, object: {}, definition, objectId: 37308, clickType,
        location: { x: 0, y: 0, z: 0 }, handled: false };
      assert.equal(PluginManager.emitObjectInteraction(event), true);
    }
    assert.deepEqual(seen, ['Build', 'Inspect']);
  } finally {
    PluginManager.objectInteractionHooks = hooks; PluginManager.nextObjectHookOrder = order;
  }
});

test('NPC spell targeting requires explicit area permission for actionless puzzle NPCs', () => {
  const {NPCOptionPacketListener}=require('../dist/net/packet/impl/NPCOptionPacketListener');
  const {CombatSpells}=require('../dist/game/content/combat/magic/CombatSpells');
  const originalNpc=World.getNpcs, originalSpell=CombatSpells.getCombatSpell;
  let permission=null, attackable=false, valid=true, casts=0;
  const npc={getHitpoints:()=>10,getLocation:()=>({}),getCurrentDefinition:()=>({isAttackable:()=>attackable}),
    getPrivateArea:()=>({canCastOnNpc:()=>permission})};
  const spell={canCastOnTarget:()=>valid};
  const player={getHitpoints:()=>99,busy:()=>false,getLocation:()=>({isWithinDistance:()=>true}),
    getMovementQueue:()=>({reset(){}}),getCombat:()=>({castSpellOn:(target,chosen)=>{assert.equal(target,npc);assert.equal(chosen,spell);casts++;}})};
  World.getNpcs=()=>({capacityReturn:()=>10,get:()=>npc});CombatSpells.getCombatSpell=()=>spell;
  try {
    assert.equal(NPCOptionPacketListener.castSpell(player,1,1),false);
    permission=true;assert.equal(NPCOptionPacketListener.castSpell(player,1,1),true);assert.equal(casts,1);
    valid=false;assert.equal(NPCOptionPacketListener.castSpell(player,1,1),false,'normal spell requirements remain enforced');
    valid=true;attackable=true;permission=false;assert.equal(NPCOptionPacketListener.castSpell(player,1,1),false);
    permission=null;assert.equal(NPCOptionPacketListener.castSpell(player,1,1),true,'ordinary combat NPC targeting is unchanged');
  } finally {World.getNpcs=originalNpc;CombatSpells.getCombatSpell=originalSpell;}
});


test('player healing preserves existing overheal and still caps ordinary health restoration', () => {
  const {Player}=require('../dist/game/entity/impl/player/Player');
  let hp=121;
  const player={getSkillManager:()=>({getCurrentLevel:()=>hp,getMaxLevel:()=>99}),setHitpoints:v=>hp=v};
  Player.prototype.heal.call(player,0);assert.equal(hp,121,'a zero-damage Blood heal cannot remove overheal');
  Player.prototype.heal.call(player,6);assert.equal(hp,121,'healing neither removes nor extends existing overheal');
  hp=98;Player.prototype.heal.call(player,6);assert.equal(hp,99);
  hp=30;Player.prototype.heal.call(player,6);assert.equal(hp,36);
});
