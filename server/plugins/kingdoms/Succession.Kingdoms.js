"use strict";

/**
 * Succession.Kingdoms — ARC-SEEDING for the long arc. READ CAREFULLY.
 *
 * The world bible locks this: Misthalin is "the heirless crown" — aging
 * Roald III, no named heir — and the hidden bastard son is a PHASE 10
 * custom questline. This module PLANTS SEEDS ONLY. It never resolves, never
 * names the son, never confirms anything, and never touches the
 * `misthalin:bastard-son-hidden` story flag (that flag belongs to the
 * questline, not to ambient content).
 *
 * What it does: a whisper-stage counter (`succession:whisper-stage` on
 * Misthalin, 0-4) advances very slowly — days per stage. Each new stage
 * drops ONE rare, deniable rumor into Varrock's streets via kingdom:rumor:
 *
 *   stage 1 — a drunk courtier's slip in a tavern
 *   stage 2 — a spymaster's redacted report, half-burned in a gutter
 *   stage 3 — a sermon on "the king's line" that stops mid-sentence
 *   stage 4 — a Riverlands merchant who saw a boy with the king's eyes
 *
 * A royal death anywhere in the realm can also stir a surge whisper
 * ("they say Roald looked grey at the funeral") — grief makes people talk.
 *
 * Everything here is deniable by design. If a player asks, the answer is
 * "drunk talk." The arc pays off in phase 10, not here.
 *
 * Out (custom events):
 *   kingdom:rumor { kingdomId: "misthalin", text }
 * In (custom events):
 *   kingdom:royal-event { type: "death", ... } — grief stirs whispers
 *
 * Numbers live in DESIGN.md.
 */

const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");
const Store = require("./KingdomStore");

// ~60 minutes at 600ms/tick. Whispers grow on a timescale of days.
const SUCCESSION_TICK_TICKS = 6000;
// How often a stage advances, per tick — roughly one stage per day.
const STAGE_ADVANCE_CHANCE = 0.04;
// Stages never advance faster than this.
const STAGE_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Grief stirs talk: a royal death anywhere has this chance of a surge whisper.
const DEATH_SURGE_CHANCE = 0.2;

const WHISPER_STAGE_FLAG = "succession:whisper-stage";
const LAST_ADVANCE_FLAG = "succession:last-advance-at";
const MAX_STAGE = 4;

let pluginApi = null;

// ARC-SEED content. Each text is a rumor, not a fact — deniable, oblique,
// and never naming the son. The stages escalate: tavern talk, then paper,
// then the Church, then a witness.
const STAGE_WHISPERS = {
  1: "A drunk courtier in the Blue Moon Inn slurred something about 'the king's heir' — " +
    "then went pale, laughed too loud, and ordered another round.",
  2: "A spymaster's report, half-burned in a Varrock gutter, reads: " +
    "'...the boy in [REDACTED]... the king's eyes... deny everything...'",
  3: "A priest of Saradomin began a sermon on 'the king's line continuing' — " +
    "and stopped mid-sentence, as if he'd said too much. The congregation noticed.",
  4: "A merchant from the Riverlands swears he saw a boy with the king's own eyes, " +
    "working a farm that pays no taxes. He won't say where. He won't say it twice.",
};

const DEATH_SURGE_WHISPERS = [
  "They say Roald looked grey at the funeral. Old kings bury old friends, and the court counts the years.",
  "At the funeral feast, they say, someone toasted 'the king's line' — and the table went very quiet.",
  "They say the old king wept at the graveside. For the dead man, or for having no son to stand beside him?",
];

function stageOf() {
  const raw = Store.getKingdom("misthalin")?.flags?.[WHISPER_STAGE_FLAG];
  return Number.isFinite(raw) ? Math.max(0, Math.min(MAX_STAGE, Math.floor(raw))) : 0;
}

function setStage(stage) {
  Store.setFlag("misthalin", WHISPER_STAGE_FLAG, stage);
  Store.setFlag("misthalin", LAST_ADVANCE_FLAG, Date.now());
  Store.save();
}

/** ARC-SEED: advance the whisper stage and drop the stage's rumor. */
function advanceStage() {
  const stage = stageOf();
  if (stage >= MAX_STAGE) return;
  const last = Store.getKingdom("misthalin")?.flags?.[LAST_ADVANCE_FLAG] ?? 0;
  if (Date.now() - last < STAGE_MIN_INTERVAL_MS) return;
  const next = stage + 1;
  setStage(next);
  pluginApi.emitCustomEvent("kingdom:rumor", {
    kingdomId: "misthalin",
    text: STAGE_WHISPERS[next],
  });
  console.info("[succession] arc-seed: whisper stage advanced", { stage: next });
}

/** ARC-SEED: grief stirs talk — a royal death anywhere loosens Varrock tongues. */
function onRoyalEvent(event) {
  if (event?.type !== "death") return;
  if (Math.random() >= DEATH_SURGE_CHANCE) return;
  const idx = Math.floor(Math.random() * DEATH_SURGE_WHISPERS.length);
  pluginApi.emitCustomEvent("kingdom:rumor", {
    kingdomId: "misthalin",
    text: DEATH_SURGE_WHISPERS[idx],
  });
}

function successionTick() {
  try {
    if (!Store.getKingdom("misthalin")) return;
    if (Math.random() < STAGE_ADVANCE_CHANCE) advanceStage();
  } catch (error) {
    console.warn("[succession] tick failed", error?.message ?? error);
  }
}

function startSuccessionTask(api) {
  class SuccessionTask extends Task {
    execute() {
      try {
        successionTick();
      } catch (error) {
        console.warn("[succession] tick failed", error?.message ?? error);
      }
    }
  }
  api.getTaskManager()?.submit(new SuccessionTask(SUCCESSION_TICK_TICKS));
  console.info("[succession] arc-seeding armed", { tickTicks: SUCCESSION_TICK_TICKS });
}

function attachSuccession(api) {
  pluginApi = api;
  api.onCustomEvent("kingdom:royal-event", onRoyalEvent);
  startSuccessionTask(api);
}

module.exports = attachSuccession;
module.exports.attachSuccession = attachSuccession;
module.exports.successionTick = successionTick;
module.exports.SUCCESSION_TICK_TICKS = SUCCESSION_TICK_TICKS;
