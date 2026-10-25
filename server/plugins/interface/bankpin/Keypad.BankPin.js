/**
 * The PIN keypad (bankpin_keypad). The cache's own scripts shuffle the digits and prompt for each
 * one; the client then sends the four as one count-dialog answer (digit1 * 1000 + ... + digit4),
 * which arrives here as an entered amount. 0000 is a PIN too, so the prompt takes 0.
 *
 * The keypad's own buttons answer the same way (script 686): Exit as 12345, "I don't know it."
 * as 54321.
 *
 * Wrong entries count towards the lockouts (Wiki: after two a 10-second wait, after three 15
 * seconds, after four 10 minutes), kept over logout; a right one clears them.
 */
const Common = require("./Common.BankPin");

const MAX_PIN = 9999;
/** Script 686's answers for the keypad's Exit and "I don't know it." buttons. */
const EXIT_ANSWER = 12345;
const FORGOTTEN_ANSWER = 54321;

/** Players with the keypad open -> what it is for: { onPin, onForgotten }. */
const open = new WeakMap();

function lockedSeconds(player) {
  const until = Number(Common.get(player, "lockedUntil")) || 0;
  return Math.max(0, Math.ceil((until - Common.now()) / 1000));
}

/**
 * Opens the keypad titled `title`. `onPin(pin)` gets the four digits as a string; `onForgotten`,
 * when given, is offered as "I don't know it.". Refused while locked out.
 */
function show(player, title, onPin, { onForgotten = null, instruction = Common.data.keypad.instruction } = {}) {
  const seconds = lockedSeconds(player);
  if (seconds > 0) {
    player.sendMessage(Common.fill(Common.data.messages.lockedOut, { seconds }));
    return false;
  }
  const { groups, uids } = Common.ids;
  const sender = player.getPacketSender();
  sender.sendInterfaceRemoval();
  sender.sendInterface(groups.keypad);
  sender.sendString(title, uids.keypad.title);
  sender.sendString(instruction, uids.keypad.instruction);
  sender.sendInterfaceDisplayState(uids.keypad.forgotten, !onForgotten);
  open.set(player, { onPin, onForgotten });
  player.setEnteredAmountAction({
    acceptsZero: true,
    execute: (amount) => {
      const pending = open.get(player);
      if (!pending) return;
      open.delete(player);
      player.getPacketSender().sendInterfaceRemoval();
      if (amount === FORGOTTEN_ANSWER) return pending.onForgotten?.();
      if (amount === EXIT_ANSWER || !Number.isInteger(amount) || amount < 0 || amount > MAX_PIN) return;
      pending.onPin(String(amount).padStart(4, "0"));
    },
  });
  return true;
}

/** True for the player's PIN; otherwise the failure is counted, and a lockout may start. */
function check(player, pin) {
  if (Common.hash(player, pin) === Common.get(player, "hash")) {
    Common.set(player, "failures", 0);
    Common.set(player, "lockedUntil", 0);
    return true;
  }
  const failures = (Number(Common.get(player, "failures")) || 0) + 1;
  Common.set(player, "failures", failures);
  const { lockout, messages } = Common.data;
  const steps = Object.keys(lockout).map(Number).sort((a, b) => a - b);
  const step = steps.filter((count) => failures >= count).pop();
  player.sendMessage(messages.wrong);
  if (step !== undefined) {
    const seconds = lockout[step];
    Common.set(player, "lockedUntil", Common.now() + seconds * 1000);
    player.sendMessage(Common.fill(messages.lockedOut, { seconds }));
  }
  return false;
}

function closed({ player, interfaceId }) {
  if (interfaceId === Common.ids.groups.keypad) open.delete(player);
}

function attach(api) {
  api.onCustomEvent("interface:closed", closed);
}

module.exports = { attach, show, check, lockedSeconds, isOpen: (player) => open.has(player), EXIT_ANSWER, FORGOTTEN_ANSWER };
