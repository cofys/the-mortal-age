"use strict";

const TABLES = require("../../data/definitions/clue-caskets.json").tables;

function randomValue(random) {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error("Invalid casket reward random value");
  return value;
}

function rollTable(table, count, random = Math.random) {
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
  const drops = [];
  for (let i = 0; i < count; i++) {
    let hit = randomValue(random) * total;
    const row = table.entries.find(entry => (hit -= entry.weight) < 0);
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

function roll(tier, count, random = Math.random) {
  if (!Object.prototype.hasOwnProperty.call(TABLES, tier)) throw new Error("Unsupported casket reward tier");
  return rollTable(TABLES[tier], count, random);
}

module.exports = { roll, rollTable };
