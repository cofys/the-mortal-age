// Run after `yarn build`: node --test tests/bounty-hunter-bots.test.cjs
const assert = require('node:assert/strict');
const { before, test } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const Bots = require('../plugins/minigames/bountyhunter/Bots.BountyHunter');
const { pickTierChoice, TIER_BANDS } = require('../plugins/bots/behaviours/pvp/PvpTierLoadouts.PlayerBots');

const Entry = require('../plugins/minigames/bountyhunter/Entry.BountyHunter');
const Coffer = require('../plugins/minigames/bountyhunter/Coffer.BountyHunter');
const { setActiveBotRuntime } = require('../plugins/bots/runtime/RuntimeRegistry.PlayerBots');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { Player } = require('../dist/game/entity/impl/player/Player');
const core = PluginManager.getCoreApi();

before(async () => {
  await CachePipeline.initialize();
  core.RegionManager.init();
  require('../plugins/items/Food.plugin').register(PluginManager.createApi('BountyHunterFoodRegression'));
});

test('lobby entry spawns funded, skulled PK bots and restores their entry fee after death', (t) => {
  const hooks = new Map();
  const tasks = [];
  const spawned = [];
  const removed = [];
  const populationRolls = [30, 50];
  const runtime = { botStatesByName: new Map(), spawnPvpBot };
  const human = { isPlayerBot: () => false };
  const bh = { lobby: new Set([human]), arena: new Set(), isArenaTile: () => true, inArena: () => false };
  const spawnTile = Entry.spawnTile;
  Entry.spawnTile = () => ({ getX: () => 3363, getY: () => 4037, getZ: () => 0 });
  setActiveBotRuntime(runtime, { PVP: 'pvp' });
  t.after(() => { Entry.spawnTile = spawnTile; setActiveBotRuntime(null, null); });

  function spawnPvpBot(location, options) {
    if (runtime.botStatesByName.has(options.username)) return null; // as the registry: name still taken
    const attributes = new Map();
    const level = [60, 88, 110, 126][spawned.length % 4];
    const bot = {
      skulled: false, dying: false, coins: 0,
      getUsername: () => options.username,
      isPlayerBot: () => true,
      getAttribute: (key) => attributes.get(key),
      setAttribute: (key, value) => attributes.set(key, value),
      getSkillManager: () => ({ getCombatLevel: () => level }),
      isSkulled: () => bot.skulled,
      getHitpoints: () => 99,
      getCombat: () => ({ getTarget: () => bot.opponent, getAttacker: () => bot.attacker }),
      isDyingReturn: () => bot.dying,
      getLocation: () => location,
      getInventory: () => ({ forceAdd: (_, item) => { bot.coins += item.amount; } }),
      getForcedLogoutTimer: () => ({ start: () => {} }),
      requestLogout: () => { removed.push(bot); hooks.get('logout')({ player: bot }); },
    };
    assert.equal(options.mode, 'pvp');
    runtime.botStatesByName.set(options.username, { pvp: {} });
    spawned.push(bot);
    return bot;
  }

  const api = {
    core: {
      Task: class {},
      Misc: { random: (min, max) => {
        assert.deepEqual([min, max], [30, 50]);
        assert.ok(populationRolls.length, 'roll only once per new population');
        return populationRolls.shift();
      } },
      Item: class { constructor(id, amount) { this.amount = amount; } },
      ItemIdentifiers: { COINS: 995 },
      SkullType: { WHITE_SKULL: 'white' },
      CombatFactory: { PVP_SKULL_SECONDS: 1800, skull: (bot) => { bot.skulled = true; } },
    },
    onCustomEvent: (name, fn) => hooks.set(name, fn),
    onPlayerLogout: (fn) => hooks.set('logout', fn),
    onPlayerBeforeDeath: (fn) => hooks.set('before-death', fn),
    onServerStartup: (fn) => hooks.set('startup', fn),
    getTaskManager: () => ({ submit: (task) => tasks.push(task) }),
  };
  Coffer(new Proxy(api, { get: (object, name) => object[name] ?? (() => {}) }));
  Bots(api, bh);
  const enter = hooks.get('bounty-hunter:entered-lobby');
  enter({ player: { isPlayerBot: () => true } });
  assert.equal(spawned.length, 0, 'bots cannot populate the crater');
  enter({ player: human });
  assert.deepEqual(spawned.map((bot) => bot.getUsername()), Array.from({ length: 30 }, (_, i) => `BhBot${i + 1}`));
  for (const bot of spawned) {
    assert.equal(bot.isSkulled(), true);
    assert.equal(Coffer.balance(bot), Coffer.playerMinimumDeposit(bot));
  }
  enter({ player: human });
  assert.equal(spawned.length, 30, 'another entry cannot duplicate the population');

  const defender = spawned[0], rogue = spawned[1], quarry = spawned[2];
  const pvp = runtime.botStatesByName.get(defender.getUsername()).pvp;
  pvp.targetPlayer = rogue;
  pvp.targetUsername = rogue.getUsername();
  for (const link of ['opponent', 'attacker']) {
    defender[link] = rogue;
    hooks.get('bounty-hunter:target-assigned')({ player: defender, target: quarry });
    hooks.get('bounty-hunter:target-cleared')({ player: defender });
    assert.equal(pvp.targetPlayer, rogue, 'matchmaking cannot interrupt an ongoing fight');
    assert.equal(pvp.targetUsername, rogue.getUsername());
    defender[link] = null;
  }
  hooks.get('bounty-hunter:target-cleared')({ player: defender });
  assert.equal(pvp.targetPlayer, null, 'an idle bot drops its old assignment');

  hooks.get('startup')();
  const victim = spawned[0];
  const killer = spawned[1];
  Coffer.died({ player: victim, killer, skulled: true });
  assert.equal(killer.coins, 10_000, 'a bot kill pays the coffer reward');
  assert.equal(Coffer.balance(victim), 20_000);
  victim.skulled = false;
  victim.dying = true;
  tasks[0].execute();
  assert.equal(Coffer.balance(victim), 20_000, 'no refill or reskull during death handling');
  assert.equal(victim.isSkulled(), false);
  victim.dying = false;
  tasks[0].execute();
  assert.equal(Coffer.balance(victim), 30_000);
  assert.equal(victim.isSkulled(), true);
  const rich = spawned[2];
  rich.setAttribute('bounty-hunter:coffer', 200_000);
  tasks[0].execute();
  assert.equal(Coffer.balance(rich), 200_000, 'funding preserves an existing surplus');

  for (const bot of [...spawned]) bot.requestLogout();
  assert.equal(removed.length, 30);
  tasks[0].execute();
  assert.equal(spawned.length, 31, 'an occupied crater recovers even after every bot leaves');
  assert.equal(populationRolls.length, 1, 'departures keep the existing population target');
  for (let index = 1; index < 30; index++) tasks[0].execute();
  assert.equal(spawned.length, 60, 'one replacement per tick restores the roster without a burst');
  tasks[0].execute();
  assert.equal(spawned.length, 60, 'a full roster stops spawning');
  bh.lobby.clear();
  bh.arena.add(human);
  tasks[0].execute();
  assert.equal(removed.length, 30, 'entering the arena keeps the population');
  const otherHuman = { isPlayerBot: () => false };
  bh.lobby.add(otherHuman);
  enter({ player: otherHuman });
  bh.arena.delete(human);
  tasks[0].execute();
  assert.equal(removed.length, 30, 'one player leaving cannot remove another player\'s opponents');
  bh.lobby.delete(otherHuman);
  bh.arena.add(spawned[0]);
  tasks[0].execute();
  assert.equal(removed.length, 60, 'the next tick removes every bot when the last real player leaves');
  tasks[0].execute();
  assert.equal(removed.length, 60, 'an empty crater does no more bot work');
  bh.arena.clear();
  bh.lobby.add(human);
  enter({ player: human });
  assert.equal(spawned.length, 110, 'the next visit rolls a fresh population, including the upper limit');
  assert.equal(spawned.at(-1).getUsername(), 'BhBot110', 'fresh names: the last bots may still be online');
  bh.lobby.clear();
  bh.arena.clear();
  tasks[0].execute();
});

