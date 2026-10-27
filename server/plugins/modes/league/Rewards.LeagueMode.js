/**
 * The Leagues Reward Shop (league_rewards 658, data.rewards). The stock is the cache's own: each
 * league struct lists its reward structs (name, item, cost), and the client draws them all, rows
 * running across the leagues in order. The server opens the screen as captured, sets the selected
 * row's varbit on a row click, and sells the selected reward on Confirm.
 *
 * Points: the Wiki pools every league's points and sells every league's rewards in the main game.
 * A main character's points are its league character's (Records' `league:account-points`), less
 * what it has spent of each league's here (`league:reward-points-spent`); what is left goes out as
 * varp 2613. A reward gives its set's pieces (param 915) when it has a set, else its item. On a
 * league world the shop opens to browse: live sends no points there, and the client hides Confirm
 * where the league struct says so. The Bank PIN guards the shop.
 *
 * Opened by the Leagues Tutor's Trade (main game) and Rewards (league world) options, the
 * conversations' open_shop "Leagues Reward Shop", and `::leagueshop`.
 */
const Common = require("./Common.LeagueMode");
const { FLAG_OP1 } = require("../../interface/widgetGroup");

/** Points this main character has spent in the shop, by league type: { [type]: points }. */
const SPENT_ATTRIBUTE = "league:reward-points-spent";
const TUTOR = "Leagues Tutor";

/** Per player: the row selected (the server's copy of varbit 10110). */
const selection = new WeakMap();
/** The cache's rewards, one per row: { league, struct, name, item, cost, items: [{ item, amount }] }; read once. */
let stockList = null;

function uid(group, child) {
  return (group << 16) | child;
}

function rewards() {
  return Common.data.rewards;
}

function stock() {
  if (stockList) return stockList;
  const { CacheDefinitions } = Common.core;
  const { params } = rewards();
  const entries = (id) => [...CacheDefinitions.getEnumValues(id).entries()].sort(([a], [b]) => a - b);
  stockList = [];
  // The client walks enum 2670's leagues in order; data.leagues holds the same structs by type.
  const leagues = Object.entries(Common.data.leagues).map(([type, row]) => [Number(type), row.struct]).sort(([a], [b]) => a - b);
  for (const [league, leagueStruct] of leagues) {
    const list = CacheDefinitions.getStructParams(Number(leagueStruct))?.get(params.rewards);
    if (list === undefined || list === -1) continue;
    for (const [, struct] of entries(Number(list))) {
      const row = CacheDefinitions.getStructParams(Number(struct));
      const item = Number(row?.get(params.item) ?? -1);
      const set = row?.get(params.set);
      // A set (a Relic Hunter outfit, six kits) lists what it gives; otherwise the item, `quantity` of it.
      const items = set !== undefined
        ? entries(Number(set)).map(([, piece]) => ({ item: Number(piece), amount: 1 }))
        : [{ item, amount: Number(row?.get(params.quantity)) || 1 }];
      stockList.push({
        league: Number(league),
        struct: Number(struct),
        name: String(row?.get(params.name) ?? ""),
        item,
        cost: Number(row?.get(params.cost)) || 0,
        items: items.filter((entry) => entry.item >= 0),
      });
    }
  }
  return stockList;
}

/** A main character on a plain world: the only place rewards are bought. */
function isMainGame(player) {
  return !Common.isLeagueProfile(player) && Common.worldLeague() === null;
}

/** The account's league points, by league type (Records). */
function earned(player) {
  const query = { player, leagues: {}, total: 0 };
  Common.api.emitCustomEvent("league:account-points", query);
  return query.leagues ?? {};
}

