// Run after `yarn build`: node --test tests/castlewars.test.cjs
const assert = require('node:assert/strict');
const { test, before, afterEach } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { RegionManager } = require('../dist/game/collision/RegionManager');
const { MapObjects } = require('../dist/game/entity/impl/object/MapObjects');
const { CacheDefinitions } = require('../dist/game/cache/CacheDefinitions');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { World } = require('../dist/game/World');

const core = PluginManager.getCoreApi();
const data = require('../plugins/minigames/castlewars/Data.CastleWars')(core);
const Game = require('../plugins/minigames/castlewars/Game.CastleWars');
const Lobby = require('../plugins/minigames/castlewars/Lobby.CastleWars');
const Areas = require('../plugins/minigames/castlewars/Areas.CastleWars');
const { TEAM } = data;

let game;
let objectHandler;
let botLogins = 0;
let prompt = null;

const registry = {
  core,
  getAreaManager: () => ({ areas: [] }),
  getBonusManager: () => ({ update: () => {} }),
  getObjectManager: () => ({ register: () => {}, deregister: () => {}, existsLocation: () => false }),
  getRegionManager: () => RegionManager,
  getTaskManager: () => ({ submit: () => {}, cancelTasks: () => {} }),
  getWorld: () => World,
  getPluginConfig: (key, fallback) => PluginManager.getPluginConfig(key, fallback),
  emitPlayerLogin: () => { botLogins += 1; },
  onObjectInteraction: (handler) => { objectHandler = handler; },
  onNpcInteraction: () => {},
  sendMultiChatboxPrompt: (player, title, ...pairs) => {
    const options = [];
    for (let i = 0; i < pairs.length; i += 2) options.push({ text: pairs[i], pick: pairs[i + 1] });
    prompt = { player, title, options };
    return true;
  },
};

function fakeArea(players = []) {
  return { players, getPlayers: () => players };
}

function fakePlayer({ head = -1, cape = -1, inventory = [], bot = false } = {}) {
  const attributes = new Map();
  const state = {
    messages: [], moves: [], logouts: 0,
    getEquipment: () => ({
      getSlot: (slot) => (slot === core.Equipment.HEAD_SLOT ? head : slot === core.Equipment.CAPE_SLOT ? cape : -1),
    }),
    getInventory: () => ({ getItems: () => inventory.map((id) => ({ getId: () => id })) }),
    sendMessage: (message) => state.messages.push(message),
    smartMove: (location) => state.moves.push(location),
    moveTo: (location) => state.moves.push(location),
    isPlayerBot: () => bot,
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    getForcedLogoutTimer: () => ({ start: () => { state.logouts += 1; } }),
    requestLogout: () => {},
  };
  if (bot) attributes.set(game.BOT_KEY, true);
  return state;
}

function lobbyObject(id) {
  return { getId: () => id, getLocation: () => new core.Location(2440, 3089, 0) };
}

function enterPortal(player, portalId) {
  objectHandler({ player, object: lobbyObject(portalId), clickType: 1, handled: false });
}

function mapObject(id) {
  for (const list of MapObjects.mapObjects.values()) {
    for (const object of list) if (object.getId() === id) return object;
  }
  return null;
}

before(() => {
  CachePipeline.initialize();
  // The entry check asks the Food plugin, which reads item names from the cache.
  require('../plugins/items/Food.plugin').register({ core, persistAttribute() {}, onPlayerLogin() {}, onItemAction() {} });
  RegionManager.init();
  RegionManager.loadMapFiles(2436, 3089);
  RegionManager.loadMapFiles(2381, 9489);
  RegionManager.loadMapFiles(2429, 3074);
  game = Game(registry);
  game.lobbyArea = fakeArea();
  game.waitingAreas = { [TEAM.SARADOMIN]: fakeArea(), [TEAM.ZAMORAK]: fakeArea() };
  game.gameArea = fakeArea();
  Lobby(registry, game);
});

afterEach(() => {
  PluginManager.pluginConfigCache = {};
  prompt = null;
  World.getAddPlayerQueue().splice(0);
  for (const area of Object.values(game.waitingAreas)) area.players.length = 0;
  game.lobbyArea.players.length = 0;
});

