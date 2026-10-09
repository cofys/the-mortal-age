"use strict";

/**
 * CitizenSkilling — visible citizen skilling with persistent XP and levels.
 *
 * The core mission is citizens indistinguishable from real players. Citizens
 * already gather via the brain's work routine; this module adds the layers
 * that make skilling *visible and progressive*:
 *
 *  - Visible skilling sessions: citizens walk to work sites, docks, quarries
 *    and taverns and perform the real skilling animations where players can
 *    watch — solo or in skilling parties (2-4) that travel together.
 *  - Skill XP and levels (data-tier, persistent): every citizen accrues XP in
 *    their profession skill while online plus bigger chunks from sessions. A
 *    citizen who's been fishing for weeks is genuinely higher level than a
 *    newcomer. Level-ups are journaled and celebrated.
 *  - Player interaction: data-tier chat lines when real players are nearby
 *    ("Lovely day for chopping, innit?"), and the journal records sessions,
 *    catches and level-ups so the foreground LLM speaks truthfully when a
 *    player asks "what have you been up to?"
 *
 * Data tier, zero LLM. The ~60s director tick handles the XP drip, session
 * formation, travel and disbanding; a 6s action loop plays the visible
 * animations and grants XP/items while citizens are on site (the director
 * tick is far too coarse for visible skilling).
 *
 * Item ids are verified in server/src/main/typescript/elvarg/util/ItemIdentifiers.ts:
 *   LOGS 1511, COPPER_ORE 436, TIN_ORE 438, RAW_SHRIMPS 317, SHRIMPS 315.
 * Animation ids are the engine's own (RuneLite constants in the skill plugins):
 *   woodcut 879 (bronze axe), mine 625 (bronze pick), fish net 621, cook range 897.
 *
 * Wiring: CitizenDirector.tick() calls tickSkilling(this, hour) once per tick.
 * XP persists to data/saves/citizen-skills.json (same pattern as the journal).
 */

const path = require("path");
const fs = require("fs");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");

const {
  isFriend,
  isEnemy,
  getParty,
  getFollow,
  setFollow,
  clearFollow,
  normalizeName,
} = require("./CitizenBonds");
const { createParty, disbandParty, leaveParty } = require("./CitizenSocialMechanics");
const { getJournal } = require("./CitizenJournal");
const { agentRng, chance } = require("./humanizer");
const { siteTileByKingdom } = require("../brain/CitizenSites");

// --- skill definitions -------------------------------------------------------
// site: key into data/sites.json. `workTree`/`workRock` resolve against the
// kingdom's "work" site catalog (trees everywhere but Keldagrim, rock there).

