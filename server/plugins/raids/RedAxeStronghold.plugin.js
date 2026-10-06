"use strict";

/**
 * RedAxeStronghold — RAID SEED: the Red Axe stronghold under Keldagrim.
 *
 * Jon's vision includes WoW-style raiding. This is the second group dungeon:
 * a chaos-dwarf stronghold chamber under Keldagrim, tied to the live
 * Consortium-vs-Red-Axe politics in the world bible.
 *
 * The dungeon:
 *   Entry via a dark Tunnel in Keldagrim (spawned on server startup); the
 *   tunnel demands a party — at least 2 real players within 10 tiles, or it
 *   refuses ("You need at least one ally"). Exit is a rusted Pipe
 *   ("Climb-up") inside the chamber, or ::raid leave. No quest markers.
 *
 * The boss — the Red Axe Warlord (a chaos dwarf, 800 HP):
 *   Phase 1 (100-50%)  straight fight.
 *   Phase 2 (50%)       "To me, lads!" — summons 2 Red Axe guards. The party
 *                       must split: someone handles the adds.
 *   Phase 3 (25%)       the forge wakes. Every ~15s the warlord roars and
 *                       AoE fire hits everyone in the chamber (3s warning).
 *                       A vent-lever beside the forge can be pulled to vent
 *                       the pressure (30s cooldown) — one player must break
 *                       off DPS to work it.
 *
 * Coordination is the mechanic: adds demand target-switching, the vent
 * demands someone leaving the boss. A solo player can enter with a friend
 * but cannot do both jobs.
 *
 * INSTANCING: every party gets its own stronghold (see ./PartyInstance.js):
 * a PrivateArea over the chamber coordinates isolates players, NPCs and
 * runtime objects per party. Own boss, own adds, own loot — parties never
 * collide. Instances die when the run ends (boss slain, wipe), when the last
 * player leaves, or on the idle/lifetime sweep; a cap refuses entry instead
 * of leaking instances.
 *
 * Object options are cache-verified (not guessed): Tunnel/Enter,
 * Pipe/Climb-up, Lever/Pull. Handlers return false to fall through so the
 * Keldagrim area plugin's own Tunnel/Enter passages keep working.
 *
 * Politics (kingdom tie-in):
 *   Kill:  keldagrim:red-axe-threat -> "falling"; each participant earns
 *          Keldagrim influence (kingdom:task-completed); realm rumor;
 *          announcement. Loot is per-participant, with a 20h per-player
 *          loot lockout so the warlord can't be farmed on a loop.
 *   Wipe:  threat -> "surging"; rumor; the wiped party sits out 60s.
 *
 * In (plugin hooks): onObjectInteraction (Tunnel, Pipe, Lever),
 * onPlayerDealtDamage, onNpcBeforeDeath, onPlayerLogin, onServerStartup,
 * per-instance Area process/postEnter/postLeave/canTeleport.
 * Out (custom events): kingdom:rumor, kingdom:task-completed (influence).
 */

const Store = require("../kingdoms/KingdomStore");
const PartyInstance = require("./PartyInstance");

let api = null;
let core = null;
let instances = null;

// --- tuning ---------------------------------------------------------------

const WARLORD_HP = 800;
const GUARD_COUNT = 2;
const ENRAGE_AT_FRACTION = 0.25;
const ADDS_AT_FRACTION = 0.5;

// Forge vent: AoE every ~15s in phase 3, venting pauses it 30s.
const ENRAGE_AOE_TICKS = 25; // ~15s at 600ms
const ENRAGE_WARN_TICKS = 5; // ~3s warning
const VENT_COOLDOWN_TICKS = 50; // ~30s
const AOE_MAX_HIT = 20;

const PARTY_MIN = 2;
const PARTY_RADIUS = 10;

const MAX_INSTANCES = 8;
const INSTANCE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const INSTANCE_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;

// Wiped parties sit out a minute; a slain warlord's loot locks per player
// for 20h so the stronghold can't be farmed on a loop.
const RESPAWN_COOLDOWN_MS = 60 * 1000;
const LOOT_LOCKOUT_MS = 20 * 60 * 60 * 1000;
const RED_AXE_LAST_KILL_ATTRIBUTE = "red-axe-stronghold:last-kill";

