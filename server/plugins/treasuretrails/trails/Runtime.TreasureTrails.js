"use strict";

const { randomUUID } = require("node:crypto");
const Catalogue = require("./Catalogue.TreasureTrails");
const Dialogue = require("./Dialogue.TreasureTrails");
const { TIERS } = require("./Tiers.TreasureTrails");
const META_PREFIX = "treasure-trails:";
// The clue helper names a target tile but no area. Emote steps accept the beginner
// runtime's usual radius around it; music steps need the player near Cecilia's bridge.
const EMOTE_RADIUS = 3;
const MUSIC_RADIUS = 5;
const URI_STANDARD = "standard-dialogue";
const URI_REFUSAL = "speaking-with-another-player-s-uri-or-with-incorrect-attire";
let api;
let core;
let catalogues = new Map();
const uris = new WeakMap();
// A trail's live fight (Wiki "Saradomin wizard", "Double agent"): player -> { npc, token }, and back.
const encounters = new WeakMap();
const encounterOwners = new WeakMap();
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
  if ([data(tier).byItem.get(item.getId()).challenge?.itemId, data(tier).byItem.get(item.getId()).puzzle?.itemId].includes(item.getId()))
    return trails(player).find(trail => trail.state.token === current?.token && trail.state.revision === current?.revision) ?? null;
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
    return tier && validState(tier, item, state) && data(tier).byItem.get(item.getId()).itemId === item.getId()
      ? [{ tier, item, slot, state, step: data(tier).byRow.get(state.row) }] : [];
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
  if (step.family === "anagram") return `This anagram reveals<br>who to speak to next:<br><br>${step.text}`;
  if (step.family === "cipher") return `The cipher reveals who to speak to:<br><br>${step.text}`;
  if (step.family === "fairyring") return `The cryptic reveals where to dig:<br><br>${step.text}`;
  return step.text;
}

function auxiliarySlot(player, trail, kind) {
  return player.getInventory().getItems().findIndex(item => item && item.getId() === trail.step[kind]?.itemId &&
    item.getMetaValue(metaKey(trail.tier))?.token === trail.state.token &&
    item.getMetaValue(metaKey(trail.tier))?.revision === trail.state.revision);
}
function challengeSlot(player, trail) { return auxiliarySlot(player, trail, "challenge"); }
function puzzleSlot(player, trail) { return auxiliarySlot(player, trail, "puzzle"); }
function holdsChallenge(player, trail) { return challengeSlot(player, trail) >= 0; }

function read(event) {
  if (!clicked(event)) return false;
  const sender = event.player.getPacketSender();
  const item = event.player.getInventory().getItems()[event.slot];
  const tier = tierOfItem(item.getId());
  const step = data(tier).byItem.get(item.getId());
  if (item.getId() === step.challenge?.itemId) {
    const group = data(tier).textInterface;
    sender.sendInterface(group);
    sender.sendString(step.challenge.question, (group << 16) | 2);
    return true;
  }
  const trail = stateOf(event.player, event.slot);
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

/** `said` overrides the hand-over message, as the giving NPC's transcript words it: { clue, casket }. */
function advance(player, snapshot, random = Math.random, said = {}, show = true, removeUri = true) {
  const trail = stillHeld(player, snapshot);
  if (!trail) return false;
  if (removeUri) dismissUri(player);
  dismissEncounter(player);
  const inventory = player.getInventory();
  for (const kind of ["challenge", "puzzle"]) {
    const slot = auxiliarySlot(player, trail, kind);
    if (slot >= 0) inventory.setItem(slot, new core.Item(-1, 0));
  }
  const completed = trail.state.completed + 1;
  let received, words;
  // A step's own progress ends with it.
  const { defeated, solved, image, ...carried } = trail.state;
  if (completed >= trail.state.length) {
    // The exact slot matters when scrolls of several tiers are carried.
    received = new core.Item(data(trail.tier).casket, 1);
    words = said.casket ?? "You've obtained a casket!";
  } else {
    const step = pick(data(trail.tier).steps, random);
    received = stepItem(trail.tier, step, { ...carried, completed, revision: trail.state.revision + 1 });
    words = said.clue ?? "You've found another clue!";
  }
  inventory.setItem(trail.slot, received);
  inventory.refreshItems();
  if (show) Dialogue.itemBox(player, received.getId(), words);
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
    if (!trail) { dismissUri(player); return; }
    event.handled = true;
    meetUri(player, npc, npcId, trail);
    return;
  }
  const trail = startedTrails(player).find(entry => ["anagram", "cryptic", "cipher", "music"].includes(entry.step.family) &&
    entry.step.target === "npc" && entry.step.npcIds.includes(npcId));
  if (!trail) return;
  event.handled = true;
  if (trail.step.family === "music") { hearSong(player, npcId, trail); return; }
  if (trail.step.puzzle?.itemId != null) {
    if (puzzleSlot(player, trail) >= 0) puzzleAgain(player, npc, npcId, trail);
    else handOutPuzzle(player, npc, npcId, trail);
    return;
  }
  if (trail.step.challenge?.itemId != null) {
    if (holdsChallenge(player, trail)) askAnswer(player, npc, npcId, trail);
    else handOutChallenge(player, npc, npcId, trail);
    return;
  }
  const steps = Dialogue.transcript(player, npc, npcId, `treasure-trails-${trail.tier.name}`);
  const said = Dialogue.lines(steps, Math.random, npcName(npcId));
  // The talk began beside the NPC; a wandering NPC (Elder Torgan) may step away during it.
  Dialogue.play(player, npcId, said.length ? said : [{ npc: "Well done, you've found me!" }], () => advance(player, trail, Math.random,
    { clue: Dialogue.message(steps) ?? `${npcName(npcId)} has given you another clue scroll!`, casket: Dialogue.message(steps, true) ?? "You've obtained a casket!" }));
}

