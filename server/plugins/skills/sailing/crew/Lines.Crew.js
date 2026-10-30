// What crewmates say over their heads at sea, from their Wiki transcripts' at-sea variants
// (data/definitions/npc-dialogues.json): idle chatter, at the helm, trimming the sails, at a
// salvaging hook and on hooking salvage. Live says these (rsprox: Jobless Jim's idle lines and
// "Managed to hook some salvage! I'll put it in the cargo hold.", Jenkins's "Woooo"s).
const fs = require("fs");
const path = require("path");
const common = require("./Common.Crew");

/** Variant names per situation, first found wins; a crewmate without one says their at-sea lines. */
const SITUATIONS = Object.freeze({
  idle: ["at-sea-while-idle", "while-at-sea-while-idle", "while-at-sea"],
  helm: ["at-sea-randomly-while-at-the-helm", "while-at-sea-randomly-while-at-the-helm"],
  trim: ["at-sea-trimming-the-sails"],
  hook: ["at-sea-while-at-the-salvaging-hook", "at-sea-randomly-while-at-the-salvaging-hook"],
  salvaged: ["at-sea-recovering-salvaging"],
});
/** Lines under one condition of a variant, by what happened. */
const CONDITIONAL = Object.freeze({
  salvaged: ["at-sea-recovering-salvaging", /with space in the cargo hold/i],
  holdFull: ["at-sea-recovering-salvaging", /cargo hold is full/i],
  tooComplicated: ["at-sea-recovering-salvaging", /sailing level for the ship/i],
  noRepairKits: ["at-sea-making-repairs", /no repair kits/i],
  repaired: ["at-sea-making-repairs", /there are repair kits/i],
  noAmmo: ["at-sea-idle-at-cannon", /no cannon balls/i],
});
/** Said only when their transcript has it; a crewmate without one says the captured line instead. */
const NO_FALLBACK = new Set(["helm", "hook", "repaired", "noAmmo"]);
const FALLBACK = ["while-at-sea", "at-sea-while-idle"];

/** Per crewmate id: situation -> lines. Read once, keeping only the crew pages. */
let lines;
/** The crew pages themselves (their variants), for conversations played from part of a variant. */
const pages = new Map();

function npcLines(steps, filter) {
  const found = [];
  const walk = (list, inside) => {
    for (const step of list ?? []) {
      if (step?.type === "condition") {
        walk(step.steps, filter ? filter.test(String(step.text ?? "")) : inside);
        continue;
      }
      if (typeof step?.npc === "string" && (inside || !filter) && !/\{\{|\[/.test(step.npc)) found.push(step.npc);
      walk(step?.steps, inside);
      for (const option of step?.options ?? []) walk(option.steps, inside);
    }
  };
  walk(steps, false);
  return found;
}

function load() {
  if (lines) return lines;
  lines = new Map();
  const file = path.join(common.core().GameConstants.DEFINITIONS_DIRECTORY, "npc-dialogues.json");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return lines;
  }
  for (const crew of common.all()) {
    if (data[crew.page]) pages.set(crew.page, data[crew.page]);
    const variants = data[crew.page]?.variants ?? {};
    const pick = (names, filter) => {
      for (const name of names) {
        const found = npcLines(variants[name], filter);
        if (found.length) return found;
      }
      return [];
    };
    const fallback = pick(FALLBACK);
    const byCrew = {};
    for (const [situation, names] of Object.entries(SITUATIONS)) {
      if (situation === "salvaged") continue;
      byCrew[situation] = pick(names);
    }
    for (const [situation, [variant, filter]] of Object.entries(CONDITIONAL)) {
      byCrew[situation] = pick([variant], filter);
    }
    // Jenkins says his "Woooo"s for everything; the generic crew have no at-sea lines to fall back on.
    for (const situation of Object.keys(byCrew)) {
      if (!byCrew[situation].length && !NO_FALLBACK.has(situation)) byCrew[situation] = fallback;
    }
    lines.set(crew.id, byCrew);
  }
  return lines;
}

/** A crewmate transcript variant's steps (data/definitions/npc-dialogues.json), or undefined. */
function variantSteps(page, variant) {
  load();
  return pages.get(page)?.variants?.[variant];
}

/**
 * The steps that follow a step (by its id) in the branch that holds it: the rest of a
 * conversation from that point.
 */
function stepsAfter(steps, stepId) {
  const search = (list) => {
    if (!Array.isArray(list)) return undefined;
    const index = list.findIndex((step) => step?.id === stepId);
    if (index >= 0) return list.slice(index + 1);
    for (const step of list) {
      const found = search(step?.steps) ?? (step?.options ?? []).map((option) => search(option.steps)).find(Boolean);
      if (found) return found;
    }
    return undefined;
  };
  return search(steps);
}

/** The first step in a variant that matches, depth first. */
function findStep(steps, match) {
  for (const step of steps ?? []) {
    if (match(step)) return step;
    const found = findStep(step?.steps, match) ?? (step?.options ?? []).map((option) => findStep(option.steps, match)).find(Boolean);
    if (found) return found;
  }
  return undefined;
}

/** One of a crewmate's lines for a situation, or undefined when their transcript has none. */
function lineFor(crew, situation, random = Math.random) {
  const options = load().get(crew.id)?.[situation] ?? [];
  return options.length ? options[Math.floor(random() * options.length)] : undefined;
}

/** Has the crewmate say a line for a situation over their head, if they have one. */
function say(npc, crew, situation) {
  const line = lineFor(crew, situation);
  if (line) npc.forceChat(line);
  return line;
}

module.exports = { SITUATIONS, lineFor, say, npcLines, variantSteps, stepsAfter, findStep };
