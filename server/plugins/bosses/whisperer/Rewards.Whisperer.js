const Common = require('./Common.Whisperer');
// Current rev241 task descriptions; limits are strict and exclude Slayer tasks.
const SPEEDS = [['Whisperer Speed-Trialist', 180], ['Whisperer Speed-Chaser', 145], ['Whisperer Speed-Runner', 125]];
function begin(fight) {
  fight.arceuusOnly = fight.player.getSpellbook() === Common.core.MagicSpellbook.ARCEUUS;
  fight.preEnrageShadowTicks = 0;
  fight.onSlayerTask = false;
  observe(fight);
}
function observe(fight) {
  if (fight.player.getSpellbook() !== Common.core.MagicSpellbook.ARCEUUS)
    fight.arceuusOnly = false;
  const task = { player: fight.player, npc: fight.boss, onTask: false };
  Common.api.emitCustomEvent('slayer:on-task', task);
  fight.onSlayerTask ||= task.onTask;
}
function process(fight) {
  observe(fight);
  if (fight.shadow && !fight.enraged)
    fight.preEnrageShadowTicks++;
}
function attack({ attacker, target }) {
  const fight = target?.__whispererFight;
  if (fight?.alive() && attacker === fight.player)
    observe(fight);
}
function complete(fight) {
  const player = fight.player;
  const award = task => Common.api.emitCustomEvent('combat-achievements:complete', { player, task });
  if (fight.perfectKill)
    fight.session.perfectKills = (fight.session.perfectKills ?? 0) + 1;
  if (fight.session.perfectKills >= 5)
    award('Perfect Whisperer');
  if (fight.arceuusOnly)
    award('Tentacular');
  if (fight.preEnrageShadowTicks < 10)
    award('Dark Memories');
  if (!fight.onSlayerTask)
    for (const [name, seconds] of SPEEDS)
      if (fight.elapsedTicks * .6 < seconds)
        award(name);
}
module.exports = { begin, observe, process, attack, complete };
