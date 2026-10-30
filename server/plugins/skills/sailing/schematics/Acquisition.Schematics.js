// Wiki Lost schematics and RSProx 235/3792,936,960,1029: ten matched key/box loops.
const common = require('./Common.Schematics');
const SOUND_DIG = 1470;
const SOUND_UNLOCK = 2419;
const SOUND_OPEN = 52;
const SOUND_FIND = 51;
const ALREADY = "You've already got everything you can from this lockbox.";
const SEALED = "The lockbox is firmly sealed shut. Perhaps the directions you wrote down can help you open it.";
const COPY = "The lockbox is firmly sealed shut, but there's an engraving with directions on the side of it. You write them down...";
const pending = new WeakMap();

function emptySlot(items) { return items.findIndex(item => !item || item.getId() < 0 || item.getAmount() <= 0); }
function singleKey(item) { return item && item.getAmount() === 1; }
function addOne(player, id) {
  const inv = player.getInventory();
  if (inv.getAddableAmount(new (common.core().Item)(id, 1)) < 1) return false;
  const items = inv.getCopiedItems(), slot = emptySlot(items);
  if (slot < 0) return false;
  items[slot] = new (common.core().Item)(id, 1);
  inv.setItems(items).refreshItems();
  return true;
}
function alive(player) { return player.isRegistered() && player.getHitpoints() > 0; }
function unavailable(player, row) { return common.learned(player, row) || common.has(player, row.itemId); }
function dig(event) {
  const { player } = event;
  const row = common.rows().find(row => row.box && player.getLocation().equals(new (common.core().Location)(...row.box.dig)));
  if (!row) return false; // Other quest/clue/barrows digs retain their own handling.
  if (!common.canItemRead(event) || !alive(player)) return true;
  player.performAnimation(new (common.core().Animation)(common.core().CacheDefinitions.getSeqId('human_dig')));
  player.getPacketSender().sendSoundEffect(SOUND_DIG, 1, 0);
  // One owned key is sufficient. Ownership includes the real bank, as with schematic reclamation.
  // Duplicate key suppression is a conservative policy; no available capture records repeat digs.
  if (common.opened(player, row) || unavailable(player, row) || common.has(player, row.box.keyId)) return true;
  if (!addOne(player, row.box.keyId)) { player.getInventory().full(); return true; }
  common.itemBox(player, row.box.keyId, 'You dig up a small key.');
  return true;
}
function draw(player, object, id) {
  const { GameObject } = common.core();
  player.getPacketSender().sendObject(new GameObject(id, object.getLocation().clone(), object.getType(), object.getFace(), null));
}
function open({ player, object }) {
  const row = common.rows().find(row => row.box?.closedId === object.getId());
  if (!row) return false;
  if (!alive(player) || player.busy() || pending.has(player)) return true;
  if (unavailable(player, row)) { player.sendMessage(ALREADY); return true; }
  const inv = player.getInventory();
  const keySlot = inv.getItems().findIndex(item => item?.getId() === row.box.keyId && singleKey(item));
  const alreadyOpened = common.opened(player, row);
  if (keySlot < 0 && !alreadyOpened) {
    if (common.has(player, row.box.hintId)) { player.sendMessage(SEALED); return true; }
    if (!addOne(player, row.box.hintId)) { inv.full(); return true; }
    common.itemBox(player, row.box.hintId, COPY);
    return true;
  }
  if (keySlot < 0 && inv.getAddableAmount(new (common.core().Item)(row.itemId, 1)) < 1) { inv.full(); return true; }
  const { Task, TaskManager, Animation, CacheDefinitions, Item } = common.core();
  const origin = player.getLocation().clone();
  const key = keySlot >= 0 ? inv.getItems()[keySlot] : null;
  // First unlock timing is captured. Reclaims reuse it; their precise timing is not recorded.
  class LockboxTask extends Task {
    constructor() { super(1, player.getIndex(), false); this.stage = 0; this.drawn = false; }
    stop() {
      if (this.drawn && alive(player)) draw(player, object, row.box.closedId);
      this.drawn = false;
      if (pending.get(player) === this) pending.delete(player);
      super.stop();
    }
    execute() {
      if (!alive(player) || !player.getLocation().equals(origin) || player.getMovementQueue().size() > 0) return this.stop();
      this.stage++;
      if (this.stage < 3 && player.busy()) return this.stop();
      if (this.stage === 1) {
        if (unavailable(player, row)) return this.stop();
        if (!common.opened(player, row)) {
          const live = inv.getItems()[keySlot];
          if (live !== key || live?.getId() !== row.box.keyId || !singleKey(live)) return this.stop();
          const items = inv.getCopiedItems();
          items[keySlot] = new Item(-1, 0);
          // Commit durable state before consuming; interruption retains keyless reclaim.
          common.markOpened(player, row);
          inv.setItems(items).refreshItems();
        }
      } else if (this.stage === 2) {
        player.performAnimation(new Animation(CacheDefinitions.getSeqId('human_openchest'), 10));
        player.getPacketSender().sendSoundEffect(SOUND_UNLOCK, 1, 0).sendSoundEffect(SOUND_OPEN, 1, 10);
      } else if (this.stage === 3) {
        if (player.busy() || unavailable(player, row)) return this.stop();
        if (!addOne(player, row.itemId)) { inv.full(); return this.stop(); }
        player.getPacketSender().sendSoundEffect(SOUND_FIND, 1, 45);
        draw(player, object, row.box.openId); this.drawn = true;
        common.api().emitCustomEvent('collection-log:obtain', { player, itemId: row.itemId, amount: 1, ensure: true });
        common.itemBox(player, row.itemId, 'You unlock the lockbox and find a schematic inside!');
      } else if (this.stage === 5) this.stop();
    }
  }
  const task = new LockboxTask(); pending.set(player, task); TaskManager.submit(task);
  return true;
}
function logout({ player }) { pending.get(player)?.stop(); }
function attach(api) {
  api.onItemAction('Spade', { Dig: dig });
  api.onObjectInteraction('Lockbox', { Open: open });
  api.onPlayerLogout(logout);
}
module.exports = { attach };