const SKILLS = {
  woodcutting: {
    label: "Woodcutting",
    anim: 879,
    site: "workTree",
    item: 1511, // LOGS
    xpPer: 25,
    roles: ["commoner"],
    sessionMin: 10,
    sessionMax: 14,
    formLines: [
      "Off to chop some logs — who's coming?",
      "Logging trip! Extra axes welcome.",
    ],
    arriveLines: ["At the trees. Let's get chopping."],
    flavorLines: [
      "felled a clean one, timber!",
      "are comparing axe swings",
      "found a bird's nest and everyone's jealous",
      "stacking logs in a neat pile",
    ],
    watchLines: [
      "Lovely day for chopping, innit?",
      "Mind the chips — working here.",
      "These trees won't chop themselves.",
    ],
  },
  fishing: {
    label: "Fishing",
    anim: 621,
    site: "dock",
    item: 317, // RAW_SHRIMPS
    xpPer: 10,
    roles: ["commoner"],
    needsDock: true,
    sessionMin: 10,
    sessionMax: 14,
    formLines: [
      "Heading down to the docks with the nets — join us!",
      "Fishing crew forming up!",
    ],
    arriveLines: ["At the docks. Nets in!"],
    flavorLines: [
      "hauled in a full net",
      "lost a net to a snag, cursed a blue streak",
      "are gutting the catch together",
      "swapping stories about the one that got away",
    ],
    watchLines: [
      "The fish are biting today.",
      "Quiet out here. Good for thinking.",
      "Pulled a fat one earlier, you should've seen it.",
    ],
  },
  mining: {
    label: "Mining",
    anim: 625,
    site: "workRock",
    items: [436, 438], // COPPER_ORE, TIN_ORE
    xpPer: 17.5,
    roles: ["commoner"],
    sessionMin: 10,
    sessionMax: 14,
    formLines: [
      "Off to the rocks — picks up, who's in?",
      "Mining crew! Bring your pick.",
    ],
    arriveLines: ["At the rocks. Swing away."],
    flavorLines: [
      "struck a rich vein",
      "are covered in rock dust, laughing about it",
      "found an oddly shaped stone and kept it",
      "got a rhythm going, the chips are flying",
    ],
    watchLines: [
      "Copper's honest work.",
      "Watch your toes around the swing.",
      "This vein's been good to us.",
    ],
  },
  cooking: {
    label: "Cooking",
    anim: 897,
    site: "tavern",
    consumes: 317, // RAW_SHRIMPS
    produces: 315, // SHRIMPS
    xpPer: 30,
    roles: ["commoner"],
    sessionMin: 8,
    sessionMax: 12,
    formLines: [
      "Got a catch to cook — heading to the tavern fire!",
      "Cooking up the day's catch, come eat!",
    ],
    arriveLines: ["At the fire. Let's get these cooking."],
    flavorLines: [
      "the shrimps are sizzling nicely",
      "burnt a batch and blamed the wind",
      "seasoned them just right, everyone's impressed",
      "sharing the first cooked batch around",
    ],
    watchLines: [
      "Smell that? Fresh catch.",
      "Nothing beats fish straight off the fire.",
      "Grab a shrimp, there's plenty.",
    ],
  },
};

const SKILL_IDS = Object.keys(SKILLS);
const DRIP_CHANCE = 0.55; // per online commoner per director tick (~60s)
const FORM_CHANCE = 0.008; // solo session, per eligible citizen per tick
const PARTY_FORM_CHANCE = 0.004; // skilling party, per eligible citizen per tick
const ARRIVE_RADIUS = 6;
const FLAVOR_CHANCE = 0.12;
const ACTION_INTERVAL_MS = 6000; // visible action cadence while on site

// --- OSRS XP table ------------------------------------------------------------

const XP_TABLE = [0, 0]; // indexed by level; level 1 needs 0 xp
(function buildXpTable() {
  let points = 0;
  for (let level = 1; level < 99; level++) {
    points += Math.floor(level + 300 * Math.pow(2, level / 7));
    XP_TABLE[level + 1] = Math.floor(points / 4);
  }
})();

function levelForXp(xp) {
  let level = 1;
  while (level < 99 && xp >= XP_TABLE[level + 1]) level++;
  return level;
}

// --- persistent XP store (same pattern as CitizenJournal) ----------------------

const SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-skills.json");

