"use strict";

const { randomUUID } = require("node:crypto");
const Catalogue = require("./Catalogue.TreasureTrails");
const { TIERS } = require("./Tiers.TreasureTrails");
const META_PREFIX = "treasure-trails:";
// The clue helper names a target tile but no area. Emote steps accept the beginner
// runtime's usual radius around it; music steps need the player near Cecilia's bridge.
const EMOTE_RADIUS = 3;
const MUSIC_RADIUS = 5;
const NPC_RADIUS = 3;
let api;
let core;
let catalogues = new Map();
const uris = new WeakMap();
const playing = new WeakMap();
const pick = (entries, random = Math.random) => entries[Math.floor(random() * entries.length)];
const location = entity => ({ x: entity.getLocation().getX(), y: entity.getLocation().getY(), z: entity.getLocation().getZ() });
const distance = (a, b) => a.z === b.z ? Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) : Infinity;
const metaKey = tier => META_PREFIX + tier.name;
const completedAttribute = tier => `${META_PREFIX}${tier.name}-completed`;

function data(tier) {
  if (!catalogues.has(tier.name)) catalogues.set(tier.name, Catalogue.load(core, tier));
  return catalogues.get(tier.name);
}

function tierOfItem(id) {
  return TIERS.find(tier => data(tier).byItem.has(id)) ?? null;
}

function trailLength(tier, random = Math.random) {
  const [minimum, maximum] = tier.length;
  return minimum + Math.floor(random() * (maximum - minimum + 1));
}

function validState(tier, item, state) {
  const step = data(tier).byItem.get(item.getId());
  const [minimum, maximum] = tier.length;
  return state?.version === 1 && step && state.row === step.row && typeof state.token === "string" &&
    Number.isInteger(state.length) && state.length >= minimum && state.length <= maximum &&
    Number.isInteger(state.completed) && state.completed >= 0 && state.completed < state.length;
}

/** The step item for `state`, carrying it; every step of a trail is a different cache item. */
function stepItem(tier, step, state) {
  return new core.Item(step.itemId, 1).setMetaValue(metaKey(tier), { ...state, row: step.row });
}

function stateOf(player, slot, random = Math.random) {
  const inventory = player.getInventory();
  const item = inventory.getItems()[slot];
  const tier = item && tierOfItem(item.getId());
  if (!tier) return null;
  const current = item.getMetaValue(metaKey(tier));
  if (validState(tier, item, current)) return { tier, item, slot, state: current, step: data(tier).byRow.get(current.row) };
  // A clue without a trail (a drop, box or vessel) starts one on a random step of its tier.
  const step = pick(data(tier).steps, random);
  const state = { version: 1, token: randomUUID(), revision: 0, completed: 0, length: trailLength(tier, random), row: step.row };
  const replacement = stepItem(tier, step, state);
  inventory.setItem(slot, replacement);
  inventory.refreshItems();
  return { tier, item: replacement, slot, state, step };
}

function trails(player) {
  return player.getInventory().getItems().flatMap((item, slot) => {
    const tier = item && item.getAmount() > 0 ? tierOfItem(item.getId()) : null;
    const state = tier ? item.getMetaValue(metaKey(tier)) : null;
    return tier && validState(tier, item, state) ? [{ tier, item, slot, state, step: data(tier).byRow.get(state.row) }] : [];
  });
}

function startedTrails(player) {
  // Interactions that need a held clue start the trail of any fresh scroll first.
  player.getInventory().getItems().forEach((item, slot) => { if (item && tierOfItem(item.getId())) stateOf(player, slot); });
  return trails(player);
}

function stillHeld(player, snapshot) {
  return trails(player).find(trail => trail.state.token === snapshot.state.token && trail.state.revision === snapshot.state.revision);
}

function clicked(event) {
  const item = event.player.getInventory().getItems()[event.slot];
  return item && item.getAmount() > 0 && tierOfItem(item.getId()) && (!event.item || item === event.item) ? item : null;
}

function clueText(step) {
  if (step.family === "music") {
    const where = step.description.replace(/\.$/, "").replace(/^\w/, letter => letter.toLowerCase());
    const npc = core.CacheDefinitions.getNpc(step.npcIds[0])?.name ?? "";
    return `The clue reveals who to speak to:<br><br>I'd like to hear some music.<br>Come and see me ${where}, and play:<br>${step.track}<br>Thanks,<br>${npc}`;
  }
  return step.family === "anagram" ? `This anagram reveals<br>who to speak to next:<br><br>${step.text}` : step.text;
}