/** Uri (Wiki transcript): wrong attire or a missing emote gets his refusal; otherwise a random phrase. */
function meetUri(player, npc, npcId, trail) {
  const active = uris.get(player);
  const ready = emoteReady(player, trail.step) && active.done >= trail.step.emotes.length;
  if (!ready) {
    const refusal = Dialogue.lines(Dialogue.transcript(player, npc, npcId, URI_REFUSAL), Math.random, npcName(npcId));
    Dialogue.play(player, npcId, refusal.length ? refusal : [{ npc: "I do not believe we have any business, Comrade." }]);
    return;
  }
  const steps = Dialogue.transcript(player, npc, npcId, URI_STANDARD);
  const said = steps ? Dialogue.lines(steps, Math.random, npcName(npcId)) : [];
  // The standard variant is a random phrase, then the player's "What?" and the hand-over.
  const what = steps?.find(step => typeof step.player === "string");
  const casket = trail.state.completed + 1 >= trail.state.length;
  const words = (!casket && trail.tier.uriClueMessage) || Dialogue.message(steps, casket) || (casket ? "You've obtained a casket!" : "You have been given a new clue!");
  if (!advance(player, trail, Math.random, {}, false, false)) return;
  const received = !casket && trail.tier.uriClueDisplay ? core.CacheDefinitions.getObjId(trail.tier.uriClueDisplay) : player.getInventory().getItems()[trail.slot].getId();
  Dialogue.play(player, npcId, what ? [...said, { player: what.player }] : said,
    () => {
      if (uris.get(player)?.npc === npc) dismissUri(player);
      Dialogue.itemBox(player, received, words);
    });
}

function npcName(npcId) {
  return core.CacheDefinitions.getNpc(npcId)?.name ?? "";
}

/** The challenge is carried alongside its clue; it does not count as another trail step. */
function handOutChallenge(player, npc, npcId, trail) {
  const steps = Dialogue.transcript(player, npc, npcId, `treasure-trails-${trail.tier.name}`);
  Dialogue.play(player, npcId, Dialogue.lines(steps, Math.random, npcName(npcId)), () => {
    const current = stillHeld(player, trail);
    // The talk began beside the NPC; a wandering NPC (the flax keeper) may have stepped away since.
    if (!current || holdsChallenge(player, current)) return;
    const inventory = player.getInventory();
    const slot = inventory.getItems().findIndex(item => !item || item.getAmount() <= 0);
    if (slot < 0) { player.sendMessage("You need a free inventory space to receive a challenge scroll."); return; }
    const scroll = new core.Item(current.step.challenge.itemId, 1).setMetaValue(metaKey(current.tier), { ...current.state });
    inventory.setItem(slot, scroll);
    inventory.refreshItems();
    Dialogue.itemBox(player, scroll.getId(), Dialogue.message(steps) ?? `${npcName(npcId)} has given you a challenge scroll!`);
  });
}