// --- layout ---------------------------------------------------------------

// The stronghold chamber under Keldagrim (underground, z=0).
const CHAMBER = { x1: 2930, y1: 10180, x2: 2970, y2: 10220, z: 0 };
const ENTRY_TUNNEL = { x: 2855, y: 10150, z: 0 }; // Keldagrim city surface
const ENTRY_DEST = { x: 2950, y: 10190, z: 0 }; // chamber, south side
const EXIT_DEST = { x: 2855, y: 10152, z: 0 }; // back to the city

const WARLORD_SPAWN = { x: 2950, y: 10205, z: 0 };
const EXIT_PIPE = { x: 2935, y: 10185 }; // per-instance
const FORGE = { x: 2944, y: 10208 }; // per-instance, visual
const VENT_LEVER = { x: 2946, y: 10208 }; // per-instance, the mechanic

// --- per-instance run state -------------------------------------------------

function createStrongholdState() {
  return {
    spawned: false,
    over: false,
    boss: null,
    mobs: [], // the phase-2 guards (and any other adds)
    tick: 0,
    participants: new Set(), // lowercase usernames
    addsSpawned: false,
    enraged: false,
    aoeAt: 0,
    ventedUntil: 0,
    ventCooldownUntil: 0,
  };
}

// Per-party wipe cooldowns (username -> timestamp): a wiped party can't
// instantly re-enter; other parties are unaffected.
const wipeCooldowns = new Map();

// --- helpers --------------------------------------------------------------

function isRealPlayer(p) {
  return p?.isPlayer?.() === true && p?.isPlayerBot?.() !== true;
}

function username(p) {
  try {
    return (p.getUsername?.() ?? "").toLowerCase();
  } catch {
    return "";
  }
}

function locOf(entity) {
  try {
    return entity?.getLocation?.() ?? null;
  } catch {
    return null;
  }
}

function xy(loc) {
  if (!loc) return null;
  try {
    return { x: loc.getX?.() ?? loc.x, y: loc.getY?.() ?? loc.y, z: loc.getZ?.() ?? loc.z ?? 0 };
  } catch {
    return null;
  }
}

function inChamber(loc) {
  const p = xy(loc);
  return (
    p !== null &&
    p.x >= CHAMBER.x1 && p.x <= CHAMBER.x2 &&
    p.y >= CHAMBER.y1 && p.y <= CHAMBER.y2 &&
    p.z === CHAMBER.z
  );
}

/** Real players claimed by this instance who are actually inside it. */
function playersInInstance(inst) {
  const out = [];
  try {
    for (const p of inst.area.getPlayers()) {
      if (isRealPlayer(p) && inChamber(locOf(p))) out.push(p);
    }
  } catch {
    // best-effort
  }
  return out;
}

/** The instance whose warlord this npc is, or null. */
function strongholdOf(npc) {
  if (!npc?.isNpc?.()) return null;
  try {
    const inst = instances.instanceForArea(npc.getPrivateArea?.());
    if (!inst || inst.state.boss !== npc) return null;
    return inst;
  } catch {
    return null;
  }
}

function allyUsernames(player) {
  const names = [];
  try {
    const pos = xy(locOf(player)) ?? { x: 0, y: 0 };
    api.core.World.getPlayers()
      .stream()
      .filter(Boolean)
      .forEach((p) => {
        if (!isRealPlayer(p) || p === player) return;
        const pp = xy(locOf(p)) ?? { x: 0, y: 0 };
        if (Math.hypot(pp.x - pos.x, pp.y - pos.y) <= PARTY_RADIUS) names.push(username(p));
      });
  } catch {
    // best-effort
  }
  return names;
}

function announce(inst, message) {
  for (const p of playersInInstance(inst)) {
    try {
      p.sendMessage(message);
    } catch {
      // best-effort
    }
  }
}

function alive(npc) {
  try {
    return !!npc && npc.isDead?.() !== true && npc.isDying?.() !== true;
  } catch {
    return false;
  }
}

function movePlayer(player, dest) {
  try {
    player.moveTo(new core.Location(dest.x, dest.y, dest.z ?? 0));
  } catch {
    // best-effort
  }
}