test('every lobby, waiting-room and game portal matches its cache object and bounds', () => {
  for (const [id, team] of Object.entries(data.LOBBY_TEAMS)) {
    const object = mapObject(Number(id));
    assert.ok(object, `lobby portal ${id} exists on the map`);
    assert.equal(CacheDefinitions.getObject(Number(id)).actions[0], 'Enter', `lobby portal ${id} offers Enter`);
    assert.ok(
      data.LOBBY_BOUNDS.some((bounds) => bounds.inside(object.getLocation())),
      `lobby portal ${id} sits inside the lobby bounds`
    );
    assert.ok(team === null || data.TEAM_DATA[team], `lobby portal ${id} maps to a real team`);
  }
  for (const id of data.WAITING_EXIT_IDS) {
    const object = mapObject(id);
    assert.ok(object, `waiting exit ${id} exists on the map`);
    assert.equal(CacheDefinitions.getObject(id).actions[0], 'Exit', `waiting exit ${id} offers Exit`);
    assert.ok(
      Object.values(data.TEAM_DATA).some((team) => team.waitingBounds.some((bounds) => bounds.inside(object.getLocation()))),
      `waiting exit ${id} sits inside a waiting room`
    );
  }
  for (const id of data.GAME_EXIT_IDS) {
    const object = mapObject(id);
    assert.ok(object, `game exit ${id} exists on the map`);
    assert.equal(CacheDefinitions.getObject(id).actions[0], 'Leave', `game exit ${id} offers Leave`);
    assert.ok(
      Object.values(data.TEAM_DATA).some((team) => team.respawnBounds.inside(object.getLocation())),
      `game exit ${id} sits inside a respawn room`
    );
  }
});

test('Guthix sends a joiner to the smaller team', () => {
  game.waitingAreas[TEAM.SARADOMIN].players.push(fakePlayer());
  const player = fakePlayer();
  enterPortal(player, core.ObjectIdentifiers.GUTHIX_PORTAL);
  assert.equal(game.getTeamId(player), TEAM.ZAMORAK);
  assert.equal(player.moves.length, 1);
  assert.equal(player.moves[0].getY(), data.TEAM_DATA[TEAM.ZAMORAK].waitingRoom.getY());
});

test('a joiner cannot enter the bigger team', () => {
  game.waitingAreas[TEAM.SARADOMIN].players.push(fakePlayer(), fakePlayer());
  game.waitingAreas[TEAM.ZAMORAK].players.push(fakePlayer());
  const player = fakePlayer();
  enterPortal(player, core.ObjectIdentifiers.SARADOMIN_PORTAL);
  assert.equal(game.getTeamId(player), null);
  assert.equal(player.moves.length, 0);
  assert.deepEqual(player.messages, ['The Saradomin team is full, try Zamorak.']);
});

test('headwear and capes block entry before the teleport', () => {
  const player = fakePlayer({ head: core.ItemIdentifiers.CASTLEWARS_HOOD });
  enterPortal(player, core.ObjectIdentifiers.GUTHIX_PORTAL);
  assert.equal(game.getTeamId(player), null);
  assert.equal(player.moves.length, 0);
  assert.deepEqual(player.messages, ["You can't wear hats, capes, or helms in Castle Wars."]);
});

test('food carried in the inventory blocks entry', () => {
  const player = fakePlayer({ inventory: [core.ItemIdentifiers.SHARK] });
  enterPortal(player, core.ObjectIdentifiers.GUTHIX_PORTAL);
  assert.equal(game.getTeamId(player), null);
  assert.equal(player.moves.length, 0);
  assert.deepEqual(player.messages, ['You may not bring your own consumables inside Castle Wars.']);
});

test('the bot seeding gate is off unless the world config turns it on', () => {
  assert.equal(Lobby._test.seedsBots(), false);
  const player = fakePlayer();
  const loginsBefore = botLogins;
  enterPortal(player, core.ObjectIdentifiers.GUTHIX_PORTAL);
  assert.equal(World.getAddPlayerQueue().length, 0, 'no bots seeded by default');
  assert.equal(botLogins, loginsBefore, 'no bot was logged in');

  PluginManager.pluginConfigCache = { [Lobby._test.SEED_BOTS_CONFIG_KEY]: true };
  assert.equal(Lobby._test.seedsBots(), true);
  const second = fakePlayer();
  enterPortal(second, core.ObjectIdentifiers.GUTHIX_PORTAL);
  const seeded = World.getAddPlayerQueue();
  assert.equal(seeded.length, 3, 'a configured development world seeds three bots');
  assert.equal(botLogins - loginsBefore, 3, 'each seeded bot logged in');
  assert.equal(seeded.filter((bot) => game.getTeamId(bot) === game.getTeamId(second)).length, 1);
  assert.equal(seeded.filter((bot) => game.getTeamId(bot) === game.opposingTeam(game.getTeamId(second))).length, 2);
});

