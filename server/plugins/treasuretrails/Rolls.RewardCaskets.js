"use strict";

const TABLES = require("../../data/definitions/clue-caskets.json").tables;

function randomValue(random) {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error("Invalid casket reward random value");
  return value;
}

/**
 * `count` rolls on a casket table. `multiplier(row)` makes a row that many times as likely: its
 * weight grows and the pool grows by the same, so the other rows keep their weights (a league's
 * boosted casket uniques).
 */
function rollTable(table, count, random = Math.random, multiplier = () => 1) {
  if (!table || !Number.isSafeInteger(table.out_of) || table.out_of < 1 ||
      !Array.isArray(table.entries) || !table.entries.length) throw new Error("Invalid casket reward table");
  if (!Number.isInteger(count) || count < 0 || !Array.isArray(table.rolls) ||
      !Number.isInteger(table.rolls[1]) || count > table.rolls[1]) throw new Error("Invalid casket roll count");
  let total = 0;
  for (const row of table.entries) {
    // A joint outcome grants every listed item on one roll (the exporter's `items`).
    if (!Number.isSafeInteger(row.weight) || row.weight < 1 || !(Array.isArray(row.items) ? row.items.length && row.items.every(validItem) : validItem(row)))
      throw new Error("Invalid casket reward entry");
    total += row.weight;
  }
  if (!Number.isSafeInteger(total) || total !== table.out_of) throw new Error("Incomplete casket reward probability pool");
  const weights = table.entries.map(row => {
    const factor = Number(multiplier(row));
    const weight = Number.isFinite(factor) && factor > 1 ? row.weight * factor : row.weight;
    total += weight - row.weight;
    return weight;
  });
  const drops = [];
  for (let i = 0; i < count; i++) {
    let hit = randomValue(random) * total;
    const row = table.entries.find((entry, index) => (hit -= weights[index]) < 0);
    if (!row) throw new Error("Invalid casket reward selection");
    for (const item of Array.isArray(row.items) ? row.items : [row]) {
      const [minimum, maximum] = item.quantity;
      const amount = minimum === maximum ? minimum : minimum + Math.floor(randomValue(random) * (maximum - minimum + 1));
      drops.push({ itemId: item.item_id, amount, noted: item.noted });
    }
  }
  return drops;
}

function validItem(item) {
  return Number.isSafeInteger(item.item_id) && item.item_id >= 0 && typeof item.noted === "boolean" &&
    Array.isArray(item.quantity) && item.quantity.length === 2 &&
    item.quantity.every(value => Number.isSafeInteger(value) && value > 0) && item.quantity[0] <= item.quantity[1];
}

function roll(tier, count, random = Math.random, multiplier = () => 1) {
  if (!Object.prototype.hasOwnProperty.call(TABLES, tier)) throw new Error("Unsupported casket reward tier");
  return rollTable(TABLES[tier], count, random, multiplier);
}

/** The source casket rolls name on "drops:chance" { player, source, rules }. */
const UNIQUES_SOURCE = "treasure-trails-casket";
/** The dump's sections of a tier's unique rewards ("Hard clue uniques", "Mega-rare table - Hard clues"). */
const UNIQUES_SECTION = /clue uniques$|^mega.?rare table/i;

/**
 * The row multiplier for one player's casket: asks "drops:chance" (a league's boosted drops
 * answer it) and makes each unique row the matching rules' product as likely; other rows stay.
 * Every casket roll uses it, the ordinary Open and the Mimic's alike.
 */
function uniqueMultiplier(api, player) {
  const rules = [];
  if (player && api) api.emitCustomEvent("drops:chance", { player, source: UNIQUES_SOURCE, rules });
  if (rules.length === 0) return () => 1;
  return (row) => (UNIQUES_SECTION.test(row.section ?? "")
    ? rules.reduce((boost, rule) => (rule.pattern.test(row.name ?? "") ? boost * rule.multiplier : boost), 1)
    : 1);
}

module.exports = { roll, rollTable, uniqueMultiplier, UNIQUES_SOURCE, UNIQUES_SECTION };