/** A puzzle box remains linked to the held clue, like its question challenge. */
function handOutPuzzle(player, npc, npcId, trail) {
  const steps = Dialogue.transcript(player, npc, npcId, `treasure-trails-${trail.tier.name}`);
  Dialogue.play(player, npcId, Dialogue.speech(steps), () => {
    const current = stillHeld(player, trail);
    if (!current || puzzleSlot(player, current) >= 0) return;
    const inventory = player.getInventory(), slot = inventory.getItems().findIndex(item => !item || item.getAmount() <= 0);
    if (slot < 0) { player.sendMessage("You need a free inventory space to receive a puzzle box."); return; }
    const state = { ...current.state, image: pick(current.tier.puzzleImages), solved: false };
    inventory.setItem(slot, new core.Item(current.step.puzzle.itemId, 1).setMetaValue(metaKey(current.tier), state));
    player.getInventory().refreshItems();
    player.sendMessage(Dialogue.message(steps) ?? `${npcName(npcId)} has given you a puzzle box!`);
  });
}

/** With the box solved the NPC gives the next clue; unsolved, it asks again. */
function puzzleAgain(player, npc, npcId, trail) {
  const box = player.getInventory().getItems()[puzzleSlot(player, trail)];
  const solved = box?.getMetaValue(metaKey(trail.tier))?.solved === true;
  const steps = Dialogue.puzzleTranscript(player, npc, npcId, trail.tier.name, solved);
  const said = Dialogue.lines(steps);
  if (!solved) {
    Dialogue.play(player, npcId, said.length ? said : [{ npc: "Sorry but you haven't solved the puzzle yet." }]);
    return;
  }
  Dialogue.play(player, npcId, said, () => {
    const latest = stillHeld(player, trail);
    if (!latest) return;
    const box = player.getInventory().getItems()[puzzleSlot(player, latest)];
    if (box?.getMetaValue(metaKey(latest.tier))?.solved !== true) return;
    const casket = latest.state.completed + 1 >= latest.state.length;
    const words = Dialogue.message(steps, casket);
    advance(player, latest, Math.random, casket ? { casket: words ?? "You've obtained a casket!" } :
      { clue: words ?? `${npcName(npcId)} has given you another clue scroll!` });
  });
}

/** Talking again asks for the answer; a wrong one costs nothing (Wiki "Challenge scroll"). */
function askAnswer(player, npc, npcId, trail) {
  const steps = Dialogue.againTranscript(player, npc, npcId, trail.tier.name);
  const prompt = Dialogue.lines(steps, Math.random, npcName(npcId));
  const ask = prompt.find(line => line.npc)?.npc ?? "Please enter the answer to the question.";
  Dialogue.play(player, npcId, prompt.length ? prompt : [{ npc: ask }], () => {
    player.setEnteredAmountAction({ execute: amount => answered(player, npc, npcId, trail, steps, amount) });
    player.getPacketSender().sendEnterAmountPrompt("Enter amount:");
  });
}

function answered(player, npc, npcId, trail, steps, amount) {
  const current = stillHeld(player, trail);
  if (!current || !holdsChallenge(player, current)) return;
  if (Number(amount) !== Number(current.step.challenge.answer)) {
    const wrong = Dialogue.lines(Dialogue.wrongBranch(steps), Math.random, npcName(npcId));
    Dialogue.play(player, npcId, wrong.length ? wrong : [{ npc: "Wrong! Try again." }]);
    return;
  }
  const correct = Dialogue.correctBranch(steps);
  const said = Dialogue.lines(correct, Math.random, npcName(npcId));
  Dialogue.play(player, npcId, said.length ? said : [{ npc: "Correct." }], () => {
    const latest = stillHeld(player, current);
    if (!latest || !holdsChallenge(player, latest)) return;
    const casket = latest.state.completed + 1 >= latest.state.length;
    const words = Dialogue.message(correct, casket);
    advance(player, latest, Math.random, casket ? { casket: words ?? "You've obtained a casket!" } :
      { clue: words ?? `${npcName(npcId)} has given you another clue scroll!` });
  });
}