test('seeded bots log out once no real player is left', () => {
  const real = fakePlayer();
  const bot = fakePlayer({ bot: true });
  game.lobbyArea.players.push(real);
  game.waitingAreas[TEAM.SARADOMIN].players.push(bot);
  assert.equal(game.releaseSeededBots(), false, 'bots stay while a real player is around');
  assert.equal(bot.logouts, 0);

  game.lobbyArea.players.length = 0;
  assert.equal(game.releaseSeededBots(), true);
  assert.equal(bot.logouts, 1, 'the bot was logged out');
});

test('both waiting rooms release seeded bots on leave and honour the transition path', () => {
  const registered = [];
  const calls = { released: 0, coloured: 0, countdown: 0 };
  const island = {
    data,
    BOT_KEY: {},
    TRANSITION_KEY: {},
    getTeamData: (team) => data.TEAM_DATA[team],
    getTeamId: () => null,
    setTeamId: () => {},
    clearCastleWarsItems: () => {},
    closeOverlay: () => {},
    equipTeamColours: () => { calls.coloured += 1; },
    beginStartCountdown: () => {},
    startSecondsLeft: () => 0,
    returnToLobby: () => {},
    releaseSeededBots: () => { calls.released += 1; return true; },
    checkStartCountdown: () => { calls.countdown += 1; },
  };
  Areas({
    core,
    registerArea: (area) => registered.push(area),
    onServerStartup: () => {}, onPlayerLogin: () => {}, onCanEquip: () => {}, onCanUnequip: () => {},
    onPlayerDeath: () => {}, onShouldDropItemsOnDeath: () => {}, onCustomEvent: () => {},
  }, island);

  const waitingRooms = registered.filter((area) => area.getName().includes('waiting room'));
  assert.equal(waitingRooms.length, 2, 'both waiting rooms are registered');
  for (const waitingRoom of waitingRooms) {
    const real = { getAsPlayer: () => real, getAttribute: () => false, isPlayerBot: () => false, resetAttributes: () => {} };
    waitingRoom.postLeave(real, false);
    assert.equal(calls.released, 1, 'leaving releases seeded bots');
    assert.equal(calls.countdown, 1, 'leaving cancels a pending countdown');
    calls.released = 0;
    calls.countdown = 0;

    const transitioning = new Map([[island.TRANSITION_KEY, true]]);
    const movingIn = { getAsPlayer: () => movingIn, getAttribute: (key) => transitioning.get(key), isPlayerBot: () => false };
    waitingRoom.postLeave(movingIn, false);
    assert.equal(calls.released, 0, 'a player moving into the game keeps the seeded bots');
    assert.equal(calls.countdown, 0, 'a player moving into the game keeps the countdown');

    const bot = { getAsPlayer: () => bot, getAttribute: () => false, isPlayerBot: () => true };
    waitingRoom.postEnter(bot);
    assert.equal(calls.released, 1, 'a bot arriving with no real players is released');
    assert.equal(calls.coloured, 0, 'a released bot never gets team colours');
    calls.released = 0;
  }
});

test('a real player joining an empty lobby is prompted to pick a bot tier', () => {
  const player = fakePlayer();
  enterPortal(player, core.ObjectIdentifiers.GUTHIX_PORTAL);
  assert.ok(prompt, 'the empty-lobby prompt was shown');
  assert.equal(prompt.title, 'The Castle Wars lobby is empty. Which bots should populate the game?');
  assert.deepEqual(prompt.options.map((option) => option.text), ['Novice', 'Intermediate', 'Veteran', 'None']);
  assert.equal(player.moves.length, 0, 'the player is not moved before answering');

  const loginsBefore = botLogins;
  prompt.options[3].pick();
  assert.equal(player.moves.length, 1, 'None still moves the player to a waiting room');
  assert.equal(World.getAddPlayerQueue().length, 0, 'None spawns no bots');
  assert.equal(botLogins, loginsBefore, 'None logs in no bots');
});