const skillStore = {
  xp: new Map(), // normalized name -> { skillId: xp }
  dirty: false,

  load() {
    try {
      const raw = fs.readFileSync(SAVE_FILE, "utf8");
      const parsed = JSON.parse(raw);
      const citizens = parsed?.citizens ?? {};
      for (const [name, entry] of Object.entries(citizens)) {
        if (entry && typeof entry.xp === "object") {
          this.xp.set(name, { ...entry.xp });
        }
      }
    } catch {
      // No save yet — start fresh.
    }
  },

  saveIfDirty() {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
      const citizens = {};
      for (const [name, xp] of this.xp) citizens[name] = { xp };
      fs.writeFileSync(SAVE_FILE, JSON.stringify({ version: 1, citizens }, null, 1));
      this.dirty = false;
    } catch {
      // Non-fatal.
    }
  },

  getXp(name, skillId) {
    return this.xp.get(normalizeName(name))?.[skillId] ?? 0;
  },

  /** Add XP; returns { leveled, level } when a level boundary is crossed. */
  addXp(name, skillId, amount) {
    const key = normalizeName(name);
    let entry = this.xp.get(key);
    if (!entry) {
      entry = {};
      this.xp.set(key, entry);
    }
    const before = levelForXp(entry[skillId] ?? 0);
    entry[skillId] = (entry[skillId] ?? 0) + amount;
    const after = levelForXp(entry[skillId]);
    this.dirty = true;
    return after > before ? { leveled: true, level: after } : { leveled: false, level: after };
  },

  getLevel(name, skillId) {
    return levelForXp(this.getXp(name, skillId));
  },
};

skillStore.load();

// --- session state (in-memory; XP is what persists) ----------------------------

const sessions = new Map(); // leader normalized name -> session
let directorRef = null;
let actionTimer = null;

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "work", text);
  } catch {
    // Non-fatal.
  }
}

function requestMovement(bot, x, y, z) {
  try {
    const { requestMovement: rm } = require("../../bots/behaviours/navigation/BotNavigation");
    rm(bot, x, y, { reason: "skilling", basicPather: true, z: z ?? 0 });
    return true;
  } catch {
    return false;
  }
}

function botTile(bot) {
  try {
    const loc = bot.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY(), z: loc.getZ?.() ?? 0 };
  } catch {
    return null;
  }
}

function chebyshev(a, b) {
  if (!a || !b) return Infinity;
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function realPlayersNear(bot) {
  const out = [];
  try {
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p !== bot && p?.isPlayerBot?.() !== true) out.push(p);
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

function shoutIfWatched(director, record, line) {
  try {
    const bot = director.getBot(record);
    if (bot && realPlayersNear(bot).length > 0) {
      try {
        { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [line] })); }
      } catch {
        // Non-fatal.
      }
    }
  } catch {
    // Non-fatal.
  }
}

function playSkillAnim(director, bot, animId) {
  try {
    const Anim = director.api?.core?.Animation;
    if (!Anim || !bot?.performAnimation) return false;
    bot.performAnimation(new Anim(animId));
    return true;
  } catch {
    return false;
  }
}

function grantItem(bot, itemId, n) {
  try {
    bot.getInventory?.()?.adds?.(itemId, n);
    return true;
  } catch {
    return false;
  }
}

function inventoryAmount(bot, itemId) {
  try {
    return bot.getInventory?.()?.getAmount?.(itemId) ?? 0;
  } catch {
    return 0;
  }
}

function takeItem(bot, itemId, n) {
  try {
    bot.getInventory?.()?.delete?.(itemId, n);
    return true;
  } catch {
    return false;
  }
}

// --- site + profession resolution -----------------------------------------------

/**
 * Resolve the skilling site for a skill in a kingdom. Woodcutting uses the
 * kingdom's tree work site; mining uses the rock work site (Keldagrim) or the
 * "rocks" quarry anchor (approximate surface rocks, documented in sites.json);
 * fishing the dock; cooking the tavern fire.
 */
function skillSiteTile(kingdomId, skillId) {
  if (skillId === "fishing") return siteTileByKingdom(kingdomId, "dock");
  if (skillId === "cooking") return siteTileByKingdom(kingdomId, "tavern");
  if (skillId === "mining") {
    if (kingdomId === "keldagrim") return siteTileByKingdom(kingdomId, "work");
    return siteTileByKingdom(kingdomId, "rocks");
  }
  // woodcutting: the kingdom tree work site (Keldagrim's is rock — excluded
  // by skillValidFor before we ever get here).
  return siteTileByKingdom(kingdomId, "work");
}

