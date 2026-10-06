"use strict";

/**
 * RedAxeStronghold — RAID SEED: the Red Axe stronghold under Keldagrim.
 *
 * Jon's vision includes WoW-style raiding. This is the seed: one group
 * dungeon with a boss that needs coordination, tied to kingdom politics
 * (the Consortium vs. the Red Axe — locked in the world bible).
 *
 * The dungeon:
 *   A stronghold chamber under Keldagrim. Entry via a dark tunnel in the
 *   city; the tunnel demands a party — at least 2 real players within 10
 *   tiles, or it refuses ("You need at least one ally").
 *
 * The boss — the Red Axe Warlord (a chaos dwarf, 800 HP):
 *   Phase 1 (100-50%)  straight fight.
 *   Phase 2 (50%)       "To me, lads!" — summons 2 Red Axe guards. The party
 *                       must split: someone handles the adds.
 *   Phase 3 (25%)       the forge wakes. Every ~15s the warlord roars and
 *                       AoE fire hits everyone in the chamber (3s warning).
 *                       A forge vent object can be worked to vent the pressure
 *                       (30s cooldown) — one player must break off DPS to do it.
 *
 * Coordination is the mechanic: adds demand target-switching, the vent
 * demands someone leaving the boss. A solo player can enter with a friend
 * but cannot do both jobs.
 *
 * Politics (kingdom tie-in):
 *   Kill:  keldagrim:red-axe-threat -> "falling"; +50 Keldagrim influence for
 *          each participant; realm rumor; announcement.
 *   Wipe:  threat -> "surging"; the Red Axe grows bolder (rumor).
 *
 * This is a SEED: one chamber, one boss, one mechanic set. The raid grows
 * from here (more rooms, loot tables, lockouts).
 *
 * In (plugin hooks): onPlayerDealtDamage, onNpcBeforeDeath, object clicks.
 * Out (custom events): kingdom:rumor, kingdom:influence via Influence module.
 */

const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");
const Store = require("../kingdoms/KingdomStore");

// --- tuning ---------------------------------------------------------------

const WARLORD_HP = 800;
const GUARD_COUNT = 2;
const ENRAGE_AT_FRACTION = 0.25;
const ADDS_AT_FRACTION = 0.5;

// The stronghold chamber under Keldagrim (underground, z=0).
const CHAMBER = { x1: 2930, y1: 10180, x2: 2970, y2: 10220, z: 0 };
const WARLORD_SPAWN = { x: 2950, y: 10200 };
const ENTRY_TUNNEL = { x: 2855, y: 10150 }; // in Keldagrim city
const ENTRY_DEST = { x: 2950, y: 10190 };
const EXIT_DEST = { x: 2855, y: 10152 };

// Forge vent: AoE every ~15s in phase 3, venting pauses it 30s.
const ENRAGE_AOE_TICKS = 25; // ~15s at 600ms
const ENRAGE_WARN_TICKS = 5; // ~3s warning
const VENT_COOLDOWN_TICKS = 50; // ~30s
const AOE_MAX_HIT = 20;
const AOE_RADIUS = 12;

const PARTY_MIN = 2;
const PARTY_RADIUS = 10;

const INFLUENCE_REWARD = 50;

let pluginApi = null;
let core = null;

const fights = new WeakMap(); // warlord npc -> fight state

// --- helpers --------------------------------------------------------------

function isRealPlayer(p) {
  return p?.isPlayer?.() === true && p?.isPlayerBot?.() !== true;
}

function inChamber(pos) {
  try {
    const x = pos.getX?.() ?? pos.x;
    const y = pos.getY?.() ?? pos.y;
    const z = pos.getZ?.() ?? pos.z ?? 0;
    return (
      x >= CHAMBER.x1 && x <= CHAMBER.x2 &&
      y >= CHAMBER.y1 && y <= CHAMBER.y2 &&
      z === CHAMBER.z
    );
  } catch {
    return false;
  }
}

function partyInChamber() {
  const players = [];
  try {
    pluginApi.core.World.getPlayers()
      .stream()
      .filter(Boolean)
      .forEach((p) => {
        if (isRealPlayer(p) && inChamber(p.getLocation?.())) players.push(p);
      });
  } catch {
    // best-effort
  }
  return players;
}