function environmentalHit(player, amount, message) {
  try {
    const cur = player.getHitpoints?.() ?? 0;
    player.setHitpoints?.(Math.max(0, cur - amount));
    if (message) player.sendMessage(message);
  } catch {
    // best-effort
  }
}

// --- entry / exit -----------------------------------------------------------

function nearEntryTunnel(location) {
  const p = xy(location);
  return (
    p !== null &&
    Math.hypot(p.x - ENTRY_TUNNEL.x, p.y - ENTRY_TUNNEL.y) <= 5 &&
    p.z === ENTRY_TUNNEL.z
  );
}

function enterTunnel({ player, location }) {
  if (!isRealPlayer(player)) return false;
  if (!nearEntryTunnel(location)) return false; // not our tunnel — fall through

  const name = username(player);
  const cooldownUntil = wipeCooldowns.get(name) ?? 0;
  if (Date.now() < cooldownUntil) {
    const secs = Math.ceil((cooldownUntil - Date.now()) / 1000);
    player.sendMessage(
      `The stronghold is still stirring — the Red Axe watches the tunnel. Try again in ${secs}s.`
    );
    return true;
  }

  // Rejoining your party's run needs no ally check; a fresh run does.
  let inst = instances.rejoin(player);
  if (!inst) {
    if (allyUsernames(player).length < PARTY_MIN - 1) {
      player.sendMessage(
        "The tunnel breathes cold air. You need at least one ally at your side " +
          "to brave the Red Axe stronghold. (2+ players)"
      );
      return true;
    }
    inst = instances.acquire(player, allyUsernames(player));
    if (!inst) {
      player.sendMessage(
        "The stronghold churns below — too many war-parties down there. Catch your breath and try again shortly."
      );
      return true;
    }
  }

  // Claim the player into their party's instance BEFORE moving them: the
  // engine keeps an actor's area while its boundaries match, so the instance
  // holds them without ever touching the shared boundary index.
  try {
    inst.area.enter(player);
  } catch (err) {
    console.warn("[red-axe] instance enter failed", err?.message);
    player.sendMessage("The dark rejects you — try the tunnel again.");
    return true;
  }
  movePlayer(player, ENTRY_DEST);
  player.sendMessage("You slip into the dark tunnel, your ally close behind.");
  return true;
}

function exitChamber({ player, location }) {
  if (!isRealPlayer(player)) return false;
  const inst = instances.instanceForPlayer(player);
  if (!inst || !inChamber(locOf(player)) || !inChamber(location)) return false;
  // Leave the instance first so its postLeave sees the exit, then surface.
  try {
    inst.area.leave(player, false);
  } catch {
    // best-effort
  }
  movePlayer(player, EXIT_DEST);
  player.sendMessage("You climb the rusted pipe out of the stronghold, gasping clean air.");
  return true;
}

/** ::raid leave — retreat from the stronghold. */
function leaveRaid({ player }) {
  if (!isRealPlayer(player)) return;
  const inst = instances.instanceForPlayer(player);
  if (!inst || !inChamber(locOf(player))) {
    player.sendMessage("You are not in the stronghold.");
    return;
  }
  try {
    inst.area.leave(player, false);
  } catch {
    // best-effort
  }
  movePlayer(player, EXIT_DEST);
  player.sendMessage("You retreat from the stronghold.");
}

/** Logged back in inside the chamber: rejoin the party's run, or surface. */
function onLogin({ player }) {
  if (!isRealPlayer(player)) return;
  if (!inChamber(locOf(player))) return;
  const inst = instances.rejoin(player);
  if (!inst) {
    movePlayer(player, EXIT_DEST);
    player.sendMessage("You wake at the tunnel mouth, the stronghold's dark behind you. Your party's run is over.");
    return;
  }
  try {
    inst.area.enter(player);
    player.sendMessage("You shake off the dark and find your party's stronghold again.");
  } catch {
    movePlayer(player, EXIT_DEST);
    player.sendMessage("You wake at the tunnel mouth, the stronghold's dark behind you. Your party's run is over.");
  }
}

// --- world setup ------------------------------------------------------------

function spawnWorldObject(id, x, y, z) {
  try {
    const obj = new core.GameObject(id, new core.Location(x, y, z), 10, 0, null);
    core.ObjectManager.register(obj, true);
    return obj;
  } catch (error) {
    console.warn("[red-axe] object spawn failed", { id, x, y, error: error?.message });
    return null;
  }
}

