// Wiki: ordinary altar colours and the canonical colour-changing conversation.
// GOTR answers the generic eligibility query; no minigame dependency belongs here.
let api, services;
const COLOURS_ATTRIBUTE = "pets:rift-colours";
const LOCKED_ATTRIBUTE = "pets:rift-locked";
const MENU_SCRIPT = 217; // Pinned/active cache: menu(string title, string entries, boolean keyboard).
const MENU_ORDER = ["air", "water", "earth", "fire", "body", "cosmic", "nature", "law", "soul", "mind", "chaos", "death", "astral", "blood", "wrath"];
const pendingMenus = new WeakMap();
const COLOUR_OPTION = "About your colour-changing...";
const CHANGING = "If the Rift guardian is set to changing colours upon binding essence at an altar:";
const KEEPING = "If the Rift guardian is set to keeping its colour upon binding essence at an altar:";
const LOCK_LINE = "Very well, I will remain locked to this colour, even if you bind essence at a Runecrafting Altar.";
const UNLOCK_LINE = "Very well, I will adopt the altar's colour next time you bind essence at a Runecrafting Altar.";
const colourOf = pet => pet?.enumName?.endsWith("_RIFT_GUARDIAN") ? pet.enumName.slice(0, -14).toLowerCase() : null;
function current(player, npc = player?.getAttribute?.(services.currentAttribute)) {
  if (player?.isRegistered?.() !== true || npc?.isRegistered?.() !== true
      || npc.isPet?.() !== true || npc.isVisible?.() !== true || npc.getOwner?.() !== player
      || player.getAttribute(services.currentAttribute) !== npc
      || services.world.getRemoveNPCQueue?.().includes(npc)) return null;
  const pet = services.getPetByNpcId(npc.getId());
  return colourOf(pet) ? {npc, pet} : null;
}
function knownColours(player) {
  const stored = player.getAttribute(COLOURS_ATTRIBUTE);
  return Array.isArray(stored) ? [...new Set(stored.filter(colour => services.pets.some(pet => colourOf(pet) === colour)))] : [];
}
function sendState(player) {
  const sender = player.getPacketSender(), cache = api.core.CacheDefinitions;
  sender.sendVarbit(cache.getVarbitId("skillpet_runecrafting_locked"), player.getAttribute(LOCKED_ATTRIBUTE) === true ? 1 : 0);
  for (const colour of knownColours(player)) sender.sendVarbit(cache.getVarbitId(`skillpet_runecrafting_${colour}_unlocked`), 1);
}
function learn(player, colour) {
  const known = knownColours(player);
  if (known.includes(colour)) return false;
  player.setAttribute(COLOURS_ATTRIBUTE, [...known, colour]);
  return true;
}
function recolour(player, follower, next) {
  follower.npc.setNpcTransformationId(next.petId);
  services.setStoredVariant(player, follower.pet, next.petId);
  player.setAttribute(services.activeAttribute, next.itemId);
  player.setAttribute(services.lastAttribute, next.itemId);
  services.recordOwnership(player, next);
  services.syncFollowerIndex(player, follower.npc);
}
function runeCrafted(event) {
  const follower = current(event.player);
  if (!follower || event.skill !== services.skill || !(event.rolls > 0)) return;
  const next = services.pets.find(pet => colourOf(pet)
    && api.core.ItemIdentifiers[pet.enumName.replace("_RIFT_GUARDIAN", "_RUNE")] === event.runeId);
  if (!next) return;
  const eligibility = {player: event.player, skill: services.skill, eligible: true};
  api.emitCustomEvent("pets:skilling-eligibility", eligibility);
  if (eligibility.eligible !== true) return;
  const player = event.player;
  learn(player, colourOf(follower.pet));
  if (learn(player, colourOf(next))) player.sendMessage("You have unlocked a new metamorphosis for your rift guardian.");
  if (player.getAttribute(LOCKED_ATTRIBUTE) !== true && next.petId !== follower.pet.petId) recolour(player, follower, next);
  sendState(player);
  api.emitCustomEvent("persistence:save", {player, reason: "rift-guardian-colour"});
}
function answerCondition(event) {
  if (event.text !== CHANGING && event.text !== KEEPING) return null;
  if (!colourOf(services.getPetByNpcId(event.npcId))) return null;
  if (!current(event.player, event.npc)) return false;
  const locked = event.player.getAttribute(LOCKED_ATTRIBUTE) === true;
  return event.text === KEEPING ? locked : !locked;
}
function confirmation(event) {
  if (event.step?.npc !== LOCK_LINE && event.step?.npc !== UNLOCK_LINE) return;
  if (!event.pages?.some(page => page.page === "Rift guardian") || !current(event.player, event.npc)) return;
  event.before = () => {
    // A menu/Continue callback must not change a picked-up, recalled or foreign pet.
    if (!current(event.player, event.npc) || event.player.busy()) { event.player.getDialogueManager().reset(); return; }
    event.player.setAttribute(LOCKED_ATTRIBUTE, event.step.npc === LOCK_LINE);
    sendState(event.player);
    api.emitCustomEvent("persistence:save", {player: event.player, reason: "rift-guardian-lock"});
  };
}
function colourSteps(steps) {
  return steps.find(step => step.type === "choice")?.options?.find(option => option.text === COLOUR_OPTION)?.steps;
}
function openMenu(player, npc) {
  const follower = current(player, npc);
  if (!follower || player.busy()) return;
  const learned = learn(player, colourOf(follower.pet));
  sendState(player);
  const known = knownColours(player);
  const choices = MENU_ORDER.filter(colour => known.includes(colour))
    .map(colour => services.pets.find(pet => colourOf(pet) === colour));
  const cache = api.core.CacheDefinitions, sender = player.getPacketSender();
  sender.sendInterfaceRemoval();
  sender.sendInterface(cache.getInterfaceId("menu"));
  sender.sendClientScript(MENU_SCRIPT, 1, "Choose metamorph", choices.map(pet => {
    const colour = colourOf(pet); return `${colour[0].toUpperCase()}${colour.slice(1)} altar`;
  }).join("|"));
  sender.sendInterfaceFlagsRange(cache.getComponentId("menu:lj_layer1"), 0, choices.length - 1, 1);
  pendingMenus.set(player, {npc, petId: follower.pet.petId, choices});
  if (learned) api.emitCustomEvent("persistence:save", {player, reason: "rift-guardian-colour"});
}
function chooseMetamorph(event) {
  const component = api.core.CacheDefinitions.getComponentId("menu:lj_layer1");
  if (event.groupId !== component >>> 16 || event.childId !== (component & 65535)) return;
  const context = pendingMenus.get(event.player);
  if (!context) return;
  event.handled = true;
  pendingMenus.delete(event.player);
  const player = event.player;
  if (player.getInterfaceId() !== api.core.CacheDefinitions.getInterfaceId("menu")) return;
  // Validate before closing: closing a modal can reset status, including a trade.
  if (player.getHitpoints() <= 0 || player.isDyingReturn() || player.getStatus() !== api.core.PlayerStatus.NONE
      || player.isNeedsPlacement() || player.isTeleportingReturn() || player.getForceMovement()) return;
  player.getPacketSender().sendInterfaceRemoval();
  const follower = current(player, context.npc), index = event.slot ?? event.action;
  const next = Number.isInteger(index) ? context.choices[index] : null;
  if (!follower || follower.pet.petId !== context.petId || player.busy()
      || !next || !knownColours(player).includes(colourOf(next))) return;
  if (follower.pet.petId !== next.petId) recolour(player, follower, next);
  sendState(player);
  api.emitCustomEvent("persistence:save", {player, reason: "rift-guardian-metamorphosis"});
}
function closeMenu({player}) { pendingMenus.delete(player); }
function closedInterface({player, interfaceId}) {
  if (interfaceId === api.core.CacheDefinitions.getInterfaceId("menu")) pendingMenus.delete(player);
}
function interact(event) {
  if (event.handled || !colourOf(event.pet)) return;
  const action = String(event.action).toLowerCase();
  if (action === "metamorphosis") { event.handled = true; openMenu(event.player, event.npc); return; }
  if (action !== "locking") return;
  event.handled = true;
  if (!current(event.player, event.npc) || event.player.busy()) return;
  learn(event.player, colourOf(event.pet));
  sendState(event.player);
  api.emitCustomEvent("npc-dialogue:start", {player: event.player, npc: event.npc, npcId: event.npc.getId(),
    variant: {page: "Rift guardian", variant: "rift-guardian"}, exact: true, select: colourSteps, handled: false});
}
function login({player}) {
  const follower = current(player);
  if (follower) learn(player, colourOf(follower.pet));
  // Send the durable flags after the main Pets login hook has restored its follower.
  if (follower || player.getAttribute(COLOURS_ATTRIBUTE) !== undefined || player.getAttribute(LOCKED_ATTRIBUTE) !== undefined) sendState(player);
}
function attach(pluginApi, helpers) {
  api = pluginApi; services = helpers;
  api.persistAttribute(COLOURS_ATTRIBUTE, []);
  api.persistAttribute(LOCKED_ATTRIBUTE, false);
  api.onCustomEvent("runecrafting:success", runeCrafted);
  api.onCustomEvent("pets:interact", interact);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:line", confirmation);
  api.onPlayerLogin(login);
  api.onInterfaceActionClick(chooseMetamorph);
  api.onCustomEvent("interface:close", closeMenu);
  api.onCustomEvent("interface:closed", closedInterface);
  api.onPlayerLogout(closeMenu);
  api.onPlayerDeath(closeMenu);
}
module.exports = {attach};
