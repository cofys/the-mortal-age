// Run after `yarn build`: node --test tests/fossil-storage.test.cjs
//
// Fossil Island's fossil storage and cleaning bench against rsprox (231/00711-00712, 227/00073,
// 227/01843, 227/01862) and the Wiki, with a real Player, Inventory and Equipment.
const assert = require('node:assert/strict');
const { test, before } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { TaskManager } = require('../dist/game/task/TaskManager');
const { Location } = require('../dist/game/model/Location');

let Fossils, core;
const events = new Map();
const buttons = new Map();
const hooks = {};

before(() => {
  CachePipeline.initialize();
  core = PluginManager.getCoreApi();
  const api = new Proxy({
    core,
    onCustomEvent: (name, fn) => events.set(name, fn),
    emitCustomEvent: (name, request) => events.get(name)?.(request),
    onObjectInteraction: (name, actions) => { hooks[name] = actions; },
    onItemOnObject: (fn) => { hooks.itemOnObject = fn; },
    onInterfaceActionButton: (id, fn) => buttons.set(id, fn),
    onPlayerLogin: (fn) => { hooks.login = fn; },
  }, { get: (target, key) => (key in target ? target[key] : () => {}) });
  require('../plugins/world/Museum.plugin').register(api);
  require('../plugins/interface/BankPin.plugin').register(api);
  Fossils = require('../plugins/areas/FossilStorage.plugin');
  Fossils.register(api);
});

const obj = (name) => core.CacheDefinitions.getObjId(name);
const uid = (group, child) => (group << 16) | child;

let nextIndex = 900;
function player(t) {
  const { Player } = require('../dist/game/entity/impl/player/Player');
  const p = new Player(null);
  p.lines = [];
  p.varbits = new Map();
  p.boxes = [];
  t.mock.method(p, 'getSession', () => ({ sendClientPacket: () => true, write: () => true }));
  t.mock.method(p.getInventory(), 'refreshItems', () => p.getInventory());
  t.mock.method(p, 'sendMessage', (m) => p.lines.push(m));
  t.mock.method(p.getPacketSender(), 'sendVarbit', (id, v) => { p.varbits.set(id, v); return p.getPacketSender(); });
  t.mock.method(p, 'getDialogueManager', () => ({ startDialogues: (b) => { for (const d of b.getDialogues().values()) p.boxes.push(d.getText?.()); } }));
  p.setIndex(++nextIndex); // a world slot, as every logged-in player has
  p.setRegistered(true);
  t.after(() => p.setRegistered(false));
  return p;
}

const give = (p, name, n = 1) => { for (let i = 0; i < n; i++) p.getInventory().add(new core.Item(obj(name), 1)); };
const has = (p, name) => p.getInventory().getAmount(obj(name));
const attr = (name) => Fossils.STORED_ATTRIBUTE[name];
const stored = (p, name) => p.getAttribute(attr(name)) ?? 0;
const openCrate = (p) => hooks['Fossil Storage'].Open({ player: p });
const press = (p, group, child, op, slot) => buttons.get(uid(group, child))({ player: p, opId: op, action: op, slot });
const slotOf = (p, name) => p.getInventory().getItems().findIndex((item) => item?.getId() === obj(name));

test('Deposit 1 from the side panel: "You store Unidentified small fossil x 1." and its varbit', (t) => {
  const p = player(t);
  give(p, 'fossil_small_unid', 3);
  openCrate(p);
  assert.equal(p.getInterfaceId(), 605, 'the crate is open');
  assert.ok(p.getPacketSender().isSubInterfaceOpen(610), 'its inventory panel is mounted in the side modal, as recorded');
  press(p, 610, 0, 1, slotOf(p, 'fossil_small_unid'));
  assert.deepEqual(p.lines, ['You store Unidentified small fossil x 1.']);
  assert.equal(stored(p, 'fossil_small_unid'), 1);
  assert.equal(p.varbits.get(core.CacheDefinitions.getVarbitId('fossil_storage_small_unid')), 1);
  assert.equal(has(p, 'fossil_small_unid'), 2);
  press(p, 610, 0, 4, slotOf(p, 'fossil_small_unid'));
  assert.equal(stored(p, 'fossil_small_unid'), 3, 'Deposit All of that type');
});

