/**
 * Coin pouches from pickpocketing (Wiki: Coin pouch): left-click opens the whole stack, right-click
 * opens one. Each kind holds the coins its target's pouch is listed with in pickpocketing.json.
 *
 * rsprox captures (recordings 2601, 3059 and others): Open-all says "You open all of the pouches and
 * receive a total of N coins." as a spam message with synth 2115, even for a single pouch. Open
 * (one pouch) isn't captured and keeps its own line.
 */
const { pouchCoins, POUCH_COINS } = require("./Pickpocket.Thieving");

const OPEN_SOUND = 2115;

let core;

function open(player, pouchId, count, all = false) {
  if (!POUCH_COINS.has(pouchId) || count <= 0) return;
  let coins = 0;
  for (let i = 0; i < count; i++) coins += pouchCoins(pouchId);
  player.getInventory().delete(pouchId, count);
  player.getInventory().adds(core.ItemIdentifiers.COINS, coins);
  if (!all) {
    player.sendMessage(`You open the pouch and find ${coins} coins.`);
    return;
  }
  player.getPacketSender().sendTypedMessage(core.ChatType.SPAM, `You open all of the pouches and receive a total of ${coins.toLocaleString("en-US")} coins.`);
  player.getPacketSender().sendSound(OPEN_SOUND, 1, 0);
}

function openAll(event) {
  open(event.player, event.itemId, event.player.getInventory().getAmount(event.itemId), true);
  event.handled = true;
}

function openOne(event) {
  open(event.player, event.itemId, 1);
  event.handled = true;
}

function register(api) {
  core = api.core;
  api.onItemAction("Coin pouch", { "Open-all": openAll, Open: openOne });
}

module.exports = { register, _test: { open } };