function nearbyAllies(player) {
  let count = 0;
  try {
    const pos = player.getLocation?.();
    const px = pos.getX?.() ?? 0;
    const py = pos.getY?.() ?? 0;
    pluginApi.core.World.getPlayers()
      .stream()
      .filter(Boolean)
      .forEach((p) => {
        if (!isRealPlayer(p) || p === player) return;
        const pp = p.getLocation?.();
        const dx = (pp.getX?.() ?? 0) - px;
        const dy = (pp.getY?.() ?? 0) - py;
        if (Math.hypot(dx, dy) <= PARTY_RADIUS) count++;
      });
  } catch {
    // best-effort
  }
  return count;
}

function isWarlord(npc) {
  return npc?.isNpc?.() === true && fights.has(npc);
}

function stateOf(npc) {
  let s = fights.get(npc);
  if (!s) {
    s = {
      addsSpawned: false,
      enraged: false,
      aoeAt: 0,
      ventedUntil: 0,
      ventCooldownUntil: 0,
      participants: new Set(),
      tick: 0,
    };
    fights.set(npc, s);
  }
  return s;
}

function announceToChamber(npc, message) {
  for (const p of partyInChamber()) {
    try {
      p.sendMessage(message);
    } catch {
      // best-effort
    }
  }
}

// --- entry ----------------------------------------------------------------

function enterTunnel({ player, location }) {
  if (!isRealPlayer(player)) return;
  // Only the Keldagrim tunnel mouth leads to the stronghold.
  if (location) {
    const lx = location.getX?.() ?? location.x ?? 0;
    const ly = location.getY?.() ?? location.y ?? 0;
    if (Math.hypot(lx - ENTRY_TUNNEL.x, ly - ENTRY_TUNNEL.y) > 5) return;
  }
  const allies = nearbyAllies(player);
  if (allies < PARTY_MIN - 1) {
    player.sendMessage(
      "The tunnel breathes cold air. You need at least one ally at your side " +
        "to brave the Red Axe stronghold. (2+ players)"
    );
    return;
  }
  player.sendMessage("You slip into the dark tunnel, your ally close behind.");
  try {
    player.moveTo(new core.Location(ENTRY_DEST.x, ENTRY_DEST.y, 0));
  } catch {
    // best-effort
  }
  maybeSpawnWarlord();
}

function exitTunnel({ player, location }) {
  if (!isRealPlayer(player)) return;
  // Only from inside the chamber.
  if (!inChamber(player.getLocation?.())) return;
  try {
    player.moveTo(new core.Location(EXIT_DEST.x, EXIT_DEST.y, 0));
    player.sendMessage("You climb out of the stronghold, gasping clean air.");
  } catch {
    // best-effort
  }
}

function leaveRaid({ player }) {
  if (!isRealPlayer(player)) return;
  if (!inChamber(player.getLocation?.())) {
    player.sendMessage("You are not in the stronghold.");
    return;
  }
  try {
    player.moveTo(new core.Location(EXIT_DEST.x, EXIT_DEST.y, 0));
    player.sendMessage("You retreat from the stronghold.");
  } catch {
    // best-effort
  }
}

// --- the fight ------------------------------------------------------------

function maybeSpawnWarlord() {
  // Only one warlord at a time.
  for (const npc of fights.keys()) {
    try {
      if (!npc.isDying?.() && !npc.isDead?.()) return;
    } catch {
      // treat as gone
    }
  }
  const npc = pluginApi.spawnNpc({
    id: core.NpcIdentifiers.CHAOS_DWARF,
    x: WARLORD_SPAWN.x,
    y: WARLORD_SPAWN.y,
    z: 0,
    wanderRadius: 0,
  });
  if (!npc) return;
  npc.setMaxHitpoints(WARLORD_HP);
  npc.setHitpoints(WARLORD_HP);
  const s = stateOf(npc);
  s.tick = 0;
  npc.forceChat("Who dares enter the Red Axe stronghold? Come, meet the axe!");
  announceToChamber(npc, "The Red Axe Warlord rises from his throne. Steel yourselves.");
  console.info("[raids] warlord spawned", { hp: WARLORD_HP });
  startFightTask(npc);
}

