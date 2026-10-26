/**
 * Enchantment Ritual, as recorded (rsprox 227/01850, 01855 and 01723; forestry.json `ritual`):
 * - a Dryad appears by the tree, and each step five ritual circles within three tiles of her;
 * - the odd circle is the one whose colour and shape are both unique among the five (true of all
 *   eight recorded steps); standing on it when the step closes scores it;
 * - a step lasts 30 ticks: the circles fade at 27, when it's scored, and the next five come at
 *   30; after eight steps she leaves ("You all completed every ritual step, amazing!" when every
 *   one was done) with "Well done, you completed N steps of the ritual! The Dryad has left you a
 *   gift..." and the bark lump.
 * Wiki: 20-21 bark and 2 x level + 60 Woodcutting XP a step; 2 x steps x level + 55 at the end;
 * recorded lumps were about 18 a step. Unknown: what more players change.
 */
const Common = require("./Common.Forestry");
const Spawns = require("./Spawns.Forestry");

const R = () => Common.data.ritual;
/** Rituals now on the map. */
const events = new Set();

function start(site) {
  const ritual = R();
  const tiles = Common.freeTiles(site.location, ritual.range, site.size);
  if (tiles.length < 1) return null;
  const event = { site, step: 0, elapsed: 0, circles: [], odd: null, steps: new Map(), over: false };
  event.dryad = Common.spawnNpc(ritual.npc, tiles[0], ritual.graphics.spawn);
  if (!placeCircles(event)) {
    Common.removeNpc(event.dryad);
    return null;
  }
  events.add(event);
  Common.every(() => tick(event));
  return event;
}

/**
 * Five circles: two colours by two shapes, and one more whose colour and shape are neither, so
 * it alone is odd (as every recorded step was).
 */
function pickCircles() {
  const colours = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
  const shapes = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
  const grid = [[0, 0], [0, 1], [1, 0], [1, 1]].map(([c, s]) => [colours[c], shapes[s]]);
  return { odd: [colours[2], shapes[2]], others: grid };
}

function placeCircles(event) {
  const ritual = R();
  const tiles = Common.freeTiles(event.dryad.getLocation(), ritual.range).filter((t) => !t.equals(event.dryad.getLocation()));
  if (tiles.length < 5) return false;
  const { odd, others } = pickCircles();
  const all = [odd, ...others].sort(() => Math.random() - 0.5);
  // forestry.json `circles` is by shape (a-d), then colour (1-4), as the cache names them.
  event.circles = all.map(([colour, shape], i) => ({ colour, shape, npc: Common.spawnNpc(ritual.circles[shape][colour], tiles[i]), at: tiles[i] }));
  event.odd = event.circles.find((c) => c.colour === odd[0] && c.shape === odd[1]);
  return true;
}

function clearCircles(event) {
  for (const circle of event.circles) Common.removeNpc(circle.npc);
  event.circles = [];
  event.odd = null;
}

/** The step closes: whoever stands on the odd circle scores it. */
function score(event) {
  if (!event.odd) return;
  const ritual = R();
  for (const circle of event.circles) Common.animate(circle.npc, ritual.seqs.circleGone);
  const at = event.odd.at;
  const standing = [...new Set([...event.site.participants, ...Common.nearbyPlayers(at, 0)])].filter((p) => p.getLocation().equals(at));
  for (const player of standing) {
    if (!Spawns.eligible(event, player)) {
      Common.xp(player, "WOODCUTTING", 1);
      continue;
    }
    event.steps.set(player, (event.steps.get(player) ?? 0) + 1);
    Common.xp(player, "WOODCUTTING", ritual.xp.perLevel * Common.level(player, "WOODCUTTING") + ritual.xp.plus);
    Common.bark(player, Common.randomInt(...ritual.stepBark));
  }
}

function tick(event) {
  if (event.over) return false;
  event.elapsed++;
  const { stepTicks, scoreAt, steps } = R();
  const inStep = event.elapsed - event.step * stepTicks;
  if (inStep === scoreAt) score(event);
  if (inStep >= stepTicks) {
    clearCircles(event);
    event.step++;
    if (event.step >= steps) {
      end(event);
      return false;
    }
    if (!placeCircles(event)) {
      end(event);
      return false;
    }
  }
  return true;
}

function end(event) {
  event.over = true;
  events.delete(event);
  const ritual = R();
  clearCircles(event);
  const everyStep = event.steps.size > 0 && [...event.steps.values()].every((n) => n === ritual.steps);
  if (everyStep) event.dryad.forceChat?.(Common.message("ritualAll"));
  event.dryad.performGraphic?.(new Common.core.Graphic(ritual.graphics.leave));
  Common.animate(event.dryad, ritual.seqs.leave);
  Common.later(ritual.leaveTicks, () => Common.removeNpc(event.dryad));
  for (const [player, steps] of event.steps) {
    player.sendMessage(Common.message("ritualDone", { steps }));
    Common.bark(player, Math.round(ritual.lumpPerStep * steps), true);
    Common.xp(player, "WOODCUTTING", ritual.xp.perLevel * steps * Common.level(player, "WOODCUTTING") + ritual.xp.bonusPlus);
  }
  Spawns.ended(event);
}

function eventOf(npc) {
  for (const event of events) if (event.dryad === npc) return event;
  return null;
}

/** Recorded: her greeting and the menu. */
function talk({ player, npc }) {
  if (!eventOf(npc)) return false;
  const [hello, ask, no, yes, explain] = Common.data.messages.dryad;
  const id = R().npc;
  Common.chat(player, id, [["player", hello], ["npc", ask]], () => {
    Common.menu(player,
      [no, () => Common.chat(player, id, [["player", no]])],
      [yes, () => Common.chat(player, id, [["player", yes], ["npc", explain]])]);
  });
  return true;
}

function attachRitual(api) {
  Spawns.registerEvent("ritual", { start });
  api.onNpcInteraction("Dryad", { "Talk-to": talk });
}

module.exports = { attachRitual, start, pickCircles, score, end, events };
