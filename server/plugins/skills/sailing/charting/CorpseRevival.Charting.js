const common = require("./Common.Charting");
const CORPSE_KEY = "drink_crate_corpse_reviver";
const FULL_HITPOINTS = 90;
const MAX_REVIVALS = 9;

function configure(state, npc) {
  if (state.key !== CORPSE_KEY) return;
  // Wiki supplies the cap; uniform 0..9 per encounter is an explicitly estimated distribution.
  state.corpse = { npc, remaining: common.core().Misc.randomInclusive(0, MAX_REVIVALS) };
}

function beforeDeath(event) {
  const { npc } = event;
  if (event.preventDeath || npc.getHitpoints() > 0 || !npc.isRegistered()) return;
  const effects = require("./DrinkEffects.Charting");
  const owner = npc.getOwner();
  const state = effects.effects.get(owner)?.get(CORPSE_KEY);
  if (!state || state.corpse?.npc !== npc || !state.npcs.has(npc) || !effects.alive(state)
    || npc.getArea() !== common.core().BoatManager.getDeck(state.boat) || state.corpse.remaining <= 0) return;
  state.corpse.remaining--;
  event.preventDeath = true;
  // RSProx235/00948: same NPC, full health, no death animation, unchanged attack cadence.
  // Intermediate deaths never enter NPCDeathTask. Ordinary final death credit/drop policy is estimated.
  npc.setHitpoints(FULL_HITPOINTS);
  owner.sendMessage("The corpse seems to regenerate again!");
  npc.forceChat("Urrrrr...");
}

function attach(api) {
  api.onNpcBeforeDeath(beforeDeath);
}
module.exports = { attach, configure };