/** A citizen's profession skill, mirroring the brain's work-kind resolution. */
function professionSkill(record, director) {
  const kingdomId = record.kingdomId;
  const dock = siteTileByKingdom(kingdomId, "dock");
  const rng = agentRng(`skillprof:${record.username}`);
  if (dock && chance(rng, 0.4)) return "fishing";
  if (kingdomId === "keldagrim") return "mining";
  return "woodcutting";
}

function skillValidFor(record, director, skillId) {
  const def = SKILLS[skillId];
  if (!def.roles.includes(record.role)) return false;
  const kingdomId = record.kingdomId;
  if (def.needsDock && !siteTileByKingdom(kingdomId, "dock")) return false;
  if (skillId === "woodcutting" && kingdomId === "keldagrim") return false; // rock work site, no trees
  if (!skillSiteTile(kingdomId, skillId)) return false;
  if (skillId === "cooking") {
    // Need something to cook.
    const bot = director.getBot(record);
    if (bot && inventoryAmount(bot, def.consumes) < 1) return false;
  }
  return true;
}

function pickSkill(record, director, rng) {
  const options = SKILL_IDS.filter((id) => skillValidFor(record, director, id));
  if (!options.length) return null;
  // Weight toward the citizen's profession.
  const prof = professionSkill(record, director);
  const weighted = [...options];
  if (options.includes(prof)) weighted.push(prof, prof);
  return pickOne(rng, weighted);
}

// --- XP drip + level-ups ---------------------------------------------------------

function grantXpWithCelebration(director, record, skillId, amount) {
  const def = SKILLS[skillId];
  const { leveled, level } = skillStore.addXp(record.username, skillId, amount);
  if (leveled) {
    const line = `Reached level ${level} ${def.label}!`;
    journalEvent(record.username, line, "work");
    shoutIfWatched(director, record, `${line} ${pickLevelFlavor(record.username, skillId)}`);
  }
  return { leveled, level };
}

function pickLevelFlavor(name, skillId) {
  const rng = agentRng(`skilllvl:${name}:${Date.now() >> 18}`);
  const flavors = {
    woodcutting: ["The trees fear me now.", "These arms don't lie.", "Another level, another forest."],
    fishing: ["The fish never stood a chance.", "Patience pays off.", "Dinner's on me tonight."],
    mining: ["Struck it rich in experience.", "My pick's never been sharper.", "The rocks respect me now."],
    cooking: ["Nobody burns my batches.", "Seasoned to perfection.", "The tavern wants my recipe."],
  };
  return pickOne(rng, flavors[skillId] ?? ["Getting better every day."]);
}

function tickXpDrip(director) {
  for (const record of director.roster.values()) {
    if (!director.isOnline(record)) continue;
    if (record.role !== "commoner") continue;
    const rng = agentRng(`skilldrip:${record.username}:${Date.now() >> 16}`);
    if (!chance(rng, DRIP_CHANCE)) continue;
    const skillId = professionSkill(record, director);
    try {
      grantXpWithCelebration(director, record, skillId, 1 + Math.floor(rng() * 3));
    } catch {
      // Non-fatal.
    }
  }
  skillStore.saveIfDirty();
}

// --- session formation -------------------------------------------------------------

function eligibleForSession(record, director) {
  if (!director.isOnline(record)) return false;
  if (record.role !== "commoner") return false;
  const name = record.username;
  if (getParty(name)) return false;
  if (getFollow(name)) return false;
  if (sessions.has(normalizeName(name))) return false;
  // Not already in someone else's session.
  for (const s of sessions.values()) {
    if (s.members.some((m) => normalizeName(m) === normalizeName(name))) return false;
  }
  return true;
}

