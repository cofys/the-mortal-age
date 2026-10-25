/**
 * Buying minecart tickets from the cart conductors (Transcript:Cart conductor, (Dwarven Mine),
 * (White Wolf Mountain); Wiki Keldagrim_minecart_system). The transcripts play as they are;
 * this answers their conditions and makes the sale:
 * - the fare is 150 coins to or from Ice Mountain and 100 to or from White Wolf Mountain, half
 *   for the "[Charm] Only pay half." option a Ring of Charos(a) gives;
 * - talking, the sale is on the conductor's line that follows a purchase ("Thanks, carts to Ice
 *   Mountain depart from track 1.", "Thanks for your custom!"...); the Tickets option's menu has
 *   no such line, so its pick is the sale, at the price it shows;
 * - no sale without the coins or a free slot: the transcript's own refusals play instead;
 * - White Wolf Mountain needs Fishing Contest, and the Dwarven Mine conductor speaks of the city
 *   only once The Giant Dwarf is started.
 */
const Common = require("./Common.KeldagrimMinecarts");

const CONDUCTOR = "Cart conductor";
const MENU_PICK = /^(.+) \((\d+) coins\)$/;
const SAME_AS = /^\(Same as /;
/** The route a "To ..." choice in the hub conductor's talk is buying. */
const ROUTE_CHOICES = { "To Ice Mountain.": "keldaIce", "To White Wolf Mountain.": "keldaWolf" };
const FARES = { keldaIce: 150, iceKelda: 150, keldaWolf: 100, wolfKelda: 100 };
const OUTSTATION_TICKETS = { mine: "iceKelda", wolf: "wolfKelda" };

/** What the conversation is buying: { kind, ticket, price } - set by its choices, read by its conditions. */
const purchases = new WeakMap();

/** "hub", "mine" or "wolf" for a cart conductor; null for anyone else. */
function conductorKind(npcId, definition) {
  const { npcs } = Common.ids;
  if (npcId === npcs.wolf) return "wolf";
  if (npcId === npcs.mine) return "mine";
  const name = definition?.getName?.() ?? Common.core.NpcDefinition.forId(npcId)?.getName?.();
  return name === CONDUCTOR ? "hub" : null;
}

function purchaseFor(player, kind) {
  const current = purchases.get(player);
  if (current?.kind === kind) return current;
  const ticket = OUTSTATION_TICKETS[kind];
  return ticket ? { ticket, price: FARES[ticket] } : null;
}

function coins(player) {
  return player.getInventory().getAmount(Common.ids.objs.coins);
}

function canBuy(player, purchase) {
  return Boolean(purchase) && coins(player) >= purchase.price && player.getInventory().getFreeSlots() > 0;
}

/** Takes the fare and hands over the ticket; false (and nothing changed) if the player can't. */
function sell(player, ticket, price) {
  const purchase = { ticket, price };
  if (!canBuy(player, purchase)) return false;
  const inventory = player.getInventory();
  inventory.delete(Common.ids.objs.coins, price);
  inventory.adds(Common.ids.objs[ticket], 1);
  inventory.refreshItems?.();
  purchases.delete(player);
  return true;
}

/** The Dwarven Mine conductor's talk is its members one (the transcript has no default). */
function chooseVariant({ npcId, definition }) {
  return conductorKind(npcId, definition) === "mine" ? "members-dialogue" : null;
}

function answerCondition({ player, npcId, definition, text }) {
  const kind = conductorKind(npcId, definition);
  if (!kind) return null;
  const value = String(text).toLowerCase();
  if (/does not have enough (coins|money)/.test(value)) {
    const purchase = purchaseFor(player, kind);
    return !purchase || coins(player) < purchase.price;
  }
  if (/(does not have any|does not have|has no) inventory space/.test(value)) return player.getInventory().getFreeSlots() === 0;
  if (value.includes("has finished fishing contest")) return Common.questComplete(player, "fishing_contest");
  if (/wearing (the|a) ring of charos\(a\)/.test(value)) return Common.wearingCharos(player);
  if (value.includes("before starting the giant dwarf")) return !Common.questStarted(player, "giant_dwarf");
  if (value.includes("after starting the giant dwarf")) return Common.questStarted(player, "giant_dwarf");
  return null;
}

/**
 * The choices say what is being bought: the route ("To Ice Mountain."), then the full fare
 * ("Buy.") or half ("[Charm] Only pay half."); a Tickets menu pick names both, and is the sale.
 */
function onChoice({ player, npcId, definition, option }) {
  const kind = conductorKind(npcId, definition);
  if (!kind) return;
  const text = String(option ?? "");
  if (ROUTE_CHOICES[text]) {
    purchases.set(player, { kind, ticket: ROUTE_CHOICES[text], price: FARES[ROUTE_CHOICES[text]] });
    return;
  }
  const purchase = purchaseFor(player, kind);
  if (text === "Buy." && purchase) {
    purchases.set(player, { kind, ticket: purchase.ticket, price: FARES[purchase.ticket] });
    return;
  }
  if (text === "[Charm] Only pay half." && purchase) {
    purchases.set(player, { kind, ticket: purchase.ticket, price: FARES[purchase.ticket] / 2 });
    return;
  }
  const pick = MENU_PICK.exec(text);
  if (!pick) return;
  const { menuTickets } = Common.data;
  const ticket = menuTickets[pick[1]] ?? menuTickets[`${pick[1]}@${kind}`];
  if (!ticket) return;
  const price = Number(pick[2]);
  purchases.set(player, { kind, ticket, price });
  // The transcript's refusals for the pick are played this tick, against the coins and slots as
  // they were; the sale follows when it can go through.
  Common.later(1, () => {
    const pending = purchases.get(player);
    if (pending?.ticket === ticket && pending.price === price) sell(player, ticket, price);
  });
}

/** The conductor's line as a purchase goes through. */
function onLine(request) {
  const kind = conductorKind(request.npcId, request.definition);
  if (!kind || typeof request.text !== "string" || request.step?.player !== undefined) return;
  const sale = Common.data.sales.find((entry) => entry.conductor === kind && entry.text === request.text);
  if (sale) sell(request.player, sale.ticket, sale.price);
}

/**
 * "(Same as dialogue for Ice Mountain (150 coins).)": the Ice Mountain pick's own steps - its
 * refusals when the coins or a slot are missing (the sale follows the pick otherwise).
 */
function onAction(event) {
  const kind = conductorKind(event.npcId, event.definition);
  if (!kind || !SAME_AS.test(String(event.text ?? ""))) return;
  event.handled = true;
  const purchase = purchaseFor(event.player, kind);
  const { refusals } = Common.data;
  if (!purchase || coins(event.player) < purchase.price) event.steps = [{ player: refusals.coins }];
  else if (event.player.getInventory().getFreeSlots() === 0) event.steps = [{ npc: refusals.space }];
  else event.end = true;
}

/** The Tickets option: the conductor's ticket menu, the halved one with the Ring of Charos(a). */
function ticketsOption({ player, npc }) {
  const npcId = npc?.getId?.();
  const kind = conductorKind(npcId, npc?.getDefinition?.());
  if (!kind) return false;
  purchases.delete(player);
  const charm = Common.wearingCharos(player);
  const base = kind === "mine" ? "members-dialogue-tickets-option" : "tickets";
  const variant = charm ? `${base}-ring-of-charos-a-equipped` : base;
  Common.api.emitCustomEvent("npc-dialogue:start", { player, npc, npcId, variant, exact: true, handled: false });
  return true;
}

function forget({ player }) {
  purchases.delete(player);
}

function attach(api) {
  api.onNpcDialogueVariant(chooseVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:choice", onChoice);
  api.onCustomEvent("npc-dialogue:line", onLine);
  api.onCustomEvent("npc-dialogue:action", onAction);
  api.onNpcInteraction(CONDUCTOR, { Tickets: ticketsOption });
  api.onPlayerLogout(forget);
}

module.exports = {
  attach, sell, canBuy, conductorKind, chooseVariant, answerCondition, onChoice, onLine, onAction, ticketsOption, FARES,
};
