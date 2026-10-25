/**
 * What else the PIN locks (Wiki: Bank_PIN, "Situations requiring a PIN"). A plugin about to open
 * something the PIN protects emits "bank-pin:guard" { player, feature, resume } and stops when
 * the request comes back `locked`. With a PIN this session hasn't entered, the keypad opens under
 * the feature's title (bank-pin.json `guardTitles`, else the bank's); the right PIN unlocks the
 * session (the bank too), says "You have correctly entered your PIN." and runs `resume()` a tick
 * later. With no PIN, or once entered, nothing happens.
 *
 * The point shops the Wiki lists (bank-pin.json `guardShops`) are guarded through the shop hook
 * instead, and reopened through ShopManager.
 *
 * Recorded (rsprox 3250): the Grand Exchange clerk's Exchange opens the keypad titled "Grand
 * Exchange", with "I don't know it.", and the right PIN opens the offers screen.
 */
const Common = require("./Common.BankPin");
const Keypad = require("./Keypad.BankPin");

/** Shared by the bank's own lock (Settings) and this one. */
let forgotten = null;

function guard(request) {
  const { player } = request;
  if (!player || request.locked) return;
  Common.settle(player);
  if (!Common.hasPin(player) || Common.isUnlocked(player)) return;
  request.locked = true;
  const title = Common.data.guardTitles[request.feature] ?? Common.data.keypad.bankTitle;
  Keypad.show(player, title, (pin) => {
    if (!Keypad.check(player, pin)) return;
    Common.unlock(player);
    player.sendMessage(Common.data.messages.correct);
    if (typeof request.resume === "function") Common.later(player, 1, request.resume);
  }, { onForgotten: forgotten ? () => forgotten(player) : null });
}

/** onCanShop: a guarded shop asks for a locked PIN first. */
function canShop(event) {
  const { player, shopId } = event;
  const feature = Common.data.guardShops[shopId];
  if (!feature) return;
  const request = { player, feature, resume: () => Common.core.ShopManager.open(player, shopId) };
  guard(request);
  if (request.locked) event.allow = false;
}

function attach(api, { onForgotten } = {}) {
  forgotten = onForgotten ?? null;
  api.onCustomEvent("bank-pin:guard", guard);
  api.onCanShop(canShop);
}

module.exports = { attach, guard, canShop };
