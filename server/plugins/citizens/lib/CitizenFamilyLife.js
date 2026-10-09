"use strict";

/**
 * CitizenFamilyLife — the dynamics of citizen families (director tick).
 *
 * Data tier, zero LLM. Every decision below reads real state: the roster,
 * real marriages from CitizenKinship, real homes from CitizenHomes, real
 * skill levels from CitizenSkilling, real coin pouches. Nothing is
 * hash-derived.
 *
 * Per slow tick:
 *   1. Formation — married couples (CitizenKinship.spouseOf) without a
 *      family record get one. The family takes the shared surname.
 *   2. Births — married couples with both spouses in the roster can have
 *      children: rare, capped (4 per family), with a cooldown between
 *      births. A birth is journaled for both parents and gossiped.
 *   3. Growing up — children advance baby → child → teen → adult on a
 *      compressed clock (~5 weeks birth to adulthood). Coming-of-age is
 *      journaled and announced; the town notices.
 *   4. Coming of age — adult children join the roster as real citizens
 *      when there's room, keeping their name, surname, inherited traits,
 *      and everything their parents taught them (learnedXp converts to
 *      real skill XP). Grown children are how the town replenishes the
 *      citizens that funerals take — no random strangers, just the
 *      neighbors' kids grown up.
 *   5. Teaching — parents pass on what they know. Minor children bank
 *      learnedXp (converts at roster join); adult roster children standing
 *      near a parent occasionally gain real XP in the parent's best skill.
 *   6. Inheritance — when a roster citizen vanishes permanently (the
 *      funerals system removes them), their family inherits: the home
 *      transfers to the spouse (else eldest adult child), and coin from
 *      their real inventory — or accrued career savings when they're not
 *      materialized — becomes bequests that flush when heirs materialize.
 *   7. Protection — parents of minor children keep closer to home; when
 *      an adult child is hurt and a parent is online in the same kingdom,
 *      the parent hears about it (journaled) and heads their way.
 *   8. Family life — small honest beats: parents checking on children,
 *      family meals at home, children playing near the family home.
 *
 * Wiring: CitizenDirector.tick() calls tickFamilies(director, nowMs).
 */

const Families = require("./CitizenFamilies");
const { normalizeName } = require("./CitizenBonds");
const { getJournal } = require("./CitizenJournal");
const { agentRng, chance } = require("./humanizer");
const { generatePersonality, generateName } = require("./personalities");
const { nextGoalForRole } = require("./goals");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");

const COINS = 995; // ItemIds.COINS, verified in ItemIdentifiers.ts
const DAY_MS = 24 * 3600 * 1000;

// Per-tick probabilities (the director slow-ticks roughly every 60s).
const BIRTH_CHANCE = 0.002; // ~0.2% per eligible family per minute — rare
const BIRTH_COOLDOWN_MS = 14 * DAY_MS;
const TEACH_CHANCE = 0.03; // parent teaches minor child per tick
const TEACH_XP = 25; // xp per lesson banked to learnedXp
const NEAR_TEACH_CHANCE = 0.02; // adult child near parent gains real xp
const NEAR_TEACH_XP = 15;
const FAMILY_BEAT_CHANCE = 0.02; // small family-life journal flavor
const PROTECT_RADIUS = 20; // tiles — parent heads to hurt child within this

const BIRTH_LINES = [
  "A child was born — the town has a new voice.",
  "There's a new baby in town, and two very tired parents.",
  "The family grows — a healthy baby, loud as a market bell.",
];
const COMING_OF_AGE_LINES = [
  "came of age today — no longer a child, a citizen in the making.",
  "is grown now. The town watched them grow up.",
  "stood tall at their coming-of-age — the family is proud.",
];

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "family", text);
  } catch {
    // Non-fatal.
  }
}

function recordOf(director, name) {
  return director?.roster?.get?.(normalizeName(name)) ?? null;
}

function botOf(director, record) {
  try {
    return director?.getBot ? director.getBot(record) : null;
  } catch {
    return null;
  }
}