function startFightTask(npc) {
  const s = stateOf(npc);
  class WarlordTask extends Task {
    execute() {
      try {
        if (npc.isDead?.() || npc.isDying?.()) {
          this.stop?.();
          return;
        }
        s.tick++;
        warlordTick(npc, s);
      } catch (error) {
        console.warn("[raids] warlord tick failed", error?.message ?? error);
      }
    }
  }
  pluginApi.getTaskManager()?.submit(new WarlordTask(1));
}

function warlordTick(npc, s) {
  const party = partyInChamber();
  // Everyone left or died: the warlord stands down, the threat grows.
  if (party.length === 0) {
    onWipe(npc, s);
    return;
  }
  for (const p of party) s.participants.add(p.getUsername().toLowerCase());

  if (!s.enraged) return;
  // Enraged: the forge breathes fire.
  if (s.tick < s.ventedUntil) return; // vented — the forge is calm
  if (s.tick >= s.aoeAt - ENRAGE_WARN_TICKS && s.tick < s.aoeAt) {
    if (s.tick === s.aoeAt - ENRAGE_WARN_TICKS) {
      npc.forceChat("THE FORGE ROARS! BURN!");
      announceToChamber(npc, "The forge vents erupt — MOVE or BURN!");
    }
    return;
  }
  if (s.tick >= s.aoeAt) {
    s.aoeAt = s.tick + ENRAGE_AOE_TICKS;
    for (const p of party) {
      try {
        const dist = Math.hypot(
          (p.getLocation().getX() ?? 0) - WARLORD_SPAWN.x,
          (p.getLocation().getY() ?? 0) - WARLORD_SPAWN.y
        );
        if (dist <= AOE_RADIUS) {
          const hit = 1 + Math.floor(Math.random() * AOE_MAX_HIT);
          // Environmental damage: straight hitpoint reduction (bypasses
          // prayer — it's forge-fire, not combat). Seed-simple.
          try {
            const cur = p.getHitpoints?.() ?? 0;
            p.setHitpoints?.(Math.max(0, cur - hit));
          } catch {
            // best-effort
          }
          p.sendMessage("The forge-fire sears you!");
        }
      } catch {
        // best-effort
      }
    }
  }
}

function onDamage({ target, player }) {
  if (!isWarlord(target) || !isRealPlayer(player)) return;
  const s = stateOf(target);
  s.participants.add(player.getUsername().toLowerCase());
  const max = target.getDefinition?.().getHitpoints?.() ?? WARLORD_HP;
  const hp = target.getHitpoints?.() ?? max;
  const frac = max > 0 ? hp / max : 1;

  if (!s.addsSpawned && frac <= ADDS_AT_FRACTION) {
    s.addsSpawned = true;
    target.forceChat("To me, lads! CRUSH THEM!");
    announceToChamber(target, "The Warlord howls — Red Axe guards pour from the side tunnels!");
    for (let i = 0; i < GUARD_COUNT; i++) {
      try {
        const guard = pluginApi.spawnNpc({
          id: core.NpcIdentifiers.DWARF_GANG_MEMBER,
          x: WARLORD_SPAWN.x + (i === 0 ? -3 : 3),
          y: WARLORD_SPAWN.y + 2,
          z: 0,
          wanderRadius: 8,
        });
        guard?.forceChat?.("For the Red Axe!");
      } catch {
        // best-effort
      }
    }
  }

  if (!s.enraged && frac <= ENRAGE_AT_FRACTION) {
    s.enraged = true;
    s.aoeAt = s.tick + ENRAGE_AOE_TICKS;
    target.forceChat("YOU BREAK MY GUARD? THEN BURN WITH MY FORGE!");
    announceToChamber(
      target,
      "The Warlord smashes the forge controls! Fire will sweep the chamber — " +
        "someone WORK THE VENT or burn!"
    );
    console.info("[raids] warlord enraged");
  }
}

