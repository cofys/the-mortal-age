// Acquisition conditions and activity rolls; generated NPC drop rows remain canonical.
let api;
const PLUCKED = new WeakSet();
function eligible(player, pet) {
  if (!player || !pet) return false;
  const reward = pet.requiredDiaryReward;
  if (reward === undefined) return true;
  if (!reward || typeof reward !== "object" || typeof reward.diary !== "string" || typeof reward.tier !== "string") return false;
  const request = {player, diary: reward.diary, tier: reward.tier, claimed: false};
  api.emitCustomEvent("diary:is-reward-claimed", request);
  return request.claimed === true;
}
function chickEntry(entry) {
  return entry.item_id === api.core.ItemIdentifiers.CHOMPY_CHICK;
}
function plucked({player, npc}) {
  // The quest emits this after consuming its exact owned carcass. Keep identity,
  // not index: an NPC slot may later be reused by another bird.
  if (!player || !npc || npc.getId() !== api.core.NpcIdentifiers.CHOMPY_BIRD_2 ||
      npc.getOwner() !== player || PLUCKED.has(npc)) return;
  PLUCKED.add(npc);
  const request = {player, itemId: api.core.ItemIdentifiers.CHOMPY_CHICK, eligible: false};
  api.emitCustomEvent("pets:eligible", request);
  if (!request.eligible) return;
  const drops = [];
  api.emitCustomEvent("npc-drops:roll-table", {
    player, npc, npcId: api.core.NpcIdentifiers.CHOMPY_BIRD,
    entryFilter: chickEntry, drops,
  });
  api.emitCustomEvent("npc-drops:roll", {player, npc, npcId: api.core.NpcIdentifiers.CHOMPY_BIRD, drops});
}
function attach(pluginApi) {
  api = pluginApi;
  api.onCustomEvent("chompy:plucked", plucked);
}
module.exports = {attach, eligible};