function read(event) {
  if (!clicked(event)) return false;
  const trail = stateOf(event.player, event.slot);
  const sender = event.player.getPacketSender();
  if (trail.step.family === "map" && trail.step.interfaceId != null) {
    sender.sendInterface(trail.step.interfaceId);
    return true;
  }
  const group = data(trail.tier).textInterface;
  sender.sendInterface(group);
  sender.sendString(clueText(trail.step), (group << 16) | 2);
  return true;
}

function checkSteps(event) {
  if (!clicked(event)) return false;
  const trail = stateOf(event.player, event.slot);
  event.player.sendMessage(`You have completed ${trail.state.completed} steps on this ${trail.tier.name} Treasure Trail.`);
  return true;
}

function dismissUri(player) {
  const active = uris.get(player);
  if (active) api.removeNpc(active.npc);
  uris.delete(player);
}

function advance(player, snapshot, random = Math.random) {
  const trail = stillHeld(player, snapshot);
  if (!trail) return false;
  dismissUri(player);
  const inventory = player.getInventory();
  const completed = trail.state.completed + 1;
  if (completed >= trail.state.length) {
    // The exact slot matters when scrolls of several tiers are carried.
    inventory.setItem(trail.slot, new core.Item(data(trail.tier).casket, 1));
    player.sendMessage("You've found a reward casket!");
  } else {
    const step = pick(data(trail.tier).steps, random);
    inventory.setItem(trail.slot, stepItem(trail.tier, step, { ...trail.state, completed, revision: trail.state.revision + 1 }));
    player.sendMessage("You've found another clue!");
  }
  inventory.refreshItems();
  return true;
}

function dialogue(player, npcId, lines, onEnd) {
  const chain = new core.DialogueChainBuilder();
  lines.forEach((text, index) => chain.add(new core.NpcDialogue(index, npcId, text)));
  if (onEnd) chain.add(new core.ActionDialogue(lines.length, { execute: onEnd }));
  chain.add(new core.EndDialogue(lines.length + 1));
  player.getDialogueManager().startDialogues(chain);
}

function isUri(npcId) {
  return TIERS.some(tier => data(tier).uri === npcId);
}

function talk(event) {
  if (event.handled) return;
  const { player, npcId, npc } = event;
  const definition = event.definition ?? npc.getCurrentDefinition?.(player);
  if (definition?.getActions?.()[event.clickType - 1] !== "Talk-to") return;
  if (isUri(npcId)) {
    const active = uris.get(player);
    if (!active || active.npc !== npc) return;
    const trail = stillHeld(player, active.trail);
    if (!trail || !emoteReady(player, trail.step)) { dismissUri(player); return; }
    event.handled = true;
    dialogue(player, npcId, ["Well done, you've completed the challenge!"], () => {
      const current = stillHeld(player, trail);
      if (uris.get(player)?.npc === npc && current && emoteReady(player, current.step)) advance(player, current);
    });
    return;
  }
  const trail = startedTrails(player).find(entry => ["anagram", "cryptic", "cipher", "music"].includes(entry.step.family) &&
    entry.step.target === "npc" && entry.step.npcIds.includes(npcId));
  if (!trail) return;
  event.handled = true;
  if (trail.step.family === "music") { hearSong(player, npcId, trail); return; }
  dialogue(player, npcId, ["Well done, you've found me!"], () => {
    if (distance(location(player), location(npc)) <= NPC_RADIUS) advance(player, trail);
  });
}

function search(event) {
  if (event.handled) return;
  const { player, objectId } = event;
  const trail = startedTrails(player).find(entry => entry.step.target === "loc" && entry.step.locIds.includes(objectId) &&
    distance(event.location, entry.step.location) === 0);
  if (!trail) return;
  event.handled = true;
  advance(player, trail);
}