function search(event) {
  if (event.handled) return;
  const { player, objectId } = event;
  const trail = startedTrails(player).find(entry => ["loc", "key"].includes(entry.step.target) && entry.step.locIds.includes(objectId) &&
    distance(event.location, entry.step.location) === 0);
  if (!trail) return;
  const inventory = player.getInventory();
  event.handled = true;
  // The exact locked-note wording is not in the cache; its helper supplies the key's source.
  if (trail.step.target === "key" && !inventory.getItems().some(item => item && item.getId() === trail.step.keyItem)) {
    player.sendMessage(`It is locked. ${trail.step.description}`);
    return;
  }
  if (trail.step.target === "key") inventory.delete(trail.step.keyItem, 1);
  advance(player, trail);
}

/** Killing one of a keyed step's NPCs drops its key while the player has none (Wiki cryptic clues). */
function keyDrop({ player, npcId, drops }) {
  if (!player || !Array.isArray(drops)) return;
  const trail = trails(player).find(entry => entry.step.target === "key" && entry.step.npcIds.includes(npcId));
  if (!trail || player.getInventory().getItems().some(item => item && item.getId() === trail.step.keyItem)) return;
  drops.push({ itemId: trail.step.keyItem, amount: 1 });
}

function dig(event) {
  const I = core.ItemIdentifiers;
  if (event.allow === false || !/\bdig\b/i.test(String(event.option)) || ![I.SPADE, I.EASTFLOOR_SPADE].includes(event.itemId)) return;
  const { player } = event;
  if (!player.getInventory().getItems().some(item => item && item.getId() === event.itemId)) return;
  const trail = startedTrails(player).find(entry => ["map", "cryptic", "coordinate", "fairyring"].includes(entry.step.family) &&
    entry.step.target === "coord" && distance(location(player), entry.step.location) === 0);
  if (!trail) return;
  event.allow = false;
  player.performAnimation(new core.Animation(core.CacheDefinitions.getSeqId("human_dig") ?? 830));
  // Wiki coordinates guide: the dig summons the step's wizard, who must be beaten before digging again.
  if (trail.step.encounter && trail.state.defeated !== true) {
    if (!liveEncounter(player, trail)) summon(player, trail);
    return;
  }
  advance(player, trail);
}

function liveEncounter(player, trail) {
  const active = encounters.get(player);
  if (!active || active.token !== trail.state.token) return null;
  const registered = typeof active.npc.isRegistered !== "function" || active.npc.isRegistered();
  return registered && active.npc.getHitpoints() > 0 ? active : null;
}

function freeTile(player) {
  const origin = player.getLocation();
  const region = api.getRegionManager();
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => new core.Location(origin.getX() + dx, origin.getY() + dy, origin.getZ()))
    .find(tile => !region.blocked(tile, player.getPrivateArea?.()) && region.canMovestart(origin, tile, 1, 1, player.getPrivateArea?.()));
}

/** Spawns the step's fight for the player alone and sets it on them. */
function summon(player, trail) {
  dismissEncounter(player);
  const spot = freeTile(player);
  if (!spot) return null;
  const npc = api.spawnNpc({ id: trail.step.encounter.npcIds[0], x: spot.getX(), y: spot.getY(), z: spot.getZ(), owner: player, ownerOnly: true, wanderRadius: 0 });
  if (!npc) return null;
  encounters.set(player, { npc, token: trail.state.token });
  encounterOwners.set(npc, player);
  npc.getCombat?.().attack(player);
  return npc;
}

function dismissEncounter(player) {
  const active = encounters.get(player);
  if (active && (typeof active.npc.isRegistered !== "function" || active.npc.isRegistered()) && active.npc.getHitpoints() > 0) api.removeNpc(active.npc);
  encounters.delete(player);
}