function displayOf(record, username) {
  return record?.displayName ?? record?.personality?.name ?? username;
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// Known roster members, for detecting permanent disappearances (deaths).
// Initialized from the roster on first tick — restarts don't false-fire.
let knownAlive = null;

function seedKnownAlive(director) {
  knownAlive = new Set();
  try {
    for (const key of director?.roster?.keys?.() ?? []) {
      knownAlive.add(String(key).toLowerCase());
    }
  } catch {
    // Non-fatal.
  }
}

function resetForTests() {
  knownAlive = null;
}

// --- 1. formation ------------------------------------------------------------

/**
 * Married couples get families. Reads real marriages from CitizenKinship.
 * Returns the number of families formed this tick.
 */
function formFamilies(director, nowMs) {
  let formed = 0;
  let Kinship;
  try {
    Kinship = require("./CitizenKinship");
  } catch {
    return 0;
  }
  const seen = new Set();
  for (const record of director.roster.values()) {
    try {
      const name = record?.username;
      if (!name || seen.has(normalizeName(name))) continue;
      const spouse = Kinship.spouseOf(name);
      if (!spouse) continue;
      const spouseRecord = recordOf(director, spouse);
      if (!spouseRecord) continue; // spouse must be a real roster citizen
      seen.add(normalizeName(name));
      seen.add(normalizeName(spouse));
      if (Families.familyOf(name)) continue;
      const family = Families.createFamily(
        name,
        displayOf(record, name),
        spouse,
        displayOf(spouseRecord, spouse),
        record.kingdomId
      );
      if (family) {
        formed += 1;
        journalEvent(name, `started a family with ${displayOf(spouseRecord, spouse)}.`);
        journalEvent(spouse, `started a family with ${displayOf(record, name)}.`);
        // The family home: prefer the larger of the two spouses' homes.
        assignFamilyHome(director, family, record, spouseRecord);
      }
    } catch {
      // Per-couple failures must not break the tick.
    }
  }
  return formed;
}

/**
 * Point the family record at the better of the two spouses' homes, so the
 * family has one hearth. Children grow up "at" this home.
 */
function assignFamilyHome(director, family, recordA, recordB) {
  let Homes;
  try {
    Homes = require("./CitizenHomes");
  } catch {
    return;
  }
  try {
    const homeA = Homes.homeOf(recordA.username);
    const homeB = Homes.homeOf(recordB.username);
    if (homeA && homeB) {
      const comfortA = Homes.comfortOf(homeA) ?? 0;
      const comfortB = Homes.comfortOf(homeB) ?? 0;
      family.homeId = (comfortB > comfortA ? homeB : homeA).id;
    } else {
      family.homeId = (homeA ?? homeB)?.id ?? null;
    }
  } catch {
    // Non-fatal.
  }
}

// --- 2. births ---------------------------------------------------------------

/** Blend both parents' traits into the child's starting traits. */
function inheritTraits(recordA, recordB, rng) {
  const traitsA = recordA?.personality?.traits ?? [];
  const traitsB = recordB?.personality?.traits ?? [];
  const pool = [...new Set([...traitsA, ...traitsB])];
  const out = [];
  while (out.length < 2 && pool.length > 0) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

function maybeBirth(director, family, recordA, recordB, rng, nowMs) {
  if (family.children.length >= Families.MAX_CHILDREN_PER_FAMILY) return null;
  if (nowMs - (family.lastBirthAt ?? 0) < BIRTH_COOLDOWN_MS) return null;
  if (!chance(rng, BIRTH_CHANCE)) return null;
  // Both parents must be alive (in the roster) for a birth.
  if (!recordOf(director, family.spouses[0]) || !recordOf(director, family.spouses[1])) {
    return null;
  }
  const firstName = (generateName(rng, new Set()).split(" ")[0] || "Alex");
  const traits = inheritTraits(recordA, recordB, rng);
  const child = Families.recordBirth(family.id, firstName, traits, nowMs);
  if (!child) return null;
  const line = pick(rng, BIRTH_LINES);
  const aDisplay = displayOf(recordA, family.spouses[0]);
  const bDisplay = displayOf(recordB, family.spouses[1]);
  journalEvent(family.spouses[0], `${child.display} was born. ${line}`);
  journalEvent(family.spouses[1], `${child.display} was born. ${line}`);
  try {
    const botA = botOf(director, recordA);
    const botB = botOf(director, recordB);
    const herald = botA ?? botB;
    if (herald) sayPublic(herald, `${child.display} was born! ${aDisplay} and ${bDisplay} are parents!`);
  } catch {
    // Announcement is best-effort.
  }
  return child;
}

function tickBirths(director, rng, nowMs) {
  for (const family of Families.allFamilies()) {
    try {
      if (family.spouses.length < 2) continue;
      const recordA = recordOf(director, family.spouses[0]);
      const recordB = recordOf(director, family.spouses[1]);
      if (!recordA || !recordB) continue;
      maybeBirth(director, family, recordA, recordB, rng, nowMs);
    } catch {
      // Per-family failures must not break the tick.
    }
  }
}

// --- 3. growing up -----------------------------------------------------------

function tickAging(director, rng, nowMs) {
  for (const child of Families.allChildren()) {
    try {
      if (child.leftTown || child.joinedRoster) continue;
      const before = child.stage;
      if (!Families.refreshStage(child, nowMs)) continue;
      const family = Families.familyOfChild(child.id);
      const line = pick(rng, COMING_OF_AGE_LINES);
      if (child.stage === Families.STAGE_ADULT) {
        // Coming of age — the town notices.
        for (const parent of child.parents) {
          journalEvent(parent, `${child.display} ${line}`, "family");
        }
        journalEvent(child.display, `Came of age. ${line}`, "family");
        try {
          const parentRec = recordOf(director, child.parents[0]);
          const bot = parentRec ? botOf(director, parentRec) : null;
          if (bot) sayPublic(bot, `${child.display} ${line}`);
        } catch {
          // Best-effort.
        }
      } else {
        for (const parent of child.parents) {
          journalEvent(parent, `${child.display} is growing up (${before} → ${child.stage}).`, "family");
        }
      }
      void family;
    } catch {
      // Per-child failures must not break the tick.
    }
  }
}

// --- 4. coming of age → roster ------------------------------------------------

/**
 * Adult children join the roster as real citizens when there's room. They
 * keep their name, surname, inherited traits, and everything their parents
 * taught them converts to real skill XP. This is how the town replenishes
 * the citizens that funerals take — the neighbors' kids, grown up.
 *
 * The roster has a soft cap (the 8GB ceiling); grown children only join
 * when the roster is below it, else they wait (or eventually leave town).
 */
const ROSTER_SOFT_CAP = 110;

function buildGrownRecord(director, child, rng) {
  const role = "commoner"; // grown children start as commoners, like anyone
  const personality = generatePersonality(`grown-${child.id}`, {
    role,
    kingdomId: child.kingdomId,
    usedNames: director.usedNames ?? new Set(),
  });
  // Keep their real identity: name, surname, inherited traits.
  personality.name = child.display;
  if (child.traits.length > 0) personality.traits = child.traits.slice(0, 2);
  const username = child.display;
  director.usedNames?.add?.(username);
  let siteTileByKingdom;
  try {
    siteTileByKingdom = require("../brain/CitizenSites").siteTileByKingdom;
  } catch {
    siteTileByKingdom = () => ({ x: 3200, y: 3200, z: 0 });
  }
  const anchor = siteTileByKingdom(child.kingdomId, "market") ?? { x: 3200, y: 3200, z: 0 };
  let home = { x: anchor.x, y: anchor.y, z: anchor.z ?? 0 };
  try {
    home = director.findWalkableHome ? director.findWalkableHome(anchor, rng) : home;
    home.z = anchor.z ?? 0;
  } catch {
    // Fall back to the anchor.
  }
  const record = {
    username,
    personality,
    kingdomId: child.kingdomId,
    role,
    merchantKind: null,
    home,
    seed: personality.seed,
    sleepStart: [22, 23, 0][Math.floor(rng() * 3)],
    sleepHours: 6 + Math.floor(rng() * 3),
    watch: 0,
    goal: nextGoalForRole(role, 0),
    goalTier: 0,
    emotion: { state: "calm", intensity: 0, cause: null, updatedAt: 0 },
    online: false,
    currentActivityId: null,
    lastTickAt: Date.now(),
    // Grown-child provenance: the town knows who their parents are.
    grownChildOf: child.parents.slice(),
    familyId: child.familyId,
  };
  return record;
}

function joinRoster(director, child, rng) {
  try {
    const { ensureNeeds } = require("../brain/CitizenNeeds");
    const record = buildGrownRecord(director, child, rng);
    const key = normalizeName(record.username);
    if (director.roster.has(key)) return false; // name taken — wait
    director.roster.set(key, record);
    ensureNeeds(record.username);
    Families.markJoinedRoster(child.id);
    if (knownAlive) knownAlive.add(key);
    // Everything they learned as a child becomes real.
    let Skilling;
    try {
      Skilling = require("./CitizenSkilling");
    } catch {
      Skilling = null;
    }
    const learned = child.learnedXp ?? {};
    for (const [skillId, xp] of Object.entries(learned)) {
      try {
        if (xp > 0 && Skilling?.skillStore) Skilling.skillStore.addXp(record.username, skillId, xp);
      } catch {
        // Non-fatal.
      }
    }
    // Bequest flushes when they materialize (same as career savings).
    for (const parent of child.parents) {
      journalEvent(parent, `${child.display} has come of age and joined the town.`, "family");
    }
    journalEvent(child.display, "Came of age and joined the town as a citizen.", "family");
    return true;
  } catch {
    return false;
  }
}

function tickComingOfAge(director, rng, nowMs) {
  const rosterSize = director?.roster?.size ?? ROSTER_SOFT_CAP;
  for (const child of Families.allChildren()) {
    try {
      if (child.stage !== Families.STAGE_ADULT) continue;
      if (child.joinedRoster || child.leftTown) continue;
      if (rosterSize >= ROSTER_SOFT_CAP) {
        // No room — the grown child eventually seeks fortune elsewhere.
        if (chance(rng, 0.001)) {
          Families.markLeftTown(child.id);
          for (const parent of child.parents) {
            journalEvent(parent, `${child.display} left town to seek their fortune.`, "family");
          }
        }
        continue;
      }
      joinRoster(director, child, rng);
    } catch {
      // Per-child failures must not break the tick.
    }
  }
  void nowMs;
}

// --- 5. teaching -------------------------------------------------------------

/** Best skill of a roster citizen, from real skill levels. */
function bestSkillOf(username) {
  try {
    const Skilling = require("./CitizenSkilling");
    const store = Skilling?.skillStore;
    if (!store) return null;
    // Probe the known skill ids via the store's xp map for this citizen.
    const entry = store.xp.get(normalizeName(username));
    if (!entry) return null;
    let best = null;
    let bestLevel = 0;
    for (const [skillId, xp] of Object.entries(entry)) {
      const level = store.getLevel(username, skillId);
      if (level > bestLevel) {
        bestLevel = level;
        best = skillId;
      }
    }
    return best && bestLevel >= 5 ? { skillId: best, level: bestLevel } : null;
  } catch {
    return null;
  }
}

function tickTeaching(director, rng) {
  for (const child of Families.allChildren()) {
    try {
      if (child.leftTown || child.joinedRoster) continue;
      if (child.stage !== Families.STAGE_CHILD && child.stage !== Families.STAGE_TEEN) continue;
      if (!chance(rng, TEACH_CHANCE)) continue;
      // A parent teaches the child their best skill.
      const parentName = pick(rng, child.parents);
      const best = bestSkillOf(parentName);
      if (!best) continue;
      Families.addLearnedXp(child.id, best.skillId, TEACH_XP);
      if (chance(rng, 0.3)) {
        journalEvent(parentName, `Taught ${child.firstName} a little ${best.skillId} (${best.level}).`, "family");
      }
    } catch {
      // Per-child failures must not break the tick.
    }
  }
  // Adult roster children near a parent gain real XP occasionally.
  try {
    const Skilling = require("./CitizenSkilling");
    for (const record of director.roster.values()) {
      try {
        const parents = record?.grownChildOf;
        if (!parents || !chance(rng, NEAR_TEACH_CHANCE)) continue;
        const parentName = pick(rng, parents);
        const parentRec = recordOf(director, parentName);
        if (!parentRec) continue;
        const best = bestSkillOf(parentName);
        if (!best || !Skilling?.skillStore) continue;
        Skilling.skillStore.addXp(record.username, best.skillId, NEAR_TEACH_XP);
      } catch {
        // Per-citizen failures must not break the tick.
      }
    }
  } catch {
    // Non-fatal.
  }
}

// --- 6. inheritance ----------------------------------------------------------

/**
 * When a roster citizen vanishes permanently (funerals remove them), their
 * family inherits. The home transfers to the spouse — else the eldest adult
 * child, else the eldest minor child (held in trust). Coin comes from real
 * state: the materialized inventory when available, else accrued career
 * savings; it becomes bequests that flush when heirs materialize.
 */
function handleInheritance(director, username, record, nowMs) {
  const key = normalizeName(username);
  const family = Families.familyOf(username);
  const kids = Families.childrenOf(username).filter((c) => !c.leftTown);
  if (!family && kids.length === 0) return false;

  // Heirs: spouse first, then children eldest-first.
  const heirs = [];
  try {
    const Kinship = require("./CitizenKinship");
    const spouse = Kinship.spouseOf(username);
    if (spouse && recordOf(director, spouse)) heirs.push(spouse);
  } catch {
    // Non-fatal.
  }
  const sortedKids = kids.slice().sort((a, b) => b.bornAt - a.bornAt || 0);
  // Eldest adult children first, then minors.
  const adults = sortedKids.filter((c) => c.stage === Families.STAGE_ADULT && c.joinedRoster);
  const minors = sortedKids.filter((c) => !(c.stage === Families.STAGE_ADULT && c.joinedRoster));
  for (const c of [...adults, ...minors]) {
    const heirName = c.joinedRoster ? c.display : null;
    if (heirName && recordOf(director, heirName)) heirs.push(heirName);
    else heirs.push({ childId: c.id, display: c.display }); // bequest to the record
  }
  if (heirs.length === 0) return false;

  // 1. Home transfer — real CitizenHomes state.
  try {
    const Homes = require("./CitizenHomes");
    const home = Homes.homeOf(username);
    if (home) {
      const heir = heirs[0];
      const heirName = typeof heir === "string" ? heir : heir.display;
      const heirKey = typeof heir === "string" ? normalizeName(heir) : null;
      if (heirKey && recordOf(director, heirKey)) {
        transferHome(Homes, home.id, heirKey, heirName);
        journalEvent(heirKey, `Inherited ${displayOf(record, username)}'s home.`, "family");
      } else if (typeof heir !== "string") {
        // Minor child inherits — held in trust until they come of age.
        transferHome(Homes, home.id, heir.display, heir.display);
        journalEvent(username, `${heir.display} inherits the family home (held in trust).`, "family");
      }
      // Point the family record at the inherited home.
      if (family) family.homeId = home.id;
    }
  } catch {
    // Non-fatal.
  }

  // 2. Coin bequest — real coins only.
  let coins = 0;
  try {
    const bot = record ? botOf(director, record) : null;
    const inv = bot?.getInventory?.();
    coins = inv?.getAmount?.(COINS) ?? 0;
    if (coins > 0) {
      // Take most of it for the heirs; leave a little for the road.
      const bequestPool = Math.floor(coins * 0.8);
      if (bequestPool > 0) {
        try {
          inv.delete?.(COINS, bequestPool);
        } catch {
          // Best-effort.
        }
        distributeBequest(director, heirs, bequestPool, username);
        coins = bequestPool;
      } else {
        coins = 0;
      }
    }
  } catch {
    // Non-fatal.
  }
  if (coins <= 0) {
    // Fall back to accrued career savings (real state).
    try {
      const Careers = require("./CitizenCareers");
      const rec = Careers.careerOf?.(username);
      const savings = Math.floor(rec?.savings ?? 0);
      if (savings > 0) {
        rec.savings = 0;
        distributeBequest(director, heirs, savings, username);
        coins = savings;
      }
    } catch {
      // Non-fatal.
    }
  }

  // 3. Widow/orphan bookkeeping.
  if (family) {
    Families.recordSpouseGone(family.id, username, displayOf(record, username));
  }
  const heirNames = heirs
    .map((h) => (typeof h === "string" ? displayOf(recordOf(director, h), h) : h.display))
    .join(", ");
  journalEvent(username, `Passed on — the inheritance goes to ${heirNames}.`, "family");
  void nowMs;
  return true;
}

function transferHome(Homes, homeId, newOwnerName, newOwnerDisplay) {
  try {
    if (typeof Homes.transferHome === "function") {
      Homes.transferHome(homeId, newOwnerName, newOwnerDisplay);
      return;
    }
  } catch {
    // Fall through to direct manipulation.
  }
  try {
    const home = Homes.getHome(homeId);
    if (home) {
      home.owner = normalizeName(newOwnerName);
      home.ownerDisplay = newOwnerDisplay ?? newOwnerName;
      home.rentDebt = 0;
    }
  } catch {
    // Non-fatal.
  }
}

/**
 * Split a coin pool among heirs. Roster citizens get savings (flushed on
 * materialize, like career wages); minor children get bequests on their
 * family record (flushed at roster join).
 */
function distributeBequest(director, heirs, pool, deceasedName) {
  const shares = heirs.length;
  if (shares === 0 || pool <= 0) return;
  const perHeir = Math.floor(pool / shares);
  if (perHeir <= 0) return;
  for (const heir of heirs) {
    try {
      if (typeof heir === "string") {
        const rec = recordOf(director, heir);
        const bot = rec ? botOf(director, rec) : null;
        if (bot) {
          const inv = bot.getInventory?.();
          inv?.add?.(COINS, perHeir);
          journalEvent(heir, `Inherited ${perHeir} coins from ${deceasedName}.`, "family");
        } else {
          // Offline — accrue like career savings.
          try {
            const Careers = require("./CitizenCareers");
            const rec2 = Careers.careerFor?.(heir);
            if (rec2) rec2.savings = (rec2.savings ?? 0) + perHeir;
          } catch {
            // Fall through to family bequest note.
            journalEvent(heir, `Is owed ${perHeir} coins of inheritance from ${deceasedName}.`, "family");
          }
          journalEvent(heir, `Inherited ${perHeir} coins from ${deceasedName} (held until they return).`, "family");
        }
      } else if (heir?.childId) {
        Families.addBequest(heir.childId, perHeir);
        journalEvent(heir.display, `Stands to inherit ${perHeir} coins from ${deceasedName}.`, "family");
      }
    } catch {
      // Per-heir failures must not break the tick.
    }
  }
}

/**
 * Detect permanent disappearances: citizens we knew who are no longer in
 * the roster. Combat deaths respawn (record stays), so a vanished record
 * means permanent removal — funerals, or admin. Inheritance fires once.
 */
function tickInheritance(director, nowMs) {
  if (!knownAlive) {
    seedKnownAlive(director);
    return;
  }
  const current = new Set();
  try {
    for (const key of director?.roster?.keys?.() ?? []) {
      current.add(String(key).toLowerCase());
    }
  } catch {
    return;
  }
  for (const key of knownAlive) {
    if (!current.has(key)) {
      try {
        // Gone permanently — but only inherit when they had a family.
        const hadFamily = Families.familyOf(key) || Families.childrenOf(key).length > 0;
        if (hadFamily) {
          handleInheritance(director, key, null, nowMs);
        }
      } catch {
        // Non-fatal.
      }
    }
  }
  knownAlive = current;
}

// --- 7. protection -----------------------------------------------------------

/**
 * Parents of minor children keep closer to home — and when an adult child
 * is hurt with a parent online in the same kingdom, the parent hears about
 * it and heads their way. Real behavior, not flavor: the journal records
 * it, and a materialized parent gets a movement nudge.
 */
function tickProtection(director, rng, nowMs) {
  void nowMs;
  for (const record of director.roster.values()) {
    try {
      const name = record?.username;
      if (!name) continue;
      const minors = Families.minorChildrenOf(name);
      const adultKids = Families.adultChildrenOf(name).filter((c) => c.joinedRoster);
      if (minors.length === 0 && adultKids.length === 0) continue;

      // A parent with young children at home: occasional honest beat.
      if (minors.length > 0 && chance(rng, FAMILY_BEAT_CHANCE * 0.5)) {
        const kid = pick(rng, minors);
        journalEvent(name, `Checked on ${kid.firstName} — all well at home.`, "family");
      }

      // An adult child in trouble: the parent reacts.
      for (const kid of adultKids) {
        const kidRec = recordOf(director, kid.display);
        if (!kidRec) continue;
        let hurt = false;
        try {
          const { needsSnapshot } = require("../brain/CitizenNeeds");
          const needs = needsSnapshot(kid.display);
          hurt = needs && needs.hp < 30;
        } catch {
          // Non-fatal.
        }
        if (!hurt) continue;
        if (kidRec.kingdomId !== record.kingdomId) continue;
        const parentBot = botOf(director, record);
        journalEvent(name, `${kid.display} is hurt — going to them.`, "family");
        if (parentBot && kidRec.home) {
          try {
            parentBot.getMovement?.()?.queueMovement?.(kidRec.home.x, kidRec.home.y);
          } catch {
            // Best-effort.
          }
        }
        break; // one rescue per parent per tick
      }
    } catch {
      // Per-citizen failures must not break the tick.
    }
  }
}

// --- 8. family life beats ----------------------------------------------------

const MEAL_LINES = [
  "sat down to a family meal — bread, stew, and too much talking.",
  "gathered the family for supper. The children argued about nothing.",
  "shared a quiet dinner at home. These are the good hours.",
];
const PLAY_LINES = [
  "The children are playing near the market — someone's winning.",
  "could hear their children laughing from down the street.",
  "watched the little ones chase each other around the square.",
];

function tickFamilyBeats(director, rng) {
  for (const family of Families.allFamilies()) {
    try {
      if (!chance(rng, FAMILY_BEAT_CHANCE)) continue;
      if (family.spouses.length === 0) continue;
      const parent = pick(rng, family.spouses);
      if (!recordOf(director, parent)) continue;
      const kids = Families.childrenOf(parent).filter((c) => !c.leftTown);
      if (kids.length === 0) continue;
      const line = kids.some((c) => c.stage === Families.STAGE_BABY || c.stage === Families.STAGE_CHILD)
        ? pick(rng, PLAY_LINES)
        : pick(rng, MEAL_LINES);
      journalEvent(parent, line, "family");
    } catch {
      // Per-family failures must not break the tick.
    }
  }
}

// --- bequest flush -----------------------------------------------------------

/**
 * Flush coin bequests when heirs materialize — the same savings pattern
 * CitizenCareerLife uses for offline wages.
 */
function tickBequestFlush(director) {
  for (const child of Families.allChildren()) {
    try {
      if (!child.joinedRoster || (child.bequest ?? 0) <= 0) continue;
      const rec = recordOf(director, child.display);
      const bot = rec ? botOf(director, rec) : null;
      if (!bot) continue;
      const inv = bot.getInventory?.();
      if (!inv) continue;
      const amount = child.bequest;
      try {
        // Canonical: adds(id, amount). inv.add takes an Item instance, not
        // (id, amount) — the old call threw inside ItemContainer. Verify the
        // credit landed; otherwise keep the bequest and retry next tick.
        const before = inv.getAmount?.(COINS) ?? 0;
        inv.adds?.(COINS, amount);
        if ((inv.getAmount?.(COINS) ?? 0) !== before + amount) continue;
        child.bequest = 0;
        journalEvent(child.display, `Received ${amount} coins of inheritance.`, "family");
      } catch {
        // Inventory oddity — try again next tick.
      }
    } catch {
      // Per-child failures must not break the tick.
    }
  }
}

// --- main tick ---------------------------------------------------------------

function tickFamilies(director, nowMs) {
  const rng = agentRng(`families:${Math.floor(nowMs / 60000)}`);
  try {
    formFamilies(director, nowMs);
  } catch (e) {
    director?.log?.("families formation failed", { error: String(e?.message ?? e) });
  }
  try {
    tickBirths(director, rng, nowMs);
  } catch (e) {
    director?.log?.("families births failed", { error: String(e?.message ?? e) });
  }
  try {
    tickAging(director, rng, nowMs);
  } catch (e) {
    director?.log?.("families aging failed", { error: String(e?.message ?? e) });
  }
  try {
    tickComingOfAge(director, rng, nowMs);
  } catch (e) {
    director?.log?.("families coming-of-age failed", { error: String(e?.message ?? e) });
  }
  try {
    tickTeaching(director, rng);
  } catch (e) {
    director?.log?.("families teaching failed", { error: String(e?.message ?? e) });
  }
  try {
    tickInheritance(director, nowMs);
  } catch (e) {
    director?.log?.("families inheritance failed", { error: String(e?.message ?? e) });
  }
  try {
    tickProtection(director, rng, nowMs);
  } catch (e) {
    director?.log?.("families protection failed", { error: String(e?.message ?? e) });
  }
  try {
    tickFamilyBeats(director, rng);
  } catch (e) {
    director?.log?.("families beats failed", { error: String(e?.message ?? e) });
  }
  try {
    tickBequestFlush(director);
  } catch (e) {
    director?.log?.("families bequest flush failed", { error: String(e?.message ?? e) });
  }
}

module.exports = {
  tickFamilies,
  // exposed for tests
  formFamilies,
  maybeBirth,
  tickAging,
  tickComingOfAge,
  tickTeaching,
  handleInheritance,
  tickInheritance,
  tickProtection,
  tickBequestFlush,
  stageForAge: Families.stageForAge,
  resetForTests,
};