/** The exit pipe, forge and vent lever live per-instance (maybeStartRun). */
function spawnInstanceObject(inst, id, x, y, z) {
  try {
    const obj = new core.GameObject(id, new core.Location(x, y, z), 10, 0, inst.area);
    core.ObjectManager.register(obj, true);
    return obj;
  } catch (error) {
    console.warn("[red-axe] instance object spawn failed", { id, x, y, error: error?.message });
    return null;
  }
}

function buildWorld() {
  // The stronghold's mouth in Keldagrim. Option "Enter" is cache-verified.
  spawnWorldObject(core.ObjectIdentifiers.TUNNEL, ENTRY_TUNNEL.x, ENTRY_TUNNEL.y, ENTRY_TUNNEL.z);
  console.info("[red-axe] world built — Keldagrim tunnel mouth open");
}

// --- run lifecycle ------------------------------------------------------------

function spawnMob(inst, id, x, y, hp, wanderRadius) {
  try {
    const npc = api.spawnNpc({ id, x, y, z: 0, wanderRadius: wanderRadius ?? 6 });
    if (npc && hp) {
      npc.setMaxHitpoints(hp);
      npc.setHitpoints(hp);
    }
    // Claim the NPC into the party's instance: the engine then only shows it
    // to that party (same pattern as Construction servants).
    if (npc) {
      try {
        inst.area.enter(npc);
      } catch (err) {
        console.warn("[red-axe] npc instance enter failed", err?.message);
      }
    }
    return npc;
  } catch (error) {
    console.warn("[red-axe] mob spawn failed", { id, error: error?.message });
    return null;
  }
}

function despawn(inst, npc) {
  if (!npc) return;
  // Never yank an NPC mid-death: onNpcBeforeDeath fires before the death
  // sequence, so the boss is left to die on its own.
  if (npc.isDying?.() === true || npc.isDead?.() === true) return;
  try {
    inst.area.leave(npc, false);
  } catch {
    // best-effort
  }
  try {
    api.removeNpc?.(npc);
  } catch {
    // best-effort
  }
}

function maybeStartRun(inst) {
  const st = inst.state;
  if (st.spawned || st.over) return; // a run is already live here
  st.spawned = true;
  // Per-instance scenery: only this party sees and uses it.
  spawnInstanceObject(inst, core.ObjectIdentifiers.PIPE, EXIT_PIPE.x, EXIT_PIPE.y, 0);
  spawnInstanceObject(inst, core.ObjectIdentifiers.FURNACE, FORGE.x, FORGE.y, 0);
  spawnInstanceObject(inst, core.ObjectIdentifiers.LEVER, VENT_LEVER.x, VENT_LEVER.y, 0);
  const boss = spawnMob(inst, core.NpcIdentifiers.CHAOS_DWARF, WARLORD_SPAWN.x, WARLORD_SPAWN.y, WARLORD_HP, 0);
  if (!boss) return;
  st.boss = boss;
  st.tick = 0;
  try {
    boss.forceChat("Who dares enter the Red Axe stronghold? Come, meet the axe!");
  } catch {
    // best-effort
  }
  announce(inst, "The Red Axe Warlord rises from his throne. Steel yourselves.");
  console.info("[red-axe] run started", { instance: inst.id, party: [...inst.party] });
}

function wipeInstance(inst, reason) {
  const st = inst.state;
  if (st.over) return;
  st.over = true;
  despawn(inst, st.boss);
  for (const m of st.mobs) despawn(inst, m);
  st.boss = null;
  st.mobs = [];
  // The wiped party sits out one cooldown; other parties are unaffected.
  const until = Date.now() + RESPAWN_COOLDOWN_MS;
  for (const u of inst.party) wipeCooldowns.set(u, until);
  for (const u of st.participants) wipeCooldowns.set(u, until);
  applyWipePolitics();
  instances.release(inst, reason);
  console.info("[red-axe] run wiped", { reason, instance: inst.id });
}

// --- the fight ------------------------------------------------------------------

function bossHpFraction(npc) {
  try {
    const max = npc.getMaxHitpoints?.() ?? WARLORD_HP;
    const hp = npc.getHitpoints?.() ?? max;
    return max > 0 ? hp / max : 1;
  } catch {
    return 1;
  }
}