test('picking a tier populates both teams with the 12/6/5 mix plus the specialists', () => {
  assert.equal(game.BOT_ROLE_KEY, 'castlewars:bot-role');
  assert.equal(game.BOT_TIER_KEY, 'castlewars:bot-tier');
  const player = fakePlayer();
  enterPortal(player, core.ObjectIdentifiers.SARADOMIN_PORTAL);
  assert.ok(prompt, 'the empty-lobby prompt was shown');
  prompt.options[2].pick();

  assert.equal(player.moves.length, 1, 'the player joins the team they asked for');
  assert.equal(game.getTeamId(player), TEAM.SARADOMIN);

  const bots = World.getAddPlayerQueue();
  assert.equal(bots.length, 60, 'thirty bots a side');
  for (const teamId of [TEAM.SARADOMIN, TEAM.ZAMORAK]) {
    const teamBots = bots.filter((bot) => game.getTeamId(bot) === teamId);
    assert.equal(teamBots.length, 30, `${teamId} has thirty bots`);
    const roles = {
      attacker: 0, flag: 0, guard: 0, doorman: 0, 'side-doorman': 0,
      archer: 0, mage: 0, catapult: 0,
    };
    for (const bot of teamBots) {
      assert.equal(bot.getAttribute('castlewars:bot-tier'), 'veteran', `${bot.getUsername()} is the picked tier`);
      const role = bot.getAttribute('castlewars:bot-role');
      assert.ok(role in roles, `${bot.getUsername()} has a real role`);
      roles[role] += 1;
    }
    assert.deepEqual(
      roles,
      { attacker: 12, flag: 6, guard: 5, doorman: 1, 'side-doorman': 1, archer: 2, mage: 2, catapult: 1 },
      `${teamId} gets the 12/6/5 mix plus the specialists`
    );
  }
});

test('bots entering an empty lobby are never prompted', () => {
  const bot = fakePlayer({ bot: true });
  enterPortal(bot, core.ObjectIdentifiers.GUTHIX_PORTAL);
  assert.equal(prompt, null, 'no prompt for a bot');
  assert.equal(bot.moves.length, 1, 'the bot still joins a waiting room');
});

test('a carrier whose banner was stripped before the drop hook still drops the flag', () => {
  const player = fakePlayer();
  enterPortal(player, core.ObjectIdentifiers.SARADOMIN_PORTAL);
  prompt.options[0].pick();
  const carrier = World.getAddPlayerQueue().find((bot) => game.getTeamId(bot) === TEAM.ZAMORAK);
  assert.ok(carrier, 'a Zamorak bot was spawned');
  game.carryFlag(carrier, TEAM.ZAMORAK);
  assert.equal(game.flagStatus[TEAM.ZAMORAK], 1, 'the flag is recorded as carried');
  assert.equal(game.getCarriedFlagTeam(carrier), TEAM.ZAMORAK, 'the banner is equipped');
  // Bot deaths run through the bot loot system, which removes the banner before any
  // Castle Wars drop hook can see it - the case that used to leave the flag carried
  // forever with no carrier, so no hint arrow and no way to score.
  carrier.getEquipment().resetItems();
  game.dropCarriedFlag(carrier);
  assert.equal(game.flagStatus[TEAM.ZAMORAK], 2, 'the flag now lies where the carrier fell');
  assert.equal(game.getCarriedFlagTeam(carrier), null, 'nobody is holding it');
  game.restoreFlagToBase(TEAM.ZAMORAK);
});