function spent(player) {
  const value = player.getAttribute(SPENT_ATTRIBUTE);
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Each league's points left: what it earned less what was spent of it. */
function left(player) {
  const spentBy = spent(player);
  return Object.entries(earned(player)).map(([type, points]) => [type, Math.max(0, (Number(points) || 0) - (Number(spentBy[type]) || 0))]);
}

/** The points left to spend, pooled across the leagues as the Wiki says. */
function available(player) {
  return left(player).reduce((sum, [, points]) => sum + points, 0);
}

/** Spends `cost` from the leagues' points left, the lowest league type first. */
function spend(player, cost) {
  const spentBy = { ...spent(player) };
  let owed = cost;
  for (const [type, points] of left(player).sort(([a], [b]) => Number(a) - Number(b))) {
    const take = Math.min(points, owed);
    spentBy[type] = (Number(spentBy[type]) || 0) + take;
    owed -= take;
    if (owed <= 0) break;
  }
  player.setAttribute(SPENT_ATTRIBUTE, spentBy);
}

function sendPoints(player) {
  if (isMainGame(player)) player.getPacketSender().sendConfig(rewards().pointsVarp, available(player));
}

/** The screen as captured, fresh: the list, no selection, the points left. */
function show(player) {
  const { group, rows, modalSize } = rewards();
  selection.delete(player);
  sendPoints(player);
  const sender = player.getPacketSender();
  sender.sendInterfaceScript(Common.data.panels.modalSizeScript, modalSize);
  sender.sendInterface(group);
  sender.sendInterfaceFlagsRange(uid(group, rows), 0, stock().length - 1, FLAG_OP1);
}

function open(player) {
  const guard = { player, feature: rewards().pinFeature, resume: () => open(player) };
  Common.api.emitCustomEvent("bank-pin:guard", guard);
  if (!guard.locked) show(player);
  return true;
}

function isOpen(player) {
  return player.getInterfaceId() === rewards().group;
}

/** A row click: the client shows that reward and its Confirm. */
function select({ player, slot }) {
  if (!isOpen(player)) return true;
  const row = Number(slot);
  if (!Number.isInteger(row) || !stock()[row]) return true;
  selection.set(player, row);
  player.getPacketSender().sendVarbit(rewards().selectionVarbit, row);
  return true;
}

/** The free slots the reward's items take: one per unstackable item, one per stack not yet held. */
function slotsNeeded(player, items) {
  const inventory = player.getInventory();
  const stacks = new Set();
  let slots = 0;
  for (const { item, amount } of items) {
    if (Common.core.ItemDefinition.forId(item)?.isStackable?.() === true) {
      if (!inventory.contains(item) && !stacks.has(item)) slots++;
      stacks.add(item);
    } else {
      slots += amount;
    }
  }
  return slots;
}

/** Sells the selected reward if the world, the points left and the inventory allow it. */
function buy(player) {
  const reward = stock()[selection.get(player)];
  if (!reward || !reward.items.length) return;
  if (!isMainGame(player)) {
    player.sendMessage(rewards().messages.leagueWorld);
    return;
  }
  if (available(player) < reward.cost) return;
  if (player.getInventory().getFreeSlots() < slotsNeeded(player, reward.items)) {
    player.sendMessage(rewards().messages.noSpace);
    return;
  }
  spend(player, reward.cost);
  for (const { item, amount } of reward.items) player.getInventory().adds(item, amount);
}

/** The shop after a Confirm: open afresh, with the layers the cache hides by default hidden again. */
function reopen(player) {
  show(player);
  const { group, hiddenLayers } = rewards();
  for (const child of hiddenLayers) player.getPacketSender().sendInterfaceDisplayState(uid(group, child), true);
}

/**
 * The dialog's Confirm (658:22). Its click shows a loading layer (658:24, script 3288) that no
 * script hides again, so the shop closes and opens afresh a tick later, with the points left. A
 * fresh load hides that layer and the dialog (658:5); this web client keeps a closed group's
 * state, so they are hidden again by hand.
 */
function confirm({ player }) {
  if (!isOpen(player)) return true;
  buy(player);
  selection.delete(player);
  player.getPacketSender().sendInterfaceRemoval();
  Common.later(player, 1, () => reopen(player));
  return true;
}

function trade({ player }) {
  return open(player);
}

/** The Leagues Tutor's conversations end in open_shop "Leagues Reward Shop". */
function dialogueAction(event) {
  if (event.handled || event.action !== "open_shop" || event.target !== rewards().shopTarget) return;
  event.handled = true;
  event.end = true;
  // The conversation closes its window as it ends; the shop opens on the next tick.
  Common.later(event.player, 1, () => open(event.player));
}

function login({ player }) {
  sendPoints(player);
}

/** The shop closed: its selection goes with it, as the client's does. */
function closed({ player, interfaceId }) {
  if (interfaceId === rewards().group) selection.delete(player);
}

function shopCommand({ player }) {
  open(player);
  return true;
}

function npcOptions() {
  return Object.fromEntries(rewards().npcOptions.map((option) => [option, trade]));
}

function buttons() {
  const { group, rows, confirm: confirmButton } = rewards();
  return { rowsButton: uid(group, rows), confirmButton: uid(group, confirmButton) };
}

module.exports = function attach(api) {
  const { rowsButton, confirmButton } = buttons();
  api.persistAttribute(SPENT_ATTRIBUTE, {});
  // After Records' login, which reads the league save these points come from.
  api.onPlayerLogin(login);
  api.onNpcInteraction(TUTOR, npcOptions());
  api.onCustomEvent("npc-dialogue:action", dialogueAction);
  api.onCustomEvent("interface:closed", closed);
  api.onInterfaceActionButton(rowsButton, select);
  api.onInterfaceActionButton(confirmButton, confirm);
  api.registerCommand("leagueshop", shopCommand, api.core.PlayerRights.DEVELOPER, "Open the Leagues Reward Shop: ::leagueshop");
};

module.exports._test = { stock, available, slotsNeeded, SPENT_ATTRIBUTE };