function ventForge({ player, location }) {
  if (!isRealPlayer(player)) return false;
  // Only the stronghold's forge can be vented.
  if (location) {
    const lx = location.getX?.() ?? location.x ?? 0;
    const ly = location.getY?.() ?? location.y ?? 0;
    if (!inChamber({ getX: () => lx, getY: () => ly, getZ: () => 0 })) return false;
  }
  // Find the warlord.
  let warlord = null;
  for (const npc of fights.keys()) {
    try {
      if (!npc.isDying?.() && !npc.isDead?.()) {
        warlord = npc;
        break;
      }
    } catch {
      // skip
    }
  }
  if (!warlord) {
    player.sendMessage("The forge is cold. Nothing to vent.");
    return true;
  }
  const s = stateOf(warlord);
  if (!s.enraged) {
    player.sendMessage("The forge rumbles but holds. Nothing to vent yet.");
    return true;
  }
  if (s.tick < s.ventCooldownUntil) {
    player.sendMessage("The vent is still cooling. Give it a moment.");
    return true;
  }
  s.ventedUntil = s.tick + VENT_COOLDOWN_TICKS;
  s.ventCooldownUntil = s.tick + VENT_COOLDOWN_TICKS;
  s.aoeAt = s.tick + VENT_COOLDOWN_TICKS + ENRAGE_AOE_TICKS;
  announceToChamber(warlord, `${player.getUsername()} works the forge vent — the flames die back!`);
  console.info("[raids] forge vented", { by: player.getUsername() });
  return true;
}

function onWarlordDeath({ npc }) {
  if (!isWarlord(npc)) return;
  const s = stateOf(npc);
  fights.delete(npc);

  // Politics: the Red Axe reels.
  Store.setFlag("keldagrim", "keldagrim:red-axe-threat", "falling");
  Store.save();
  try {
    pluginApi.emitCustomEvent("kingdom:rumor", {
      kingdomId: "keldagrim",
      text: "Word from below: the Red Axe Warlord is dead, slain by outsiders in his own stronghold. The Consortium's enemies are quieter tonight.",
    });
  } catch {
    // cosmetic
  }
  // Influence for every participant.
  for (const username of s.participants) {
    try {
      const p = pluginApi.core.World.getPlayerByName?.(username);
      if (p && isRealPlayer(p)) {
        pluginApi.emitCustomEvent("kingdom:task-completed", {
          player: p,
          kingdomId: "keldagrim",
          task: "red-axe-warlord",
        });
        p.sendMessage(
          `[Raids] The Consortium will remember this. (+${INFLUENCE_REWARD} Keldagrim influence)`
        );
      }
    } catch {
      // best-effort
    }
  }
  try {
    const names = [...s.participants].join(", ");
    pluginApi.core.World.getPlayers()
      .stream()
      .filter(Boolean)
      .forEach((p) => {
        try {
          p.sendMessage(`[Realm] The Red Axe Warlord has fallen — slain by ${names}. Keldagrim breathes easier.`);
        } catch {
          // best-effort
        }
      });
  } catch {
    // best-effort
  }
  console.info("[raids] warlord slain", { participants: [...s.participants] });
}

function onWipe(npc, s) {
  fights.delete(npc);
  try {
    pluginApi.removeNpc?.(npc);
  } catch {
    // best-effort
  }
  Store.setFlag("keldagrim", "keldagrim:red-axe-threat", "surging");
  Store.save();
  try {
    pluginApi.emitCustomEvent("kingdom:rumor", {
      kingdomId: "keldagrim",
      text: "The Red Axe grows bolder — another party went into the stronghold and never came out. The Consortium doubles its guards.",
    });
  } catch {
    // cosmetic
  }
  console.info("[raids] party wiped — threat surging");
}

// --- wiring ---------------------------------------------------------------

module.exports = {
  name: "RedAxeStronghold",
  register(api) {
    pluginApi = api;
    core = api.core;

    // Entry/exit. The tunnel mouth in Keldagrim; the furnace vent and exit inside.
    // Object names must match cache definitions; hooks by name per AGENTS.md.
    // Location checks keep these scoped to the stronghold.
    api.onObjectInteraction("Tunnel", { "Enter": enterTunnel });
    api.onObjectInteraction("Tunnel", { "Climb-up": exitTunnel });
    api.onObjectInteraction("Furnace", { "Vent": ventForge });
    api.registerCommand("raid", ({ player, parts }) => {
      if ((parts[1] ?? "").toLowerCase() === "leave") leaveRaid({ player });
      else player.sendMessage("::raid leave — retreat from the stronghold.");
    }, api.core.PlayerRights.NONE);

    api.onPlayerDealtDamage(onDamage);
    api.onNpcBeforeDeath(onWarlordDeath);

    console.info("[raids] Red Axe stronghold seeded — bring a friend");
  },
};
