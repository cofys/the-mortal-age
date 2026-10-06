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
 * Misthalin, 0-22) advances very slowly — days per stage. Each new stage
 * drops ONE rare, deniable rumor into Varrock's streets via kingdom:rumor:
 *
 *   stage 1 — a drunk courtier's slip in a tavern
 *   stage 2 — a spymaster's redacted report, half-burned in a gutter
 *   stage 3 — a sermon on "the king's line" that stops mid-sentence
 *   stage 4 — a Riverlands merchant who saw a boy with the king's eyes
 *   stage 5 — the midwife's daughter takes a market stall (who knows)
 *   stage 6 — the Merciful Hand charity buys birth records (who's hunting)
 *   stage 7 — black-plate men asking questions in a border town (the hunt)
 *   stage 8 — the midwife's daughter goes quiet (the squeeze)
 *   stage 9 — the Riverlands farm stands empty (the hunted young man)
 *   stage 10 — the Hand's charity auction, the palace bidding (the backers)
 *   stage 11 — a reward poster for the cut ledger page (the page)
 *   stage 12 — the grey men stop asking, start watching (the warning)
 *   stage 13 — the hunted young man surfaces, somewhere unexpected (Port Sarim)
 *   stage 14 — the Hand's auction donors, pinned on the market board (the trace)
 *   stage 15 — the reward poster, claimed by a grey cloak (the page, gone again)
 *   stage 16 — the drunk courtier disappears (someone knew too much)
 *   stage 17 — a second buyer for old paper, gold not silver (the second player)
 *   stage 18 — the two buyers' men come to blows over one informant (the confrontation)
 *   stage 19 — the young man flees Port Sarim on a midnight ship (the flight)
 *   stage 20 — the struck donor named: the Fustian Guild, pulled out, "loyal friends" (the struck name)
 *   stage 21 — the bidding war: gold doubled, paper triple, clerks getting rich and scared (the bidding war)
 *   stage 22 — the lad seen clasping hands with a grey man on the midnight quay (the quay)
 *
 * Stages 5-8 are the escalation beats; their interactive layer lives in
 * SuccessionKeepers.Kingdoms.js. Stages 9-12 are the trail; their interactive
 * layer lives in SuccessionTrail.Kingdoms.js. Stages 13-17 are the hunt;
 * their interactive layer lives in SuccessionHunt.Kingdoms.js. The rule
 * never changes: rare, deniable, never naming the son.
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
const MAX_STAGE = 22;

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
  // Stages 5-8: the escalation. Who knows, who's hunting, and the squeeze.
  // Still whispers — still deniable — but the world is closing in.
  5: "They say the midwife's daughter has taken a stall at the market, selling " +
    "her mother's old remedies. She won't meet anyone's eyes.",
  6: "A charity calling itself the Merciful Hand is buying up old birth records — " +
    "orphanage ledgers, parish rolls, anything with names on it. Paying silver " +
    "for paper nobody else wants.",
  7: "Men in black plate were asking questions in a border town — about a young " +
    "man, thirty or so, farm-bred. They didn't say whose.",
  8: "The midwife's daughter hasn't held her stall in days. Her mother won't open " +
    "the door. The street says the grey men came calling.",
  // Stages 9-12: the trail after the squeeze. Colder, more dangerous.
  // The farm, the coin, the page, the warning.
  9: "A farm out past the Riverlands — the one the merchant wouldn't name — " +
    "stands empty. Cold hearth, door swinging. A child's wooden sword on the " +
    "table, like someone left in a hurry.",
  10: "The Merciful Hand held a charity auction — silver plate, old tapestries. " +
    "Half the merchant houses bought tables. The palace sent a man, and nobody " +
    "bid against him. What kind of charity has the palace bidding?",
  11: "A reward poster in Varrock offers a fortune for 'a single leaf of vellum, " +
    "a birth record, corner torn.' Someone knows what that page is worth. " +
    "Someone else wants it first.",
  12: "The grey men aren't asking questions anymore. They're just watching. " +
    "A friend of a friend got a visit. 'Some stones are better left unturned,' " +
    "they told him. He hasn't slept since.",
  // Stages 13-17: the hunt. The young man surfaces, the backers leave a
  // trace, the page is claimed, someone disappears, a second player appears.
  // Colder still — but the world keeps moving, and movement leaves marks.
  13: "They say a lad with a Riverlands farm accent is working the Port Sarim " +
    "docks. Young, strong, quiet. Keeps a packed bag by his bunk and looks over " +
    "his shoulder when the gulls cry. Somebody taught that boy to run.",
  14: "The Merciful Hand pinned its auction donors on the market board — a long " +
    "vellum list, and one name struck through in palace-green ink. Below it, " +
    "in a fresh hand: 'the palace thanks its friends.' Nobody's asked whose " +
    "name was underneath the ink.",
  15: "That reward poster — the torn ledger page, the fortune for a leaf of " +
    "vellum — it's gone. A grey-cloaked man took it down yesterday and walked " +
    "toward the palace quarter. The charcoal underneath said one word: 'sold.'",
  16: "The courtier with the loose tongue — the one who slurred about 'the " +
    "king's heir' in the Blue Moon — hasn't been seen in a fortnight. His " +
    "lodgings are let to a quiet man in grey. Nobody saw him leave. Nobody's asking.",
  17: "There's a second buyer for old paper now. Not the Hand — a private man, " +
    "plain clothes, paying in gold where the Hand pays silver. No charity, no " +
    "questions, no face anyone remembers. What he buys, he buys for a fortune. " +
    "What he wants it for, nobody knows.",
  // Stages 18-22: the hunt escalates. The two buyers cross paths, the young
  // man runs, a backer is named, the bidding war burns, and the quay goes
  // quiet. Stakes rise; the truth stays one inference away.
  18: "Two men near came to blows in the Rusty Anchor last night — one grey, " +
    "one plain-dressed, both flashing coin at the same dock clerk, both after " +
    "the same paper. The clerk took neither. He's gone this morning. Vanished.",
  19: "The farm lad's bunk at Port Sarim is empty. The harbormaster took double " +
    "fare off a young man at midnight — no name, no cargo, no questions. Ran " +
    "like the tide was after him. Somebody warned that boy.",
  20: "The Hand's donor list is re-pinned, reprinted — and the struck name is " +
    "simply gone, like it was never there. The fresh hand below reads: 'the " +
    "palace thanks its LOYAL friends.' The street says the Fustian Guild pulled " +
    "its gold the week the palace man leaned on the auction — and their factor's " +
    "son just took a palace post.",
  21: "Old paper's worth triple what it was. The gold buyer doubled his offer, " +
    "and the Hand is matching coin for coin. Parish clerks are getting rich and " +
    "getting frightened in equal measure. One Varrock scribe quit his post and " +
    "took the first cart south. Wouldn't say why.",
  22: "A sailor swears he saw the farm lad on the midnight quay — clasping hands " +
    "with a man in grey. Bought, or taken? He wouldn't say, and he's not saying " +
    "it twice. Nobody talks about the docks anymore.",
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
/** Current whisper stage (0-22). The keepers/trail/hunt layers gate their beats on this. */
module.exports.whisperStage = stageOf;