function warlordTick(inst, boss) {
  const st = inst.state;
  if (st.over) return;
  st.tick++;
  const party = playersInInstance(inst);
  // Everyone left or died: the Red Axe holds the field.
  if (party.length === 0) {
    wipeInstance(inst, "wipe");
    return;
  }
  for (const p of party) st.participants.add(username(p));

  if (!st.enraged) return;
  // Enraged: the forge breathes fire on the whole chamber.
  if (st.tick < st.ventedUntil) return; // vented — the forge is calm
  if (st.tick < st.aoeAt - ENRAGE_WARN_TICKS) return;
  if (st.tick < st.aoeAt) {
    if (st.tick === st.aoeAt - ENRAGE_WARN_TICKS) {
      try {
        boss.forceChat("THE FORGE ROARS! BURN!");
      } catch {
        // best-effort
      }
      announce(inst, "The forge vents erupt — WORK THE VENT or BURN!");
    }
    return;
  }
  st.aoeAt = st.tick + ENRAGE_AOE_TICKS;
  for (const p of party) {
    // Environmental damage: straight hitpoint reduction (bypasses prayer —
    // it's forge-fire, not combat). Seed-simple.
    const hit = 1 + Math.floor(Math.random() * AOE_MAX_HIT);
    environmentalHit(p, hit, "The forge-fire sears you!");
  }
}

function onDamage({ target, player }) {
  const inst = strongholdOf(target);
  if (!inst || !isRealPlayer(player)) return;
  // Only this instance's party drives its own fight.
  if (instances.instanceForPlayer(player) !== inst) return;
  const st = inst.state;
  if (st.over) return;
  inst.started = true; // the run is live: only fighters may rejoin from here
  st.participants.add(username(player));
  const frac = bossHpFraction(target);

  if (!st.addsSpawned && frac <= ADDS_AT_FRACTION) {
    st.addsSpawned = true;
    try {
      target.forceChat("To me, lads! CRUSH THEM!");
    } catch {
      // best-effort
    }
    announce(inst, "The Warlord howls — Red Axe guards pour from the side tunnels!");
    for (let i = 0; i < GUARD_COUNT; i++) {
      const guard = spawnMob(
        inst,
        core.NpcIdentifiers.DWARF_GANG_MEMBER,
        WARLORD_SPAWN.x + (i === 0 ? -3 : 3),
        WARLORD_SPAWN.y + 2,
        0,
        8
      );
      if (guard) {
        st.mobs.push(guard);
        try {
          guard.forceChat("For the Red Axe!");
        } catch {
          // best-effort
        }
      }
    }
    console.info("[red-axe] adds spawned", { instance: inst.id });
  }

  if (!st.enraged && frac <= ENRAGE_AT_FRACTION) {
    st.enraged = true;
    st.aoeAt = st.tick + ENRAGE_AOE_TICKS;
    try {
      target.forceChat("YOU BREAK MY GUARD? THEN BURN WITH MY FORGE!");
    } catch {
      // best-effort
    }
    announce(
      inst,
      "The Warlord smashes the forge controls! Fire will sweep the chamber — " +
        "someone PULL THE VENT-LEVER or burn!"
    );
    console.info("[red-axe] warlord enraged", { instance: inst.id });
  }
}

function ventForge({ player, location }) {
  if (!isRealPlayer(player)) return false;
  const inst = instances.instanceForPlayer(player);
  if (!inst || inst.state.over) return false;
  // Only this stronghold's vent-lever.
  const p = xy(location);
  if (!p || Math.hypot(p.x - VENT_LEVER.x, p.y - VENT_LEVER.y) > 3 || p.z !== 0) return false;
  if (!inChamber(locOf(player))) return false;
  const st = inst.state;
  const warlord = alive(st.boss) ? st.boss : null;
  if (!warlord) {
    player.sendMessage("The forge is cold. Nothing to vent.");
    return true;
  }
  if (!st.enraged) {
    player.sendMessage("The forge rumbles but holds. Nothing to vent yet.");
    return true;
  }
  if (st.tick < st.ventCooldownUntil) {
    player.sendMessage("The vent-lever is still cooling. Give it a moment.");
    return true;
  }
  st.ventedUntil = st.tick + VENT_COOLDOWN_TICKS;
  st.ventCooldownUntil = st.tick + VENT_COOLDOWN_TICKS;
  st.aoeAt = st.tick + VENT_COOLDOWN_TICKS + ENRAGE_AOE_TICKS;
  announce(inst, `${player.getUsername()} hauls the vent-lever — pressure screams out of the forge stacks!`);
  console.info("[red-axe] forge vented", { instance: inst.id, by: username(player) });
  return true;
}