function dig(event) {
  const I = core.ItemIdentifiers;
  if (event.allow === false || !/\bdig\b/i.test(String(event.option)) || ![I.SPADE, I.EASTFLOOR_SPADE].includes(event.itemId)) return;
  const { player } = event;
  if (!player.getInventory().getItems().some(item => item && item.getId() === event.itemId)) return;
  const trail = startedTrails(player).find(entry => ["map", "cryptic", "coordinate"].includes(entry.step.family) &&
    entry.step.target === "coord" && distance(location(player), entry.step.location) === 0);
  if (!trail) return;
  event.allow = false;
  player.performAnimation(new core.Animation(core.CacheDefinitions.getSeqId("human_dig") ?? 830));
  advance(player, trail);
}

function wearing(player, requirement) {
  return player.getEquipment().getItems().some(item => item && (requirement.anyOf ? requirement.anyOf.includes(item.getId()) :
    core.CacheDefinitions.getItem(item.getId())?.params?.get?.(requirement.param) != null));
}

function emoteReady(player, step) {
  return step.family === "emote" && distance(location(player), step.location) <= EMOTE_RADIUS &&
    step.equipment.every(requirement => wearing(player, requirement));
}

function emote({ player, slot }) {
  const trail = startedTrails(player).find(entry => entry.step.family === "emote" && entry.step.emotes[0] === slot && emoteReady(player, entry.step));
  if (!trail) return;
  dismissUri(player);
  const origin = player.getLocation();
  const region = api.getRegionManager();
  const spot = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => new core.Location(origin.getX() + dx, origin.getY() + dy, origin.getZ()))
    .find(tile => !region.blocked(tile, player.getPrivateArea?.()) && region.canMovestart(origin, tile, 1, 1, player.getPrivateArea?.()));
  if (!spot) return;
  const npc = api.spawnNpc({ id: data(trail.tier).uri, x: spot.getX(), y: spot.getY(), z: spot.getZ(), owner: player, ownerOnly: true, wanderRadius: 0 });
  if (npc) uris.set(player, { npc, trail });
}

function songPlayed({ player, trackId }) {
  if (player) playing.set(player, trackId);
}

/** Wiki Transcript:Cecilia: select the requested song, then speak to her again. */
function hearSong(player, npcId, trail) {
  if (playing.get(player) !== trail.step.midi) {
    dialogue(player, npcId, ["Select the song I asked you to play, and speak to me again."]);
    return;
  }
  dialogue(player, npcId, ["Thank you, I love that song!"], () => {
    if (playing.get(player) === trail.step.midi && distance(location(player), trail.step.location) <= MUSIC_RADIUS) advance(player, trail);
  });
}

function restore({ player }) {
  for (const tier of TIERS) {
    const varbit = core.CacheDefinitions.getVarbitId(`collection_clues_${tier.name}_completed`);
    if (varbit != null) player.getPacketSender().sendVarbit(varbit, Number(player.getAttribute(completedAttribute(tier))) || 0);
  }
}

function categoryCount(request) {
  const tier = TIERS.find(entry => new RegExp(`^Treasure Trails \\(${entry.label}\\)$`, "i").test(request.category));
  if (tier) request.count = Number(request.player.getAttribute(completedAttribute(tier))) || 0;
}

function leave({ player }) { dismissUri(player); }

function readActions() {
  return { Read: read, "Check steps": checkSteps };
}

module.exports = function attachTreasureTrails(pluginApi) {
  api = pluginApi;
  core = api.core;
  catalogues = new Map();
  for (const tier of TIERS) api.persistAttribute(completedAttribute(tier), 0);
  for (const tier of TIERS) api.onItemAction(`Clue scroll (${tier.name})`, readActions());
  api.onBeforeNpcInteraction(talk);
  api.onBeforeObjectInteraction(search);
  api.onCanUseItem(dig);
  api.onCustomEvent("player:emote", emote);
  api.onCustomEvent("audio:play-song", songPlayed);
  api.onCustomEvent("collection-log:category-count", categoryCount);
  api.onPlayerLogin(restore);
  api.onPlayerLogout(leave);
  api.onPlayerDisconnect(leave);
};

Object.assign(module.exports, { META_PREFIX, EMOTE_RADIUS, MUSIC_RADIUS, data, tierOfItem, trailLength, stateOf, trails, read, checkSteps,
  advance, talk, search, dig, emote, songPlayed, emoteReady, clueText, restore, categoryCount, completedAttribute, metaKey });