test('Castle Wars deaths keep player and bot gear, drop the flag and remove only game supplies', (t) => {
  const { PlayerDeathTask } = require('../dist/game/task/impl/PlayerDeath');
  const { ItemOnGroundManager } = require('../dist/game/entity/impl/grounditem/ItemOnGroundManager');
  let deathPolicy;
  let respawn;
  const calls = [];
  const island = {
    ...game,
    getTeamId: () => TEAM.SARADOMIN,
    dropCarriedFlag: () => calls.push('flag'),
    clearCastleWarsItems: (_player, ids) => calls.push(ids),
    resetIdleTicks: () => {},
  };
  Areas({
    core, registerArea() {}, onServerStartup() {}, onPlayerLogin() {}, onCanEquip() {}, onCanUnequip() {}, onCustomEvent() {},
    onShouldDropItemsOnDeath: (handler) => { deathPolicy = handler; },
    onPlayerDeath: (handler) => { respawn = handler; },
  }, island);
  t.mock.method(PluginManager, 'emitShouldDropItemsOnDeath', (player) => {
    const event = { player, shouldDrop: null };
    deathPolicy(event);
    return event.shouldDrop;
  });
  t.mock.method(PluginManager, 'emitPlayerDeath', (event) => { respawn(event); return event.handled; });
  t.mock.method(PluginManager, 'emitPlayerDefeated', () => {});
  t.mock.method(ItemOnGroundManager, 'registerLocation', () => {});
  const drop = t.mock.method(PlayerDeathTask, 'dropItems', () => { throw new Error('A safe death must not process gear'); });
  for (const bot of [false, true]) {
    const gear = new core.Item(core.ItemIdentifiers.DRAGON_WARHAMMER, 1);
    const player = {
      isPlayerBot: () => bot,
      getArea: () => island.gameArea,
      getLocation: () => new core.Location(2420, 3075),
      getCombat: () => ({ getRecentDamagerEntries: () => [], getKiller: () => null }),
      getInventory: () => ({ getItems: () => [gear] }),
      resetAttributes() {},
      smartMoves: (bounds) => { assert.equal(bounds, data.TEAM_DATA[TEAM.SARADOMIN].respawnBounds); },
    };
    const task = new PlayerDeathTask(player);
    task.ticks = 0;
    task.execute();
    assert.equal(task.loseItems, false);
    assert.equal(player.getInventory().getItems()[0], gear);
  }
  assert.equal(drop.mock.callCount(), 0);
  assert.deepEqual(calls, ['flag', data.DEATH_REMOVE_ITEM_IDS, 'flag', data.DEATH_REMOVE_ITEM_IDS]);
  for (const area of Object.values(island.waitingAreas)) {
    const event = { player: { getArea: () => area }, shouldDrop: null };
    deathPolicy(event);
    assert.equal(event.shouldDrop, false, 'waiting rooms also preserve gear');
  }
  const outside = { player: { getArea: () => ({}) }, shouldDrop: null };
  deathPolicy(outside);
  assert.equal(outside.shouldDrop, null, 'ordinary deaths keep their existing rules');
});