// --- loot ---------------------------------------------------------------------

function giveLoot(player, entries) {
  for (const [id, qty] of entries) {
    try {
      player.getInventory().add(new core.Item(id, qty), true);
    } catch {
      // best-effort; the message below still tells them what they earned
    }
  }
}

function warlordLoot() {
  const ids = core.ItemIdentifiers;
  const loot = [
    [ids.CHAOS_RUNE, 15 + Math.floor(Math.random() * 11)], // 15-25
    [ids.ADAMANTITE_ORE, 4 + Math.floor(Math.random() * 3)], // 4-6
    [ids.GOLD_ORE, 3 + Math.floor(Math.random() * 3)], // 3-5
    [ids.COAL, 8 + Math.floor(Math.random() * 5)], // 8-12
    [ids.COINS, 500 + Math.floor(Math.random() * 501)], // 500-1000
  ];
  if (Math.random() < 1 / 8) {
    loot.push([ids.RUNITE_ORE, 2 + Math.floor(Math.random() * 2)]); // 2-3, rare
  }
  return loot;
}

/** Loot lockout: one warlord's spoils per player per 20h. */
function lootLocked(player) {
  try {
    const last = player.getAttribute?.(RED_AXE_LAST_KILL_ATTRIBUTE) ?? 0;
    return Date.now() - last < LOOT_LOCKOUT_MS;
  } catch {
    return false;
  }
}

function markLooted(player) {
  try {
    player.setAttribute(RED_AXE_LAST_KILL_ATTRIBUTE, Date.now());
  } catch {
    // best-effort
  }
}

// --- politics -------------------------------------------------------------------

function emitRumor(kingdomId, text) {
  try {
    api.emitCustomEvent("kingdom:rumor", { kingdomId, text });
  } catch {
    // cosmetic
  }
}

function grantInfluence(player, kingdomId, task) {
  try {
    api.emitCustomEvent("kingdom:task-completed", { player, kingdomId, task });
  } catch {
    // best-effort
  }
}

