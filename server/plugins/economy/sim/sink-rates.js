"use strict";

/**
 * sim/sink-rates.js — DESIGN TOOL, not a smoke test and not in-game code.
 *
 * Simulates the Wilderness PvP death sink at flat destruction rates so the
 * furnace can be tuned with numbers instead of gut feel. Run:
 *   node server/plugins/economy/sim/sink-rates.js
 *
 * Model (documented assumptions, all pessimistic-simple):
 *   - 200 active PKers, 3 contested-Wilderness deaths each per day (600 deaths/day)
 *   - Kit archetypes by carried gear value: 60% budget (300k), 30% mid (3m),
 *     10% whale (30m). Coins are never destroyed, so kits are gear+supplies.
 *   - Per-item destruction rolls average out per death: expected destroyed
 *     value per death ~= kitValue * rate. (Small kits have high variance —
 *     a 3-item budget kit can lose everything or nothing; the mean holds.)
 *   - Every destroyed gp of gear must be re-bought or re-made: destroyed
 *     value/day == crafter demand gp/day (upper bound; some victims quit or
 *     downgrade kits, which only softens demand).
 *   - "Player pain" = expected wealth destroyed per death, by archetype.
 *
 * What it does NOT model: killer loot (the surviving (1-rate) still drops,
 * so the Wilderness keeps its jackpot), price elasticity (demand moves
 * prices per Prices.Economy), or behavioral response (higher rates push
 * risk-averse players to cheaper kits — the classic sink self-balance).
 */

const RATES = [0.35, 0.5, 0.65];
const PKERS = 200;
const DEATHS_PER_PKER_DAY = 3;
const ARCHETYPES = [
  { name: "budget", share: 0.6, kitValue: 300_000 },
  { name: "mid", share: 0.3, kitValue: 3_000_000 },
  { name: "whale", share: 0.1, kitValue: 30_000_000 },
];

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "b";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "m";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return String(Math.round(n));
}

function simulate(rate) {
  const deathsPerDay = PKERS * DEATHS_PER_PKER_DAY;
  let destroyedPerDay = 0;
  const pain = {};
  for (const a of ARCHETYPES) {
    const deaths = deathsPerDay * a.share;
    const destroyed = deaths * a.kitValue * rate;
    destroyedPerDay += destroyed;
    pain[a.name] = a.kitValue * rate; // expected loss per death
  }
  return { rate, deathsPerDay, destroyedPerDay, pain };
}

function main() {
  console.log("Wilderness PvP sink simulation — flat destruction rate");
  console.log(`Population: ${PKERS} PKers x ${DEATHS_PER_PKER_DAY} deaths/day`);
  console.log("Kit mix: 60% budget (300k) / 30% mid (3m) / 10% whale (30m)");
  console.log("");
  console.log(
    "rate | destroyed/day | crafter demand/day | pain/death: budget | mid | whale"
  );
  console.log("-".repeat(78));
  for (const rate of RATES) {
    const s = simulate(rate);
    console.log(
      `${String(Math.round(rate * 100)).padStart(3)}% | ` +
        `${fmt(s.destroyedPerDay).padStart(13)} | ` +
        `${fmt(s.destroyedPerDay).padStart(18)} | ` +
        `${fmt(s.pain.budget).padStart(12)} | ` +
        `${fmt(s.pain.mid).padStart(9)} | ` +
        fmt(s.pain.whale)
    );
  }
  console.log("");
  console.log("Reading it:");
  console.log("- Crafter demand scales linearly with the rate: 50% destroys ~1.43x");
  console.log("  what 35% does; 65% destroys ~1.86x. There is no cliff — tuning is smooth.");
  console.log("- Player pain is proportional, never capped: a whale's bad day at 65%");
  console.log("  costs ~19.5m expected. That is the point (Jon 2026-10-06): the Wilderness");
  console.log("  must stay dangerous at every tier, or endgame gear never needs replacing.");
  console.log("- The surviving (1-rate) still drops for the killer, so the jackpot motive");
  console.log("  survives at every rate. The sink taxes the victim, not the thrill.");
  console.log("- Behavioral dampening (players risking cheaper kits as rates rise) means");
  console.log("  real-world demand will land BELOW these numbers — they are the ceiling.");
}

if (require.main === module) main();
module.exports = { simulate, RATES, ARCHETYPES, PKERS, DEATHS_PER_PKER_DAY };