test('the Deposit All button takes every fossil and leaves the rest, without a message (231/00712)', (t) => {
  const p = player(t);
  give(p, 'fossil_small_2', 2);
  give(p, 'fossil_medium_unid', 1);
  p.getInventory().add(new core.Item(obj('fossil_calcite'), 82));
  openCrate(p);
  press(p, 605, 6, 1);
  assert.equal(stored(p, 'fossil_small_2'), 2);
  assert.equal(stored(p, 'fossil_medium_unid'), 1);
  assert.equal(p.getInventory().getAmount(obj('fossil_calcite')), 82, 'calcite stays');
  assert.deepEqual(p.lines, []);
});

test('withdrawing from the list: 1 with the recorded line, All, and Withdraw All; a full pack keeps them stored', (t) => {
  const p = player(t);
  p.setAttribute(attr('fossil_small_1'), 10);
  p.setAttribute(attr('fossil_small_unid'), 9);
  openCrate(p);
  press(p, 605, 11, 1, 0);
  assert.deepEqual(p.lines, ['You withdraw Small fossilised limbs x 1.']);
  assert.equal(has(p, 'fossil_small_1'), 1);
  assert.equal(stored(p, 'fossil_small_1'), 9);
  press(p, 605, 11, 4, 26);
  assert.equal(p.lines.at(-1), 'You withdraw Unidentified small fossil x 9.');
  press(p, 605, 4, 1);
  assert.equal(stored(p, 'fossil_small_1'), 0);
  assert.equal(has(p, 'fossil_small_1'), 10);
  const full = player(t);
  for (let i = 0; i < 28; i++) full.getInventory().add(new core.Item(1511, 1));
  full.setAttribute(attr('fossil_rare_6'), 2);
  openCrate(full);
  press(full, 605, 11, 1, 25);
  assert.equal(stored(full, 'fossil_rare_6'), 2, 'kept in the crate');
  assert.equal(full.lines.at(-1), "You don't have enough inventory space.");
});

test('510 of each type at most (Wiki); clicks with the crate closed do nothing; login sends the counts', (t) => {
  const p = player(t);
  p.setAttribute(attr('fossil_small_3'), 509);
  give(p, 'fossil_small_3', 3);
  openCrate(p);
  press(p, 610, 0, 4, slotOf(p, 'fossil_small_3'));
  assert.equal(stored(p, 'fossil_small_3'), 510);
  assert.equal(has(p, 'fossil_small_3'), 2);
  press(p, 610, 0, 1, slotOf(p, 'fossil_small_3'));
  assert.equal(p.lines.at(-1), "Your fossil storage can't hold any more of those.");
  const closed = player(t);
  give(closed, 'fossil_small_3', 1);
  press(closed, 610, 0, 1, slotOf(closed, 'fossil_small_3'));
  assert.equal(stored(closed, 'fossil_small_3'), 0, 'not open');
  const back = player(t);
  back.setAttribute(attr('fossil_plant_4'), 7);
  hooks.login({ player: back });
  assert.equal(back.varbits.get(core.CacheDefinitions.getVarbitId('fossil_storage_plant_4')), 7);
});

test('a fossil used on a crate goes straight in (Wiki)', (t) => {
  const p = player(t);
  give(p, 'fossil_rare_unid', 2);
  hooks.itemOnObject({ player: p, itemId: obj('fossil_rare_unid'), object: { getId: () => core.CacheDefinitions.getLocId('fossil_storage_crate2') }, handled: false });
  assert.equal(stored(p, 'fossil_rare_unid'), 2);
  assert.equal(p.lines.at(-1), 'You store Unidentified rare fossil x 2.');
});