/** A beaten fight marks the trail; a double agent's death also brings Uri. */
function encounterDied({ npc }) {
  const player = encounterOwners.get(npc);
  const active = player && encounters.get(player);
  if (!active || active.npc !== npc) return;
  encounters.delete(player);
  const trail = trails(player).find(entry => entry.state.token === active.token);
  if (!trail) return;
  const state = { ...trail.state, defeated: true, revision: trail.state.revision + 1 };
  trail.item.setMetaValue(metaKey(trail.tier), state);
  player.getInventory().refreshItems();
  if (trail.step.family === "emote" && emoteReady(player, trail.step)) spawnUri(player, { ...trail, state });
}

function wearing(player, requirement) {
  if (requirement.emptySlot != null)
    return !player.getEquipment().getItems().some(item => item && item.getId() > 0 && core.ItemDefinition.forId(item.getId()).getEquipmentType().getSlot() === requirement.emptySlot);
  return player.getEquipment().getItems().some(item => item && (requirement.anyOf ? requirement.anyOf.includes(item.getId()) :
    core.CacheDefinitions.getItem(item.getId())?.params?.get?.(Catalogue.TRAIL_ITEM_GROUP_PARAM) === requirement.group));
}

function emoteReady(player, step) {
  return step.family === "emote" && distance(location(player), step.location) <= EMOTE_RADIUS &&
    step.equipment.every(requirement => wearing(player, requirement));
}

function emote({ player, slot }) {
  // Medium steps ask for a second emote after Uri appears, before he is spoken to.
  const active = uris.get(player);
  const pending = active && stillHeld(player, active.trail);
  if (pending && active.done < pending.step.emotes.length && pending.step.emotes[active.done] === slot && emoteReady(player, pending.step)) {
    active.done++;
    return;
  }
  const trail = startedTrails(player).find(entry => entry.step.family === "emote" && entry.step.emotes[0] === slot && emoteReady(player, entry.step));
  if (!trail) return;
  // Wiki "Double agent": hard steps send the agent first, unless the emote is the trail's first step.
  if (trail.step.encounter && trail.state.defeated !== true && trail.state.completed > 0) {
    if (!liveEncounter(player, trail)) { dismissUri(player); summon(player, trail); }
    return;
  }
  spawnUri(player, trail);
}

function spawnUri(player, trail) {
  dismissUri(player);
  const spot = freeTile(player);
  if (!spot) return;
  const npc = api.spawnNpc({ id: data(trail.tier).uri, x: spot.getX(), y: spot.getY(), z: spot.getZ(), owner: player, ownerOnly: true, wanderRadius: 0 });
  if (npc) uris.set(player, { npc, trail, done: 1 });
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

function leave({ player }) { dismissUri(player); dismissEncounter(player); }

function readActions() {
  return { Read: read, "Check steps": checkSteps };
}

module.exports = function attachTreasureTrails(pluginApi) {
  api = pluginApi;
  core = api.core;
  // Build before gameplay so the first object/NPC click cannot stall a game tick.
  catalogues = new Map(TIERS.map(tier => [tier.name, Catalogue.load(core, tier)]));
  for (const tier of TIERS) api.persistAttribute(completedAttribute(tier), 0);
  Dialogue.attach(api);
  for (const tier of TIERS) api.onItemAction(`Clue scroll (${tier.name})`, readActions());
  for (const tier of TIERS) api.onItemAction(`Challenge scroll (${tier.name})`, { Read: read });
  api.onCustomEvent("npc-drops:add", keyDrop);
  api.onBeforeNpcInteraction(talk);
  api.onBeforeObjectInteraction(search);
  api.onCanUseItem(dig);
  api.onCustomEvent("player:emote", emote);
  api.onCustomEvent("audio:play-song", songPlayed);
  api.onCustomEvent("collection-log:category-count", categoryCount);
  api.onPlayerLogin(restore);
  api.onPlayerLogout(leave);
  api.onPlayerDisconnect(leave);
  api.onPlayerDeath(leave);
  api.onNpcDeath(encounterDied);
};

Object.assign(module.exports, { META_PREFIX, EMOTE_RADIUS, MUSIC_RADIUS, data, tierOfItem, trailLength, stateOf, trails, read, checkSteps,
  advance, puzzleSlot, talk, search, keyDrop, dig, emote, encounterDied, songPlayed, emoteReady, answered, clueText, restore, categoryCount, completedAttribute, metaKey });