test('the shared tier picker still answers each tier', () => {
  for (const tier of Object.keys(TIER_BANDS)) assert.ok(pickTierChoice(tier), tier);
  assert.equal(pickTierChoice('unknown'), null);
});

test('members-only picks never draw a free-to-play preset', () => {
  for (const tier of Object.keys(TIER_BANDS)) {
    for (let index = 0; index < 20; index++) {
      const choice = pickTierChoice(tier, { index, excludeF2p: true });
      assert.ok(!choice || !choice.tags.includes('f2p'), `${tier} ${choice?.loadoutId}`);
    }
  }
});

test('Bounty Hunter retreat uses remaining food, commits to a real exit and logs out without refitting', async (t) => {
  const { PvpDefensiveActionNode } = require('../plugins/bots/behaviours/nodes/pvp/PvpDefensiveActionNode.PlayerBots');
  const { PvpController } = require('../plugins/bots/brain/pvp/PvpController.PlayerBots');
  const { EatFoodActionNode } = require('../plugins/bots/behaviours/nodes/actions/EatFoodActionNode.PlayerBots');
  const { peekMovementRequest, clearMovementRequest, dispatchMovementRequest } = require('../plugins/bots/behaviours/navigation/Navigation.PlayerBots');
  const bh = require('../plugins/minigames/bountyhunter/State.BountyHunter');
  const runtime = { botStatesByName: new Map() };
  const api = PluginManager.createApi('BountyHunterRetreatRegression');
  Entry(api, bh);
  Bots(api, bh);
  setActiveBotRuntime(runtime, { PVP: 'pvp' });
  t.after(() => setActiveBotRuntime(null, null));

  function fixture(t, name) {
    const player = new Player(null, new core.Location(3363, 4037));
    player.setUsername(name);
    player.setRegistered(true);
    player.setPlayerBot(true);
    player.setAttribute('bounty-hunter:bot', true);
    t.mock.method(player, 'getSession', () => ({ sendClientPacket: () => true, write: () => true }));
    t.mock.method(player, 'sendMessage', () => {});
    let logouts = 0;
    t.mock.method(player, 'requestLogout', () => { logouts++; });
    player.setAutoRetaliate(true);
    player.getInventory().adds(core.ItemIdentifiers.SHARK, 5);
    const state = { mode: 'pvp', home: { x: 3363, y: 4037, z: 0 }, pvp: { profileId: 'standard', riskTolerance: 0.3 } };
    runtime.botStatesByName.set(name, state);
    bh.arena.add(player);
    t.after(() => { player.setRegistered(false); bh.arena.delete(player); bh.lobby.delete(player); clearMovementRequest(player); });
    const node = new PvpDefensiveActionNode({
      api, setPhase: (state, phase) => { state.pvp.phase = phase; }, stopPvp: () => { state.recoveries = (state.recoveries ?? 0) + 1; },
    });
    return { player, state, node, logouts: () => logouts, tick: (nowMs = 1000) => node.tick({ player, state, nowMs, target: null }) };
  }

  await t.test('early retreat stays committed, eats while running and respects the real gate before logout', (t) => {
    const f = fixture(t, 'bh_flee');
    t.mock.method(Math, 'random', () => 0.99);
    assert.equal(f.tick().handled, true);
    const retreat = f.state.pvp.retreat;
    assert.ok(retreat, 'a low-food bot can leave before its last meal');
    assert.equal(f.player.autoRetaliateReturn(), false);
    let request = peekMovementRequest(f.player);
    const exit = bh.CRATER.exits.find((exit) => exit.x === request?.x && exit.y === request?.y);
    assert.ok(exit, 'the pending long walk targets an actual arena exit');
    assert.equal(f.player.getInventory().getAmount(core.ItemIdentifiers.SHARK), 5, 'standing at its spawn never refits the bot');

    const quarry = new Player(null);
    quarry.setUsername('new_quarry');
    quarry.setRegistered(true);
    Bots._test.huntTarget({ player: f.player, target: quarry });
    Bots._test.dropTarget({ player: f.player });
    assert.equal(f.state.pvp.retreat, retreat, 'matchmaking cannot reset a committed escape');

    f.player.getSkillManager().setMaxLevel(core.Skill.HITPOINTS, 99);
    f.player.setHitpoints(20);
    const support = {
      maintainCombatBoostsActionNode: { tick: () => 'failure' }, defensiveActionNode: f.node,
      eatFoodActionNode: new EatFoodActionNode(runtime.botStatesByName, api),
      botStatesByName: runtime.botStatesByName, behaviorMode: { PVP: 'pvp' }, resolveTargetPlayer: () => null,
    };
    assert.equal(PvpController.prototype.tickSupport.call(support, { player: f.player, state: f.state, nowMs: 1600 }).skip, true);
    assert.equal(f.player.getInventory().getAmount(core.ItemIdentifiers.SHARK), 4, 'normal support still consumes real food while fleeing');
    assert.ok(f.player.getHitpoints() > 20);
    f.player.getInventory().deleteNumber(core.ItemIdentifiers.SHARK, 4);
    f.tick(60000);
    assert.equal(f.state.pvp.retreat, retreat, 'running out does not restart or reverse the escape');
    assert.equal(f.player.getInventory().getAmount(core.ItemIdentifiers.SHARK), 0);
    request = peekMovementRequest(f.player);
    assert.deepEqual([request.x, request.y], [exit.x, exit.y]);

    let cycle = 100;
    t.mock.method(core.World, 'getProcessCycle', () => cycle);
    bh.lastSpecialAt.set(f.player, cycle);
    f.player.moveTo(new core.Location(exit.x, exit.y));
    f.tick(60600);
    assert.equal(bh.isArenaTile(f.player.getLocation()), true, 'the real recent-special restriction still applies');
    assert.equal(f.logouts(), 0, 'no logout while still vulnerable');
    cycle += 6;
    f.tick(64200);
    assert.equal(bh.isLobbyTile(f.player.getLocation()), true, 'the gate, rather than a teleport, enters the fort');
    f.tick(64800);
    f.tick(65400);
    assert.equal(f.logouts(), 1);
    assert.equal(peekMovementRequest(f.player), null);
    assert.equal(f.player.getInventory().getAmount(core.ItemIdentifiers.SHARK), 0, 'escaping never regenerates supplies');
    assert.equal(f.state.recoveries ?? 0, 0);
    quarry.setRegistered(false);
  });

  await t.test('a bot that chooses to fight is not rerolled into retreat or refitted when empty', (t) => {
    const f = fixture(t, 'bh_stay');
    let rolls = 0;
    t.mock.method(Math, 'random', () => { rolls++; return 0; });
    for (const count of [5, 4, 1, 0]) {
      f.player.getInventory().deleteNumber(core.ItemIdentifiers.SHARK, 5);
      if (count) f.player.getInventory().adds(core.ItemIdentifiers.SHARK, count);
      assert.equal(f.tick().handled, false);
      assert.equal(f.state.pvp.retreat ?? null, null);
    }
    assert.equal(rolls, 1, 'one personality decision for the whole low-food episode');
    assert.equal(peekMovementRequest(f.player), null);
    assert.equal(f.logouts(), 0);
    assert.equal(f.player.getInventory().getAmount(core.ItemIdentifiers.SHARK), 0);
    f.player.getInventory().adds(core.ItemIdentifiers.SHARK, 7);
    f.tick();
    f.player.getInventory().deleteNumber(core.ItemIdentifiers.SHARK, 1);
    f.tick();
    assert.equal(rolls, 2, 'only a new supply episode permits another decision, including at six meals');
  });

  await t.test('death clears the escape and the next life can make a new decision', (t) => {
    const f = fixture(t, 'bh_death');
    t.mock.method(Math, 'random', () => 0.99);
    t.mock.method(core.TaskManager, 'submit', () => {});
    f.tick();
    assert.ok(f.state.pvp.retreat);
    f.player.setHitpoints(0);
    assert.equal(f.state.pvp.retreat, null);
    assert.equal(f.player.autoRetaliateReturn(), true);
    assert.equal(f.tick().handled, true);
    assert.equal(f.logouts(), 0);
    assert.equal(peekMovementRequest(f.player), null);
    f.player.resetAttributes();
    f.tick(2000);
    assert.ok(f.state.pvp.retreat, 'respawning does not inherit the previous retreat decision');
  });

  await t.test('a bare new life retains the actual PvP kit recovery before deciding whether to flee', (t) => {
    const f = fixture(t, 'bh_regear');
    f.player.getInventory().resetItems();
    assert.equal(f.tick().status, 'success');
    assert.equal(f.state.recoveries, 1);
    assert.equal(f.state.pvp.retreat, null);
    assert.ok(f.player.getInventory().getValidItems().length > 6);
    assert.ok(f.player.getEquipment().getValidItems().length > 0);
    assert.equal(f.logouts(), 0);
  });

  await t.test('a transiently failed shared regear keeps owning its retreat until it finishes', (t) => {
    const f = fixture(t, 'bh_pending');
    const errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args));
    f.player.getInventory().resetItems();
    const classification = t.mock.method(f.player, 'isPlayerBot', () => false);
    assert.equal(f.tick().status, 'running');
    const recovery = f.state.pvp.retreat;
    assert.ok(recovery);
    assert.equal(recovery.exit, undefined);
    assert.equal(f.tick(1600).status, 'running');
    assert.equal(f.state.pvp.retreat, recovery);
    classification.mock.restore();
    assert.equal(f.tick(2200).status, 'success');
    assert.equal(f.state.pvp.retreat, null);
    assert.equal(f.state.recoveries, 1);
    assert.ok(f.player.getEquipment().getValidItems().length > 0);
    assert.equal(f.logouts(), 0);
    assert.deepEqual(errors, [], 'the custom hook never claims a pending shared recovery');
  });

  for (const [index, exit] of bh.CRATER.exits.entries()) await t.test(`actual map retreat reaches gate ${index + 1} from the arena side`, (t) => {
    const f = fixture(t, `bh_map_${index}`);
    t.mock.method(Math, 'random', () => 0.99);
    let cycle = 1000;
    t.mock.method(core.World, 'getProcessCycle', () => cycle);
    const x = exit.x + Math.sign(exit.x - exit.to.x) * 5;
    const y = exit.y + Math.sign(exit.y - exit.to.y) * 5;
    f.player.moveTo(new core.Location(x, y));
    f.player.setNeedsPlacement(false);
    core.RegionManager.loadMapFiles(exit.x, exit.y);
    assert.equal(core.RegionManager.blocked(f.player.getLocation(), null), false);
    f.tick(cycle * 600);
    const request = peekMovementRequest(f.player);
    assert.deepEqual([request.x, request.y], [exit.x, exit.y]);
    const routed = dispatchMovementRequest(f.player, request, f.state);
    assert.equal(routed.hasRoute, true, 'actual clipping must yield a reachable approach to the solid gate');
    const queue = f.player.getMovementQueue();
    for (let step = 0; step < 12 && !bh.isLobbyTile(f.player.getLocation()); step++) {
      cycle++;
      queue.beginCycle();
      queue.process();
      assert.equal(core.RegionManager.blocked(f.player.getLocation(), null), false, 'the bot never stands on the solid gate');
      f.tick(cycle * 600);
    }
    assert.equal(bh.isLobbyTile(f.player.getLocation()), true, 'real movement reaches canonical object-operating distance');
    assert.deepEqual([f.player.getLocation().getX(), f.player.getLocation().getY()], [exit.to.x, exit.to.y]);
    f.tick((cycle + 1) * 600);
    assert.equal(f.logouts(), 1);
  });
});
