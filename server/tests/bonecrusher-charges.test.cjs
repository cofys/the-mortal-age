const assert = require('node:assert/strict');
const { before, test } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { Skill } = require('../dist/game/model/Skill');
const { Item } = require('../dist/game/model/Item');
const { Bank } = require('../dist/game/model/container/impl/Bank');
const { ItemOnGroundManager } = require('../dist/game/entity/impl/grounditem/ItemOnGroundManager');
const { ItemIdentifiers: I } = require('../dist/util/ItemIdentifiers');
const events = new Map();
let charge;
const api = new Proxy({
  core: PluginManager.getCoreApi(),
  persistAttribute() {},
  onItemOnItem(a, b, handler) { charge = handler; },
  onCustomEvent(name, handler) { events.set(name, [...(events.get(name) ?? []), handler]); },
  emitCustomEvent(name, event) { for (const handler of events.get(name) ?? []) handler(event); },
}, { get: (target, key) => target[key] ?? (() => {}) });
before(async () => {
  await CachePipeline.initialize(process.cwd());
  require('../plugins/skills/Prayer.plugin').register(api);
  require('../plugins/items/Bonecrusher.plugin').register(api);
});
function player(t, stored = 0) {
  const p = new Player(null);
  const sender = new Proxy({}, { get: () => () => sender });
  t.mock.method(p, 'getPacketSender', () => sender);
  t.mock.method(p, 'sendMessage', () => {});
  p.setAttribute('bonecrusher:charges', stored);
  return p;
}
function destroyed(p, itemId = I.BONECRUSHER) {
  api.emitCustomEvent('destroy-item:destroyed', { player: p, itemId, amount: 1 });
}
test('destroying the bonecrusher drops whole ecto-tokens and clears the remainder', t => {
  const p = player(t, 74), drops = [];
  t.mock.method(ItemOnGroundManager, 'registers', (owner, item) => { drops.push([owner, item]); });
  destroyed(p);
  assert.equal(p.getAttribute('bonecrusher:charges'), 0);
  assert.equal(drops.length, 1);
  assert.equal(drops[0][0], p);
  assert.equal(drops[0][1].getId(), I.ECTO_TOKEN);
  assert.equal(drops[0][1].getAmount(), 2);
  destroyed(p);
  assert.equal(drops.length, 1, 'a repeated notification cannot refund twice');
});
test('destroying fractional-token charges loses them without creating a zero stack', t => {
  const p = player(t, 24);
  t.mock.method(ItemOnGroundManager, 'registers', () => assert.fail('no whole token to drop'));
  destroyed(p);
  assert.equal(p.getAttribute('bonecrusher:charges'), 0);
});
test('destroying another item leaves bonecrusher charges intact', t => {
  const p = player(t, 74);
  destroyed(p, I.BONES);
  assert.equal(p.getAttribute('bonecrusher:charges'), 74);
});
test('charging can reach the cache charge cap with a partial final token', t => {
  const p = player(t, 2147483625);
  p.getInventory().add(new Item(I.ECTO_TOKEN, 1));
  charge({ player: p });
  assert.equal(p.getAttribute('bonecrusher:charges'), 2147483647);
  assert.equal(p.getInventory().getAmount(I.ECTO_TOKEN), 0);
  p.getInventory().add(new Item(I.ECTO_TOKEN, 1));
  charge({ player: p });
  assert.equal(p.getInventory().getAmount(I.ECTO_TOKEN), 1, 'full crusher consumes nothing');
});
function configure(t, p, target) {
  t.mock.method(Bank, 'isOpen', () => true);
  p.getBank(0).add(new Item(I.BONECRUSHER, 1), false);
  const item = p.getBank(0).getItems().find(item => item.getId() === I.BONECRUSHER);
  const event = { player: p, item, tab: 0, slot: p.getBank(0).getItems().indexOf(item), op: 9, handled: false };
  api.emitCustomEvent(Bank.ITEM_OP_EVENT, event);
  assert.equal(event.handled, true, 'Configure-Charges is not a withdrawal');
  p.getEnteredAmountAction().execute(target);
  return item;
}
function withdraw(p) {
  const item = new Item(I.BONECRUSHER, 1);
  p.getInventory().add(item);
  const received = p.getInventory().getItems().find(item => item.getId() === I.BONECRUSHER);
  api.emitCustomEvent(Bank.WITHDRAWN_ITEMS_EVENT, { player: p, items: [received] });
}
test('Configure-Charges saves a withdrawal target and uses banked tokens on withdrawal', t => {
  const p = player(t, 12);
  p.getBank(1).add(new Item(I.ECTO_TOKEN, 4), false);
  configure(t, p, 60);
  assert.equal(p.getAttribute('bonecrusher:charges'), 12, 'configuration itself does not charge');
  withdraw(p);
  assert.equal(p.getAttribute('bonecrusher:charges'), 62);
  assert.equal(p.getBank(1).getAmount(I.ECTO_TOKEN), 2);
});
test('withdrawal is bounded by supplies, and zero disables automatic charging', t => {
  const p = player(t, 12);
  p.getBank(1).add(new Item(I.ECTO_TOKEN, 1), false);
  configure(t, p, 100);
  withdraw(p);
  assert.equal(p.getAttribute('bonecrusher:charges'), 37);
  assert.equal(p.getBank(1).getAmount(I.ECTO_TOKEN), 0);
  const q = player(t, 12);
  q.getBank(1).add(new Item(I.ECTO_TOKEN, 5), false);
  configure(t, q, 0);
  withdraw(q);
  assert.equal(q.getAttribute('bonecrusher:charges'), 12);
  assert.equal(q.getBank(1).getAmount(I.ECTO_TOKEN), 5);
});
test('moving the configured item invalidates the amount prompt', t => {
  const p = player(t, 12);
  configure(t, p, 50);
  const pending = p.getEnteredAmountAction();
  p.getBank(0).delete(I.BONECRUSHER, 1);
  pending.execute(100);
  assert.equal(p.getAttribute('bonecrusher:withdrawal-charges'), 50);
});

test('closing the bank prevents a pending charge setting from being changed', t => {
  const p = player(t, 12);
  configure(t, p, 50);
  const pending = p.getEnteredAmountAction();
  t.mock.method(Bank, 'isOpen', () => false);
  pending.execute(100);
  assert.equal(p.getAttribute('bonecrusher:withdrawal-charges'), 50);
});

test('bone crushing passes fractional XP to the real SkillManager instead of rounding up', t => {
  const p = player(t, 2);
  p.getInventory().add(new Item(I.BONECRUSHER, 1));
  const skills = p.getSkillManager(), before = skills.getSkills().getExperiences()[Skill.PRAYER.getIndex()];
  const drops = [{ itemId: I.BONES, amount: 1 }];
  api.emitCustomEvent('npc-drops:generated', { player: p, drops });
  assert.equal(skills.getSkills().getExperiences()[Skill.PRAYER.getIndex()] - before, 2.2);
  assert.equal(drops.length, 0);
  assert.equal(p.getAttribute('bonecrusher:charges'), 1);
});
