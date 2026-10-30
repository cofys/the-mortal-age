// Real actors, shipyard owner, currency containers and dialogue manager; network only is stubbed.
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, test } = require('node:test');
const ROOT = path.resolve(__dirname, '..');
require('../dist/Server').Server.installProductionPathResolver();
const { PluginManager: PM } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { MultiChatboxPrompt } = require('../dist/game/model/menu/MultiChatboxPrompt');
let core, yard, hp, index = 1700;
before(async () => {
  await require('../dist/game/cache/CachePipeline').CachePipeline.initialize(ROOT);
  PM.loadFromDirectory(path.join(ROOT, 'plugins'));
  core = PM.getCoreApi();
  new (require('../dist/game/definition/loader/impl/NpcDefinitionLoader').NpcDefinitionLoader)().load();
  core.RegionManager.init(); PM.emitServerStartup({});
  yard = require('../plugins/skills/sailing/Shipyard.plugin');
  hp = require('../plugins/skills/sailing/seacombat/BoatHp.SeaCombat');
});
function freshPlayer(t) {
  const p = new Player(null); p.setIndex(index++); p.setUsername('SebRepair' + index); p.setRegistered(true);
  p.setAttribute('bot-skip-persistence', true);
  const packets = [];
  p.getSession = () => ({ sendClientPacket(packet) { packets.push(packet); return true; }, write() { return true; }, getChannel() { return null; } });
  t.after(() => { PM.emitPlayerLogout({ player: p, username: p.getUsername() }); core.TaskManager.cancelTasks(p); p.setRegistered(false); });
  return { p, packets };
}
function fixture(t, damage = 10) {
  const { p, packets } = freshPlayer(t);
  p.getSkillManager().setCurrentLevel(core.Skill.SAILING, 99);
  core.Sailing.giveBoat(p, 'skiff', 'the_pandemonium');
  yard.beginVisit(p, core.Sailing.getDock('the_pandemonium'), 0);
  p.setNeedsPlacement(false);
  const boat = yard.visitedBoat(p); boat.damage = damage; hp.sendHitpoints(p, boat);
  const sebId = core.CacheDefinitions.getNpcId('sailing_shipyard_manager_vis');
  const npc = core.NPC.create(sebId, p.getLocation().transform(1, 0)); npc.setRegistered(true);
  const coins = core.CacheDefinitions.getObjId('coins'); p.getInventory().add(new core.Item(coins, 1000));
  t.after(() => npc.setRegistered(false));
  const click = option => PM.emitNpcInteraction({ player: p, npc, npcId: sebId,
    definition: npc.getCurrentDefinition(p), option, clickType: option === 'Talk-to' ? 1 : 4, handled: false });
  return { p, npc, boat, coins, packets, click };
}
function prompt(p) {
  for (let i = 0; i < 12; i++) {
    const pending = MultiChatboxPrompt.getPending(p);
    if (pending) return pending;
    const current = p.getDialogueManager().getCurrent();
    assert.ok(current, 'repair dialogue must reach its confirmation');
    const group = current.groupId ?? current.constructor.GROUP_ID;
    if (group) assert.equal(p.getDialogueManager().handleResume((group << 16) | 5, 0), true);
    else p.getDialogueManager().advance();
  }
  assert.fail('repair confirmation did not appear');
}
function choose(p, number) {
  assert.equal(PM.emitInterfaceActionClick({ player: p, buttonId: MultiChatboxPrompt.OPTIONS_WIDGET_ID,
    groupId: 219, childId: 1, action: number, handled: false }), true);
}
function replay(p, number) {
  return PM.emitInterfaceActionClick({ player:p, buttonId:MultiChatboxPrompt.OPTIONS_WIDGET_ID,
    groupId:219, childId:1, action:number, handled:false });
}
function bankCoins(f, amount) {
  f.p.getBank(0).open();
  core.Bank.deposit(f.p, f.coins, f.p.getInventory().getSlotForItemId(f.coins), amount, false);
  f.p.getPacketSender().sendInterfaceRemoval();
  const bank = f.p.getBank(core.Bank.getTabForItem(f.p, f.coins));
  assert.equal(bank.getAmount(f.coins), amount, 'real bank transfer prepared the funds');
  return bank;
}
function ticks(count) { while (count--) { ++core.World.processCycle; core.TaskManager.process(); } }
test('Seb Repair-boat quotes and atomically charges/heals the actual visited boat', t => {
  const f = fixture(t);
  assert.equal(f.click('Repair-boat'), true, 'native Seb repair option must be handled');
  const menu = prompt(f.p);
  assert.match(menu.title, /500 coins/);
  assert.deepEqual(menu.options, ['Yes.', "Yes, and don't ask again.", 'No.']);
  choose(f.p, 1);
  assert.equal(f.boat.damage, 0);
  assert.equal(f.p.getInventory().getAmount(f.coins), 500);
  assert.equal(f.p.getPacketSender().getVarbit(core.CacheDefinitions.getVarbitId('sailing_boat_1_stored_hp')), hp.maxHitpoints(f.boat));
});
test('boundary: canonical Talk-to repair choice reaches the same quote and No preserves funds/boat', t => {
  const f = fixture(t); f.click('Talk-to');
  const menu = prompt(f.p);
  const repairIndex = menu.options.indexOf('Could you help me repair my boat?');
  assert.ok(repairIndex >= 0);
  assert.ok(menu.options.includes('What do you have for sale?'));
  choose(f.p, repairIndex + 1); assert.match(prompt(f.p).title, /500 coins/);
  choose(f.p, 3);
  assert.equal(f.boat.damage, 10); assert.equal(f.p.getInventory().getAmount(f.coins), 1000);
});
test('boundary: whole bank payment follows a real transfer, and insufficient sources are not combined', t => {
  const f = fixture(t), bank = bankCoins(f, 600);
  f.click('Repair-boat'); prompt(f.p); choose(f.p, 1);
  assert.equal(f.boat.damage, 0); assert.equal(bank.getAmount(f.coins), 100);
  assert.equal(f.p.getInventory().getAmount(f.coins), 400);
  const g = fixture(t), otherBank = bankCoins(g, 200);
  g.p.getInventory().deleteNumber(g.coins, 400);
  g.click('Repair-boat'); prompt(g.p); choose(g.p, 1);
  assert.equal(g.boat.damage, 10); assert.equal(g.p.getInventory().getAmount(g.coins), 400);
  assert.equal(otherBank.getAmount(g.coins), 200);
});
test('boundary: changed damage, a real replacement visit, teleport and death invalidate the quoted repair', t => {
  for (const transition of ['damage', 'visit', 'teleport', 'death']) {
    const f = fixture(t); f.click('Repair-boat'); prompt(f.p);
    let other;
    if (transition === 'damage') hp.damage(f.p, f.boat, 1);
    if (transition === 'visit') {
      other = core.Sailing.giveBoat(f.p, 'raft', 'the_pandemonium'); other.damage = 2;
      yard.beginVisit(f.p, core.Sailing.getDock('the_pandemonium'), other.slot); f.p.setNeedsPlacement(false);
    }
    if (transition === 'teleport') f.p.moveTo(new core.Location(3050, 2995, 0));
    if (transition === 'death') f.p.setHitpoints(0);
    const before = f.boat.damage; replay(f.p, 1);
    assert.equal(f.boat.damage, before, transition); assert.equal(f.p.getInventory().getAmount(f.coins), 1000, transition);
    if (other) assert.equal(other.damage, 2);
  }
});
test('boundary: healthy boat is free and a repeated old resume cannot charge twice', t => {
  const f = fixture(t, 0); f.click('Repair-boat');
  assert.match(f.p.getDialogueManager().getCurrent().getText(), /fine and dandy/);
  assert.equal(MultiChatboxPrompt.getPending(f.p), null);
  assert.equal(f.p.getInventory().getAmount(f.coins), 1000);
  const g = fixture(t); g.click('Repair-boat'); prompt(g.p); choose(g.p, 1);
  assert.equal(replay(g.p, 1), false);
  assert.equal(g.boat.damage, 0); assert.equal(g.p.getInventory().getAmount(g.coins), 500);
});
test('boundary: replacing the confirmation with the real bank UI prevents old payment', t => {
  const f = fixture(t); f.click('Repair-boat'); prompt(f.p);
  f.p.getBank(0).open(); assert.equal(replay(f.p, 1), false);
  assert.equal(f.boat.damage, 10); assert.equal(f.p.getInventory().getAmount(f.coins), 1000);
});
test('boundary: actual trade acceptance invalidates the old repair confirmation', t => {
  const f = fixture(t), g = fixture(t);
  f.click('Repair-boat'); prompt(f.p);
  f.p.getTrading().requestTrade(g.p); g.p.getTrading().requestTrade(f.p);
  assert.ok(f.p.busy(), 'real trade starts');
  assert.equal(replay(f.p, 1), false);
  assert.equal(f.boat.damage, 10); assert.equal(f.p.getInventory().getAmount(f.coins), 1000);
  f.p.getTrading().closeTrade();
});
test('boundary: persisted no-warning choice restores its cache flag and still charges the next real repair', t => {
  const f = fixture(t); f.click('Repair-boat'); prompt(f.p); choose(f.p, 2);
  const { PlayerSave } = require('../dist/game/entity/impl/player/persistence/PlayerSave');
  const save = PlayerSave.fromPlayer(f.p), { p } = freshPlayer(t); save.applyToPlayer(p);
  PM.emitPlayerLogin({player:p,username:p.getUsername(),isNewAccount:false});
  const warning = core.CacheDefinitions.getVarbitId('boat_repair_cost_warning_dismissed');
  assert.equal(p.getPacketSender().getVarbit(warning), 1);
  yard.beginVisit(p, core.Sailing.getDock('the_pandemonium'), 0); p.setNeedsPlacement(false);
  const boat = yard.visitedBoat(p); hp.damage(p, boat, 4);
  assert.equal(PM.emitNpcInteraction({player:p,npc:f.npc,npcId:f.npc.getId(),definition:f.npc.getCurrentDefinition(p),option:'Repair-boat',clickType:4,handled:false}),true);
  assert.equal(boat.damage, 0); assert.equal(p.getInventory().getAmount(f.coins), 300);
  assert.equal(MultiChatboxPrompt.getPending(p), null);
});
test('boundary: real PIN entry resumes one repair, and a replaced visit while PIN waits stays untouched', t => {
  const Pin = require('../plugins/interface/bankpin/Common.BankPin');
  for (const replace of [false, true]) {
    const f = fixture(t), bank = bankCoins(f, 1000);
    Pin.set(f.p, 'hash', Pin.hash(f.p, '2468')); Pin.lock(f.p);
    f.click('Repair-boat'); prompt(f.p); choose(f.p, 1);
    assert.equal(f.boat.damage, 10); assert.equal(bank.getAmount(f.coins), 1000);
    const entry = f.p.getEnteredAmountAction(); assert.ok(entry, 'actual PIN keypad is waiting');
    if (replace) {
      const other = core.Sailing.giveBoat(f.p, 'raft', 'the_pandemonium');
      yard.beginVisit(f.p, core.Sailing.getDock('the_pandemonium'), other.slot); f.p.setNeedsPlacement(false);
    }
    f.p.setEnteredAmountAction(null); entry.execute(2468); ticks(3);
    assert.equal(f.boat.damage, replace ? 10 : 0);
    assert.equal(bank.getAmount(f.coins), replace ? 1000 : 500);
    assert.equal(f.p.getInventory().getAmount(f.coins), 0);
  }
});