function gatherCompanions(leader, director, rng, maxExtra) {
  const companions = [];
  const seen = new Set([normalizeName(leader.username)]);
  const candidates = [];
  for (const other of director.roster.values()) {
    if (other.username === leader.username) continue;
    const on = normalizeName(other.username);
    if (seen.has(on)) continue;
    if (other.kingdomId !== leader.kingdomId) continue;
    if (other.role !== "commoner") continue;
    if (!eligibleForSession(other, director)) continue;
    if (isEnemy(leader.username, other.username) || isEnemy(other.username, leader.username)) continue;
    seen.add(on);
    candidates.push(other);
  }
  const friends = candidates.filter((c) => isFriend(leader.username, c.username));
  const rest = candidates.filter((c) => !isFriend(leader.username, c.username));
  for (let i = 0; i < rest.length; i++) {
    const j = Math.floor(rng() * rest.length);
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  for (const c of [...friends, ...rest]) {
    if (companions.length >= maxExtra) break;
    companions.push(c.username);
  }
  return companions;
}

function startSession(director, leader, companions, skillId) {
  const def = SKILLS[skillId];
  const site = skillSiteTile(leader.kingdomId, skillId);
  if (!site) return false;
  const rng = agentRng(`skillsess:${leader.username}:${Date.now() >> 16}`);
  const durationMin = def.sessionMin + Math.floor(rng() * (def.sessionMax - def.sessionMin + 1));

  const session = {
    leader: leader.username,
    members: [leader.username, ...companions],
    skill: skillId,
    site: { x: site.x, y: site.y, z: site.z ?? 0 },
    endsAt: Date.now() + durationMin * 60 * 1000,
    arrived: false,
    actions: 0,
    items: 0,
  };

  // A party exists even for solo sessions, so a real player can always join
  // via an activity invite (joinParty needs a party object).
  const party = createParty(leader.username, companions);
  party.activity = `skill:${skillId}`;
  for (const m of companions) setFollow(m, leader.username, "skilling");
  sessions.set(normalizeName(leader.username), session);

  const leaderDisplay = leader.displayName ?? leader.username;
  const what = companions.length > 0 ? `${def.label.toLowerCase()} outing` : def.label.toLowerCase();
  journalEvent(leader.username, `Headed out for ${what}.`, "work");
  for (const c of companions) {
    journalEvent(c, `Joined ${leaderDisplay}'s ${def.label.toLowerCase()} outing.`, "work");
  }
  // Shout + activity invites for nearby real players (data-tier).
  try {
    const { offerActivityToPlayers } = require("./CitizenPlayerActivities");
    offerActivityToPlayers(director, leader, party, {
      activityId: `skill:${skillId}`,
      label: `${def.label.toLowerCase()} outing`,
      formLines: def.formLines,
    });
  } catch {
    // Non-fatal.
  }
  return true;
}

function tryFormSession(record, director, asParty) {
  if (!eligibleForSession(record, director)) return false;
  const rng = agentRng(`skillsess:${record.username}:${Date.now() >> 16}`);
  if (!chance(rng, asParty ? PARTY_FORM_CHANCE : FORM_CHANCE)) return false;
  const skillId = pickSkill(record, director, rng);
  if (!skillId) return false;
  const companions = asParty ? gatherCompanions(record, director, rng, 3) : [];
  if (asParty && companions.length < 1) return false;
  return startSession(director, record, companions, skillId);
}

// --- session maintenance (director tick cadence) ------------------------------------

function tickSessions(director) {
  for (const [key, session] of [...sessions]) {
    try {
      maintainSession(director, key, session);
    } catch {
      // Non-fatal.
    }
  }

  // Formation pass.
  for (const record of director.roster.values()) {
    if (!director.isOnline(record)) continue;
    try {
      if (!tryFormSession(record, director, true)) {
        tryFormSession(record, director, false);
      }
    } catch {
      // Non-fatal.
    }
  }
}

function maintainSession(director, key, session) {
  const def = SKILLS[session.skill];
  const rng = agentRng(`skillsess:${key}:${Date.now() >> 16}`);
  const leaderRec = director.roster.get(normalizeName(session.leader));
  const leaderOnline = leaderRec && director.isOnline(leaderRec);
  const leaderBot = leaderOnline ? director.getBot(leaderRec) : null;

  if (!leaderOnline || !leaderBot) {
    endSession(director, key, session, `${def.label} outing called off — the leader headed home.`);
    return;
  }

  // Drop offline members.
  session.members = session.members.filter((m) => {
    if (normalizeName(m) === normalizeName(session.leader)) return true;
    const rec = director.roster.get(normalizeName(m));
    const online = rec && director.isOnline(rec);
    if (!online) {
      try { leaveParty(m); } catch { /* non-fatal */ }
      try { clearFollow(m); } catch { /* non-fatal */ }
      journalEvent(m, `Left the ${def.label.toLowerCase()} outing early.`, "work");
    }
    return online;
  });

  // Cooking needs raw fish; if nobody has any left, wrap up.
  if (session.skill === "cooking" && session.arrived) {
    const anyRaw = session.members.some((m) => {
      const rec = director.roster.get(normalizeName(m));
      const bot = rec && director.isOnline(rec) ? director.getBot(rec) : null;
      return bot && inventoryAmount(bot, def.consumes) > 0;
    });
    if (!anyRaw) {
      endSession(director, key, session, `Finished cooking — ${session.items} shrimps cooked.`);
      return;
    }
  }

  // Time's up.
  if (Date.now() >= session.endsAt) {
    endSession(
      director, key, session,
      sessionSummary(session, def)
    );
    return;
  }

  // Travel: nudge the leader; party members follow via tickFollow.
  const tile = botTile(leaderBot);
  if (chebyshev(tile, session.site) > ARRIVE_RADIUS) {
    const jx = session.site.x + Math.floor(rng() * 5) - 2;
    const jy = session.site.y + Math.floor(rng() * 5) - 2;
    requestMovement(leaderBot, jx, jy, session.site.z ?? 0);
    return;
  }

  if (!session.arrived) {
    session.arrived = true;
    const line = pickOne(rng, def.arriveLines);
    journalEvent(session.leader, line, "work");
    shoutIfWatched(director, leaderRec, line);
  }

  // On-site flavor (data-tier; the LLM reads the journal).
  if (chance(rng, FLAVOR_CHANCE)) {
    const online = session.members.filter((m) => {
      const rec = director.roster.get(normalizeName(m));
      return rec && director.isOnline(rec);
    });
    if (online.length) {
      const who = pickOne(rng, online);
      journalEvent(who, pickOne(rng, def.flavorLines) + ".", "work");
    }
  }

  // Data-tier chatter when real players are watching.
  if (chance(rng, 0.05)) {
    const online = session.members.filter((m) => {
      const rec = director.roster.get(normalizeName(m));
      return rec && director.isOnline(rec);
    });
    const who = pickOne(rng, online.length ? online : [session.leader]);
    const rec = director.roster.get(normalizeName(who));
    if (rec) shoutIfWatched(director, rec, pickOne(rng, def.watchLines));
  }
}

function sessionSummary(session, def) {
  const n = session.members.length;
  const who = n > 1 ? `The crew of ${n}` : (session.leader ?? "They");
  if (session.skill === "cooking") {
    return `${who} finished cooking — ${session.items} shrimps cooked, ${Math.round(session.xp ?? 0)} Cooking xp earned.`;
  }
  const itemName = { woodcutting: "logs", fishing: "shrimps", mining: "ore" }[session.skill] ?? "goods";
  return `${who} finished ${def.label.toLowerCase()} — ${session.items} ${itemName} gathered.`;
}

function endSession(director, key, session, note) {
  const def = SKILLS[session.skill];
  // Player crew members get their share of the yield, and the shared
  // session warms every citizen member toward them — before the disband.
  try {
    const {
      awardSkillingShare,
      bondAfterActivity,
    } = require("./CitizenPlayerActivities");
    awardSkillingShare(director, session, def);
    bondAfterActivity(
      director,
      getParty(session.leader),
      `${def.label.toLowerCase()} outing`
    );
  } catch {
    // Non-fatal.
  }
  for (const m of session.members) {
    try { clearFollow(m); } catch { /* non-fatal */ }
  }
  const party = getParty(session.leader);
  if (party && typeof party.activity === "string" && party.activity.startsWith("skill:")) {
    try {
      disbandParty(session.leader);
    } catch {
      for (const m of session.members) {
        try { require("./CitizenBonds").clearParty(m); } catch { /* non-fatal */ }
      }
    }
  }
  sessions.delete(key);
  journalEvent(session.leader, note, "work");
}

// --- visible action loop (6s cadence: animations + XP + items) ------------------------

function ensureActionLoop(director) {
  directorRef = director;
  if (actionTimer) return;
  actionTimer = setInterval(() => {
    try {
      tickSkillActions();
    } catch {
      // Non-fatal.
    }
  }, ACTION_INTERVAL_MS);
  if (actionTimer.unref) actionTimer.unref();
}

function tickSkillActions() {
  const director = directorRef;
  if (!director || sessions.size === 0) return;
  for (const [key, session] of [...sessions]) {
    if (!session.arrived) continue;
    const def = SKILLS[session.skill];
    for (const m of [...session.members]) {
      try {
        doSkillAction(director, key, session, def, m);
      } catch {
        // Non-fatal.
      }
    }
  }
  skillStore.saveIfDirty();
}

function doSkillAction(director, key, session, def, memberName) {
  const rec = director.roster.get(normalizeName(memberName));
  if (!rec || !director.isOnline(rec)) return;
  const bot = director.getBot(rec);
  if (!bot) return;
  const rng = agentRng(`skillact:${memberName}:${Date.now() >> 13}`);

  // Cooking consumes; if this member is out of raw fish they idle.
  if (session.skill === "cooking") {
    if (inventoryAmount(bot, def.consumes) < 1) return;
    takeItem(bot, def.consumes, 1);
  }

  // Visible: play the skilling animation where players can see it.
  playSkillAnim(director, bot, def.anim);

  // Yield: items + XP, with a level-scaled bonus chance.
  const level = skillStore.getLevel(memberName, session.skill);
  const bonusChance = Math.min(0.35, (level - 1) * 0.012);
  let n = 1;
  if (chance(rng, bonusChance)) n = 2;

  if (session.skill === "cooking") {
    grantItem(bot, def.produces, n);
  } else if (session.skill === "mining") {
    grantItem(bot, pickOne(rng, def.items), n);
  } else {
    grantItem(bot, def.item, n);
  }
  session.actions += 1;
  session.items += n;
  session.xp = (session.xp ?? 0) + def.xpPer * n;
  grantXpWithCelebration(director, rec, session.skill, def.xpPer * n);

  // Occasional journaled catch (data-tier; keeps the LLM truthful).
  if (chance(rng, 0.1)) {
    const lines = {
      woodcutting: `Chopped ${n > 1 ? n + " logs" : "a log"} — the pile's growing.`,
      fishing: `Netted ${n > 1 ? n + " shrimps" : "a shrimp"}.`,
      mining: `Dug out ${n > 1 ? n + " ores" : "an ore"}.`,
      cooking: `Cooked ${n > 1 ? n + " shrimps" : "a shrimp"} to perfection.`,
    };
    journalEvent(memberName, lines[session.skill] ?? "Kept at the work.", "work");
  }
}

// --- public tick -----------------------------------------------------------------------

function tickSkilling(director, hour) {
  void hour;
  ensureActionLoop(director);
  tickXpDrip(director);
  tickSessions(director);
}

module.exports = {
  SKILLS,
  tickSkilling,
  levelForXp,
  skillStore,
  // exposed for tests
  _sessions: sessions,
  _startSession: startSession,
};