function kit(p) {
  for (const name of ['trowel', 'rock_pick', 'specimen_brush']) {
    const id = obj(name) ?? { trowel: 676, rock_pick: 675, specimen_brush: 670 }[name];
    p.getInventory().add(new core.Item(id, 1));
  }
  const { Equipment } = require('../dist/game/model/container/impl/Equipment');
  p.getEquipment().setItem(Equipment.HANDS_SLOT, new core.Item(1059, 1));
  p.getEquipment().setItem(Equipment.FEET_SLOT, new core.Item(1061, 1));
}

const bench = () => ({ getId: () => core.CacheDefinitions.getLocId('fossil_cleaning_bench'), getLocation: () => new Location(3752, 3804, 0) });

test('the bench: without the kit, the recorded message box; with it, every unidentified fossil, one each 6 ticks, in its own slot', (t) => {
  const p = player(t);
  p.moveTo(new Location(3752, 3805, 0));
  p.setAttribute(Fossils.BENCH_BUILT_ATTRIBUTE, 1);
  give(p, 'fossil_small_unid', 3);
  hooks.itemOnObject({ player: p, itemId: obj('fossil_small_unid'), object: bench(), handled: false });
  assert.match(p.boxes[0], /^You will need a full archaeology kit to clean your finds\./);
  kit(p);
  const slots = p.getInventory().getItems().map((item, slot) => (item?.getId() === obj('fossil_small_unid') ? slot : -1)).filter((s) => s >= 0);
  hooks.itemOnObject({ player: p, itemId: obj('fossil_small_unid'), object: bench(), handled: false });
  const cleanedAt = [];
  for (let tick = 1; tick <= 14; tick++) {
    const before = has(p, 'fossil_small_unid');
    TaskManager.process();
    if (has(p, 'fossil_small_unid') < before) cleanedAt.push(tick);
  }
  assert.deepEqual(cleanedAt, [1, 7, 13]);
  const small = ['fossil_small_1', 'fossil_small_2', 'fossil_small_3', 'fossil_small_4', 'fossil_small_5'].map(obj);
  for (const slot of slots) assert.ok(small.includes(p.getInventory().getItems()[slot].getId()), 'cleaned in its own slot');
  assert.ok(p.lines.every((line) => /^You clean the fossil with your (brush|rock pick)\.$/.test(line)));
});

test("the bench's own option and a non-fossil get the recorded lines; a large fossil may be a plant fossil", (t) => {
  const p = player(t);
  p.setAttribute(Fossils.BENCH_BUILT_ATTRIBUTE, 1);
  hooks['Fossil cleaning bench'].Use({ player: p, object: bench() });
  assert.deepEqual(p.lines, ['Use your fossil on the bench to clean it.']);
  hooks.itemOnObject({ player: p, itemId: obj('fossil_calcite'), object: bench(), handled: false });
  assert.equal(p.lines.at(-1), 'Nothing interesting happens.');
  assert.deepEqual(Fossils.DATA.cleaning.fossil_large_unid.map((set) => set[0]), ['fossil_large_1', 'fossil_plant_1'], 'half and half (Wiki)');
});