function applyKillPolitics(participants) {
  Store.setFlag("keldagrim", "keldagrim:red-axe-threat", "falling");
  try {
    Store.save();
  } catch {
    // best-effort
  }
  emitRumor(
    "keldagrim",
    "Word from below: the Red Axe Warlord is dead, slain by outsiders in his own stronghold. The Consortium's enemies are quieter tonight."
  );
  const names = participants.join(", ");
  for (const name of participants) {
    try {
      const p = api.core.World.getPlayerByName?.(name);
      if (p && isRealPlayer(p)) {
        if (lootLocked(p)) {
          p.sendMessage("[Raids] The Consortium has already rewarded you for this deed recently — the spoils go to fresher blades.");
          continue;
        }
        grantInfluence(p, "keldagrim", "red-axe-stronghold:warlord");
        giveLoot(p, warlordLoot());
        markLooted(p);
        p.sendMessage("[Raids] The Warlord's hoard is yours: chaos runes, adamantite, gold — and the Consortium will remember this. (+Keldagrim influence)");
      }
    } catch {
      // best-effort
    }
  }
  try {
    api.core.World.getPlayers()
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
}

function applyWipePolitics() {
  Store.setFlag("keldagrim", "keldagrim:red-axe-threat", "surging");
  try {
    Store.save();
  } catch {
    // best-effort
  }
  emitRumor(
    "keldagrim",
    "The Red Axe grows bolder — another party went into the stronghold and never came out. The Consortium doubles its guards."
  );
}

function onWarlordDeath({ npc }) {
  const inst = strongholdOf(npc);
  if (!inst) return;
  const st = inst.state;
  if (st.over) return;
  st.over = true;
  const participants = [...st.participants];
  // Clear the field — the boss dies on its own. The instance itself stays
  // alive until the party climbs out (the exit pipe is per-instance).
  despawn(inst, st.boss);
  for (const m of st.mobs) despawn(inst, m);
  st.boss = null;
  st.mobs = [];
  applyKillPolitics(participants);
  console.info("[red-axe] warlord slain", { instance: inst.id, participants });
}

// --- the instance area ----------------------------------------------------------

function createAreaClass() {
  class StrongholdInstanceArea extends core.PrivateArea {
    constructor(inst) {
      super([new core.Boundary(CHAMBER.x1, CHAMBER.x2, CHAMBER.y1, CHAMBER.y2, CHAMBER.z)]);
      this.inst = inst;
    }

    process(mobile) {
      const inst = this.inst;
      if (!inst || inst.destroyed || inst.state.over) return;
      inst.touch();
      if (isRealPlayer(mobile)) {
        if (alive(inst.state.boss)) inst.state.participants.add(username(mobile));
        return;
      }
      if (mobile?.isNpc?.() === true && inst.state.boss && mobile === inst.state.boss) {
        warlordTick(inst, mobile);
      }
    }

    postEnter(mobile) {
      super.postEnter(mobile);
      const inst = this.inst;
      if (!inst || inst.destroyed) return;
      inst.touch();
      if (isRealPlayer(mobile)) maybeStartRun(inst);
    }

    postLeave(mobile, logout) {
      super.postLeave(mobile, logout);
      if (!isRealPlayer(mobile)) return;
      const inst = this.inst;
      instances.unassign(mobile);
      if (!inst || inst.destroyed) return;
      if (this.isDestroyed()) {
        // The area emptied and cleaned itself. A live run still needs its
        // wipe (politics, cooldowns); a finished run just needs the registry
        // dropped — release is idempotent, so the wipe path is unaffected.
        if (inst.state.over) instances.release(inst, "area-destroyed");
        else wipeInstance(inst, "empty");
        return;
      }
      if (inst.state.over) return;
      // Player already removed from the area map at this point: if nobody
      // real is left, the run collapses and the stronghold goes quiet.
      const left = this.getPlayers().filter(isRealPlayer);
      if (left.length === 0) wipeInstance(inst, "empty");
    }

    canTeleport() {
      // No teleporting out of the stronghold — climb the pipe like everyone
      // else. Death respawn uses moveTo, not TeleportHandler, so the dead
      // still leave.
      return false;
    }

    isMulti() {
      return true;
    }
  }
  return StrongholdInstanceArea;
}

// --- wiring ---------------------------------------------------------------------

module.exports = {
  name: "RedAxeStronghold",
  register(pluginApi) {
    api = pluginApi;
    core = pluginApi.core;

    instances = PartyInstance.createManager({
      api,
      core,
      name: "red-axe-stronghold",
      pluginName: "RedAxeStronghold",
      AreaClass: createAreaClass(),
      createState: createStrongholdState,
      maxInstances: MAX_INSTANCES,
      idleTimeoutMs: INSTANCE_IDLE_TIMEOUT_MS,
      maxLifetimeMs: INSTANCE_MAX_LIFETIME_MS,
      // The leak backstop: an abandoned instance wipes like an empty one.
      onTimeout: (inst, reason) => wipeInstance(inst, `timeout-${reason}`),
    });

    // Entry/exit/vent through the world. Handlers scope by location so other
    // Tunnel/Pipe/Lever objects in the world are untouched, and return false
    // to fall through when it's not ours.
    api.onObjectInteraction("Tunnel", { Enter: enterTunnel });
    api.onObjectInteraction("Pipe", { "Climb-up": exitChamber });
    api.onObjectInteraction("Lever", { Pull: ventForge });
    api.registerCommand(
      "raid",
      ({ player, parts }) => {
        if ((parts[1] ?? "").toLowerCase() === "leave") leaveRaid({ player });
        else player.sendMessage("::raid leave — retreat from the stronghold.");
      },
      api.core.PlayerRights.NONE
    );

    api.onPlayerDealtDamage(onDamage);
    api.onNpcBeforeDeath(onWarlordDeath);
    api.onPlayerLogin(onLogin);

    api.onServerStartup(buildWorld);

    console.info("[red-axe] seeded — the Red Axe stronghold waits under Keldagrim (instanced per party)");
  },
};