test('the arena is multi-combat: several enemies may hit one player, the lobby and waiting rooms are not', (t) => {
  const { Player } = require('../dist/game/entity/impl/player/Player');
  const { AreaManager } = require('../dist/game/model/areas/AreaManager');
  const { CombatFactory, CanAttackResponse } = require('../dist/game/content/combat/CombatFactory');
  const { TaskManager } = require('../dist/game/task/TaskManager');
  t.mock.method(TaskManager, 'cancelTasks', () => {});
  // The real area classes, attached to a copy of the game so the fakes the other tests rely on
  // stay in place; the phase is pinned to a live match so the game area admits the players.
  const island = { ...game, getPhase: () => game.PHASE.ACTIVE };
  const registered = [];
  Areas({
    core, registerArea: (area) => registered.push(area), onServerStartup() {}, onPlayerLogin() {}, onCanEquip() {},
    onCanUnequip() {}, onCustomEvent() {}, onShouldDropItemsOnDeath() {}, onPlayerDeath() {},
  }, island);
  AreaManager.areas.push(...registered);
  t.after(() => {
    for (const area of registered) AreaManager.areas.splice(AreaManager.areas.indexOf(area), 1);
  });
  const bounds = { gameArea: data.GAME_BOUNDS, lobbyArea: data.LOBBY_BOUNDS };
  for (const [name, list] of Object.entries(bounds)) assert.equal(island[name].getBoundaries(), list, `${name} keeps its bounds`);

  let index = 100;
  const messages = new Map();
  function fighter(location, teamId = null) {
    const p = new Player(null, location);
    p.setUsername(`cw_multi_${++index}`); p.setIndex(index); p.setRegistered(true);
    t.mock.method(p, 'getSession', () => ({ sendClientPacket: () => true, write: () => true }));
    t.mock.method(p, 'sendMessage', (message) => messages.set(p, message));
    if (teamId) island.setTeamId(p, teamId);
    AreaManager.process(p);
    t.after(() => { p.setArea(null); island.setTeamId(p, null); p.setRegistered(false); });
    return p;
  }

  // (a) + (c): inside the arena the multi flag and icon are on, in the lobby and waiting rooms off.
  const field = [new core.Location(2400, 3104, 0), new core.Location(2401, 3104, 0), new core.Location(2402, 3104, 0)];
  const [target, first, second] = [
    fighter(field[0], TEAM.SARADOMIN), fighter(field[1], TEAM.ZAMORAK), fighter(field[2], TEAM.ZAMORAK),
  ];
  for (const p of [target, first, second]) {
    assert.equal(p.getArea(), island.gameArea, 'the field tile resolves to the real game area');
    assert.equal(AreaManager.inMulti(p), true, 'the arena is multi-combat');
    assert.equal(p.getMultiIcon(), 1, 'the multi icon is sent after an area tick');
  }
  // A fresh moveTo leaves needsPlacement set, which validTarget refuses, so a separate player
  // walks the castle floors and the tunnels. The game grants the spawn-room idle allowance on
  // entry; without it the area tick ejects the probe from its own respawn room to the lobby.
  const probe = fighter(new core.Location(2400, 3105, 0), TEAM.SARADOMIN);
  island.resetIdleTicks(probe);
  for (const [x, y, z] of [[2426, 3076, 1], [2429, 3074, 3], [2372, 3131, 1], [2385, 9510, 0], [2410, 9480, 0]]) {
    probe.moveTo(new core.Location(x, y, z));
    AreaManager.process(probe);
    const stood = probe.getLocation();
    assert.deepEqual([stood.getX(), stood.getY(), stood.getZ()], [x, y, z], `the probe still stands on ${x},${y},${z} after the area tick`);
    assert.equal(probe.getArea(), island.gameArea, `${x},${y},${z} (castle floors and tunnels) is in the arena`);
    assert.equal(AreaManager.inMulti(probe), true, `${x},${y},${z} is multi-combat`);
  }
  const lobby = fighter(new core.Location(2440, 3089, 0));
  const waiting = fighter(new core.Location(2381, 9489, 0));
  assert.equal(lobby.getArea(), island.lobbyArea);
  assert.equal(waiting.getArea(), island.waitingAreas[TEAM.SARADOMIN]);
  for (const p of [lobby, waiting]) {
    assert.equal(AreaManager.inMulti(p), false, `${p.getArea().getName()} is not multi-combat`);
    assert.equal(p.getMultiIcon(), 0);
  }

  // (b): the first Zamorak attacker engages; the second may still pile on, a teammate still may not.
  assert.equal(CombatFactory.canAttackPermission(first, target), CanAttackResponse.CAN_ATTACK);
  first.getCombat().attack(target);
  target.getCombat().setUnderAttack(first);
  target.getCombat().attack(first);
  assert.equal(CombatFactory.canAttackPermission(second, target), CanAttackResponse.CAN_ATTACK,
    'a second enemy is not refused with the single-combat verdict');
  assert.equal(CombatFactory.canAttackPermission(second, first), CanAttackResponse.CANT_ATTACK_IN_AREA, 'friendly fire stays refused');
  assert.equal(messages.get(second), "You can't attack your own team in Castle Wars.");
  // The shipped world.json also lists the arena under its multi-combat zones, but a deployment's
  // world.local.json replaces that list wholesale, so the area must carry the rule on its own.
  const { Wilderness } = require('../dist/game/content/wilderness/Wilderness');
  t.mock.method(Wilderness, 'isMulti', () => false);
  for (const p of [target, first, second]) assert.equal(AreaManager.inMulti(p), true, 'the area alone keeps the arena multi-combat');
  assert.equal(CombatFactory.canAttackPermission(second, target), CanAttackResponse.CAN_ATTACK,
    'a second enemy still piles on with no world.json zone behind it');
  const area = t.mock.method(island.gameArea, 'isMulti', () => false);
  assert.equal(CombatFactory.canAttackPermission(second, target), CanAttackResponse.TARGET_IN_COMBAT,
    'without the area rule and the zone the arena is single-way combat');
  area.mock.restore();
  assert.equal(CombatFactory.canAttackPermission(second, target), CanAttackResponse.CAN_ATTACK);
});