test('the bench starts as table parts: no cleaning until it is built (Wiki: 5 planks, 5 nails, a hammer, 5 Construction, 100 XP)', (t) => {
  const p = player(t);
  give(p, 'fossil_small_unid', 1);
  kit(p);
  const event = { player: p, itemId: obj('fossil_small_unid'), object: bench(), handled: false };
  hooks.itemOnObject(event);
  assert.equal(event.handled, false, 'unbuilt: not the bench yet');
  hooks['Table parts'].Build({ player: p, object: bench() });
  assert.equal(p.lines.at(-1), 'You need a Construction level of 5 to build the cleaning bench.');
  p.getSkillManager().setCurrentLevel(core.Skill.CONSTRUCTION, 5, false);
  hooks['Table parts'].Build({ player: p, object: bench() });
  assert.equal(p.lines.at(-1), 'You need 5 planks, 5 nails and a hammer to build the cleaning bench.');
  p.getInventory().add(new core.Item(obj('woodplank'), 1));
  for (let i = 0; i < 4; i++) p.getInventory().add(new core.Item(obj('woodplank'), 1));
  p.getInventory().add(new core.Item(obj('nails_iron'), 5));
  p.getInventory().add(new core.Item(obj('hammer'), 1));
  const xp = p.getSkillManager().getExperience(core.Skill.CONSTRUCTION);
  hooks['Table parts'].Build({ player: p, object: bench() });
  assert.equal(p.lines.at(-1), 'You build the cleaning bench.');
  assert.equal(p.getAttribute(Fossils.BENCH_BUILT_ATTRIBUTE), 1);
  assert.equal(p.varbits.get(core.CacheDefinitions.getVarbitId('fossil_bench')), 1);
  assert.equal(p.getInventory().getAmount(obj('woodplank')), 0);
  assert.equal(p.getInventory().getAmount(obj('nails_iron')), 0);
  assert.equal(p.getInventory().getAmount(obj('hammer')), 1, 'the hammer is kept');
  assert.ok(p.getSkillManager().getExperience(core.Skill.CONSTRUCTION) > xp, 'Construction XP');
});

test("walking off or fighting stops the cleaning (the player's tasks are cancelled by index)", (t) => {
  const p = player(t);
  p.moveTo(new Location(3752, 3805, 0));
  p.setAttribute(Fossils.BENCH_BUILT_ATTRIBUTE, 1);
  give(p, 'fossil_small_unid', 3);
  kit(p);
  hooks.itemOnObject({ player: p, itemId: obj('fossil_small_unid'), object: bench(), handled: false });
  TaskManager.process();
  assert.equal(has(p, 'fossil_small_unid'), 2, 'the first is cleaned');
  TaskManager.cancelTasks(p.getIndex());
  for (let i = 0; i < 14; i++) TaskManager.process();
  assert.equal(has(p, 'fossil_small_unid'), 2, 'the rest stay unidentified');
});

test('Build is only for the cleaning bench, not other table parts', (t) => {
  const p = player(t);
  assert.equal(hooks['Table parts'].Build({ player: p, object: { getId: () => 1 } }), false);
  assert.deepEqual(p.lines, []);
});

const BankPinCommon = () => require('../plugins/interface/bankpin/Common.BankPin');

/** A PIN set and this session locked, as after a login. */
function withPin(p, pin = '1234') {
  p.setUsername('fossilpin');
  BankPinCommon().set(p, 'hash', BankPinCommon().hash(p, pin));
  BankPinCommon().lock(p);
}

test('the Bank PIN guards the crate (Wiki): locked, the keypad opens instead and withdrawals move nothing', (t) => {
  const p = player(t);
  p.setAttribute(attr('fossil_small_1'), 3);
  withPin(p);
  openCrate(p);
  assert.notEqual(p.getInterfaceId(), 605, 'not the crate');
  assert.equal(p.getInterfaceId(), 213, 'the Bank PIN keypad');
  p.getPacketSender().sendInterface(605); // a forged open: clicks still check the PIN
  press(p, 605, 11, 1, 0);
  press(p, 605, 4, 1);
  assert.equal(stored(p, 'fossil_small_1'), 3);
  assert.equal(has(p, 'fossil_small_1'), 0);
});

test('the right PIN opens the crate a tick later and withdrawals work; with no PIN it opens at once', (t) => {
  const p = player(t);
  p.setAttribute(attr('fossil_small_1'), 3);
  withPin(p);
  openCrate(p);
  p.getEnteredAmountAction().execute(1234);
  assert.ok(p.lines.includes('You have correctly entered your PIN.'));
  TaskManager.process();
  TaskManager.process();
  assert.equal(p.getInterfaceId(), 605, 'resumed into the crate');
  press(p, 605, 11, 1, 0);
  assert.equal(stored(p, 'fossil_small_1'), 2);
  const open = player(t);
  openCrate(open);
  assert.equal(open.getInterfaceId(), 605, 'no PIN: straight in');
});
