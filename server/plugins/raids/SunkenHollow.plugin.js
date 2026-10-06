"use strict";

/**
 * SunkenHollow — RAID SEED: a Myreque hideout under the Mort Myre swamp.
 *
 * The politics are live: Lowerniel Drakan still rules Morytania, the Myreque
 * resistance is newly founded and desperate, and the tension system keeps
 * Morytania's borders hot. This dungeon sits inside that powder keg.
 *
 * The dungeon:
 *   A Myreque cell hollowed out beneath the swamp south of Canifis. Entry is
 *   through the world — a dark Tunnel in the Mort Myre (a Myreque contact,
 *   Polmafi Ferdygris, lingers nearby and points the way). The tunnel demands
 *   a party: at least 2 real players within 10 tiles, or it refuses
 *   ("You need at least one ally"). No ::commands — entry and exit are both
 *   objects in the world.
 *
 *   Room A  The Shaft      — entry; 2 skeleton hellhounds (the purge turned them).
 *   Room B  The Cache      — Myreque supply crates; 2 vampyre juvinates looting them.
 *   Room C  The Warren     — narrow; a vampyric hound and a bloodveld.
 *   Room D  The Sanctum    — the boss.
 *
 * The boss — Vost, the Tithe-Taker (a feral vampyre, 900 HP), Lowerniel's
 * purge-commander, come to bleed the cell dry:
 *   Phase 1 (100-66%)  straight fight.
 *   Phase 2 (66%)       "THE TITHE!" — Vost looses a blood-thrall that fixates
 *                       one player. If it reaches them it latches on: the
 *                       victim bleeds, Vost drinks and heals. The marked player
 *                       kites while the others kill it. Repeats ~every 30s.
 *   Phase 3 (33%)       "Bring me their heart!" — Vost begins channeling on
 *                       the cell's captive fighter (30 ticks) and calls 2
 *                       purge hounds. Deal 120+ damage to Vost during the
 *                       channel to break it and save the captive. If the
 *                       channel completes the captive dies, Vost heals 30%
 *                       and enrages: blood-nova AoE sweeps the sanctum
 *                       (~every 12s, 3s warning).
 *
 * Coordination is the mechanic: the thrall demands target-switching and
 * kiting, the channel demands a DPS race while hounds chew the party. A
 * solo player with one friend can enter, but doing both jobs is the fight.
 *
 * INSTANCING: every party gets its own hollow. The dungeon lives on the real
 * map, so each party is handed a PrivateArea over the same coordinates
 * (see ./PartyInstance.js): the engine then isolates players, NPCs and
 * runtime objects per party automatically. Own boss, own adds, own loot —
 * parties never collide. Instances die when the run ends (boss slain, wipe),
 * when the last player leaves, or on the idle/lifetime sweep; a cap refuses
 * entry instead of leaking instances.
 *
 * Politics (kingdom tie-in):
 *   Kill:  Morytania tension +8 with its hottest rival (Lowerniel blames
 *          foreign meddlers for the Myreque's boldness); the rival court
 *          quietly approves — every participant earns influence with it;
 *          saving the captive earns a second share. Realm rumor + announce.
 *   Wipe:  tension +3 (the purge succeeds, Lowerniel presses harder); rumor.
 *
 * Loot feeds the economy, not just coin: vampyre dust (herblore), blood
 * runes, garlic and stakes (anti-vampyre supplies), swamp paste from the
 * crates. Loot is per-instance and per-participant — no duping across runs.
 *
 * This is a SEED: one dungeon, one boss, working end-to-end. Stubbed for
 * later: lockouts, hard-mode, collection-log entry, a Myreque reputation
 * track, and the saved captive becoming a quest contact.
 *
 * In (plugin hooks): onObjectInteraction (Tunnel, Crate), onNpcInteraction
 * (Polmafi), onPlayerDealtDamage, onNpcBeforeDeath, onPlayerLogin,
 * per-instance Area process/postEnter/postLeave/canTeleport/canAttack.
 * Out (custom events): kingdom:rumor, kingdom:task-completed (influence).
 */

const Store = require("../kingdoms/KingdomStore");
const Tension = require("../kingdoms/Tension.Kingdoms");
const PartyInstance = require("./PartyInstance");

let api = null;
let core = null;
let instances = null;

// --- tuning ---------------------------------------------------------------

const VOST_HP = 900;
const PHASE2_AT = 0.66;
const PHASE3_AT = 0.33;

const THRALL_HP = 80;
const THRALL_EVERY_TICKS = 50; // ~30s at 600ms
const THRALL_LATCH_RANGE = 1.5;
const THRALL_HEAL = 90; // 10% of Vost

const CHANNEL_TICKS = 30; // ~18s
const CHANNEL_INTERRUPT_DAMAGE = 120;
const CHANNEL_COMPLETE_HEAL = 270; // 30% of Vost

const NOVA_EVERY_TICKS = 20; // ~12s once enraged
const NOVA_WARN_TICKS = 5; // ~3s warning
const NOVA_MAX_HIT = 15;
const NOVA_RADIUS = 10;

const RESPAWN_COOLDOWN_MS = 45 * 1000;

const PARTY_MIN = 2;
const PARTY_RADIUS = 10;

const MAX_INSTANCES = 8;
const INSTANCE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const INSTANCE_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;

// --- layout ---------------------------------------------------------------

// The hollow in the Mort Myre swamp, south of Canifis. Underground rooms on z=0.
const AREA = { x1: 2978, y1: 10176, x2: 3034, y2: 10196, z: 0 };
const ENTRY_TUNNEL = { x: 3508, y: 3440, z: 0 }; // swamp surface
const CONTACT_NPC = { x: 3505, y: 3442, z: 0 };
const ENTRY_DEST = { x: 2984, y: 10186, z: 0 }; // room A
const EXIT_TUNNEL = { x: 2981, y: 10183, z: 0 }; // room A
const EXIT_DEST = { x: 3508, y: 3442, z: 0 }; // back to the swamp

const CRATES = [
  { x: 2994, y: 10184 },
  { x: 2998, y: 10188 },
];

const ROOM_MOBS = [
  // Room A: the purge turned the cell's hellhounds.
  { id: "SKELETON_HELLHOUND", x: 2982, y: 10184 },
  { id: "SKELETON_HELLHOUND", x: 2986, y: 10189 },
  // Room B: juvinates looting the cache.
  { id: "VAMPYRE_JUVENILE", x: 2995, y: 10187 },
  { id: "VAMPYRE_JUVINATE", x: 2999, y: 10184 },
  // Room C: the warren's teeth.
  { id: "VAMPIRIC_HOUND", x: 3006, y: 10186 },
  { id: "BLOODVELD", x: 3008, y: 10187 },
];

const BOSS_SPAWN = { x: 3024, y: 10186, z: 0 }; // room D sanctum
const CAPTIVE_SPAWN = { x: 3028, y: 10186, z: 0 };

// --- per-instance run state -------------------------------------------------

// One of these per party. `participants` is the manager's rejoin roster.

function createHollowState() {
  return {
    spawned: false,
    over: false,
    boss: null,
    captive: null,
    mobs: [],
    phase: 1,
    tick: 0,
    participants: new Set(),
    cratesSearched: new Set(), // usernames, reset each run
    thrall: null,
    thrallMarked: null,
    nextThrallAt: 0,
    channel: null, // { endsAt, dealt }
    captiveSaved: false,
    enraged: false,
    novaAt: 0,
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

function inDungeon(loc) {
  const p = xy(loc);
  return (
    p !== null &&
    p.x >= AREA.x1 && p.x <= AREA.x2 &&
    p.y >= AREA.y1 && p.y <= AREA.y2 &&
    p.z === AREA.z
  );
}

/** Real players claimed by this instance who are actually inside it. */
function playersInInstance(inst) {
  const out = [];
  try {
    for (const p of inst.area.getPlayers()) {
      if (isRealPlayer(p) && inDungeon(locOf(p))) out.push(p);
    }
  } catch {
    // best-effort
  }
  return out;
}

/** The instance whose Vost this npc is, or null. */
function hollowOf(npc) {
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

function nearbyAllies(player) {
  return allyUsernames(player).length;
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

function hitDamage(hit) {
  let total = 0;
  try {
    for (const part of hit?.getHits?.() ?? []) total += part?.getDamage?.() ?? 0;
  } catch {
    // best-effort
  }
  return total;
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

// --- entry / exit (through the world, no ::commands) -----------------------

function nearSwampEntrance(location) {
  const p = xy(location);
  return p !== null && Math.hypot(p.x - ENTRY_TUNNEL.x, p.y - ENTRY_TUNNEL.y) <= 6 && p.z === 0;
}

function climbDown({ player, location }) {
  if (!isRealPlayer(player)) return;
  if (!nearSwampEntrance(location)) return; // not our tunnel
  const name = username(player);

  const cooldownUntil = wipeCooldowns.get(name) ?? 0;
  if (Date.now() < cooldownUntil) {
    const secs = Math.ceil((cooldownUntil - Date.now()) / 1000);
    player.sendMessage(
      `The hollow is still settling — the purge watches the tunnel. Try again in ${secs}s.`
    );
    return;
  }

  // Rejoining your party's run needs no ally check; a fresh run does.
  // (rejoin covers both the tracked player and a late ally in the roster —
  // the second blade through the tunnel finds no allies on the surface.)
  let inst = instances.rejoin(player);
  if (!inst) {
    if (nearbyAllies(player) < PARTY_MIN - 1) {
      player.sendMessage(
        "A cold breath rises from the tunnel. Polmafi's voice hisses behind you: " +
          "\"Not alone, friend. The Tithe-Taker eats lone wolves. Bring at least one ally. (2+ players)\""
      );
      return;
    }
    inst = instances.acquire(player, allyUsernames(player));
    if (!inst) {
      player.sendMessage(
        "The hollow churns below — too many war-parties down there. Catch your breath and try again shortly."
      );
      return;
    }
  }

  // Claim the player into their party's instance BEFORE moving them: the
  // engine keeps an actor's area while its boundaries match, so the instance
  // holds them without ever touching the shared boundary index.
  try {
    inst.area.enter(player);
  } catch (err) {
    console.warn("[sunken-hollow] instance enter failed", err?.message);
    player.sendMessage("The dark rejects you — try the tunnel again.");
    return;
  }
  movePlayer(player, ENTRY_DEST);
  player.sendMessage("You slip down into the dark, your ally close behind. The Myreque hollow swallows you.");
}

function climbUp({ player, location }) {
  if (!isRealPlayer(player)) return;
  if (!inDungeon(location)) return; // not our tunnel
  // Leave the instance first so its postLeave sees the exit, then surface.
  try {
    instances.instanceForPlayer(player)?.area.leave(player, false);
  } catch {
    // best-effort
  }
  movePlayer(player, EXIT_DEST);
  player.sendMessage("You climb out of the hollow, gasping swamp air.");
}

function talkToPolmafi({ player }) {
  if (!isRealPlayer(player)) return;
  player.sendMessage("Polmafi Ferdygris: \"The hollow beneath us was ours — a Myreque cell, hidden and safe.\"");
  player.sendMessage("Polmafi Ferdygris: \"Then Lowerniel's Tithe-Taker found it. Vost. He bleeds our people for the tithe.\"");
  player.sendMessage("Polmafi Ferdygris: \"The tunnel is behind me. Go with a friend — two blades at least — and end him.\"");
  player.sendMessage("Polmafi Ferdygris: \"Save our captive in the sanctum if you can. The Myreque remembers its debts.\"");
}

/** Logged back in inside the hollow: rejoin the party's run, or surface. */
function onLogin({ player }) {
  if (!isRealPlayer(player)) return;
  if (!inDungeon(locOf(player))) return;
  const inst = instances.rejoin(player);
  if (!inst) {
    movePlayer(player, EXIT_DEST);
    player.sendMessage("You wake at the tunnel mouth, the hollow's dark behind you. Your party's run is over.");
    return;
  }
  try {
    inst.area.enter(player);
    player.sendMessage("You shake off the dark and find your party's hollow again.");
  } catch {
    movePlayer(player, EXIT_DEST);
    player.sendMessage("You wake at the tunnel mouth, the hollow's dark behind you. Your party's run is over.");
  }
}

// --- world setup ------------------------------------------------------------

function spawnWorldObject(id, x, y, z) {
  try {
    const obj = new core.GameObject(id, new core.Location(x, y, z), 10, 0, null);
    core.ObjectManager.register(obj, true);
    return obj;
  } catch (error) {
    console.warn("[sunken-hollow] object spawn failed", { id, x, y, error: error?.message });
    return null;
  }
}

/** The exit tunnel and crates live per-instance (spawned in maybeStartRun). */
function spawnInstanceObject(inst, id, x, y, z) {
  try {
    const obj = new core.GameObject(id, new core.Location(x, y, z), 10, 0, inst.area);
    core.ObjectManager.register(obj, true);
    return obj;
  } catch (error) {
    console.warn("[sunken-hollow] instance object spawn failed", { id, x, y, error: error?.message });
    return null;
  }
}

function buildWorld() {
  // The hidden entrance in the Mort Myre swamp. Same object id/options the
  // Red Axe stronghold proved work in production ("Tunnel"/"Enter").
  spawnWorldObject(core.ObjectIdentifiers.TUNNEL, ENTRY_TUNNEL.x, ENTRY_TUNNEL.y, ENTRY_TUNNEL.z);
  // The Myreque contact near the entrance.
  try {
    api.spawnNpc({
      id: core.NpcIdentifiers.POLMAFI_FERDYGRIS,
      x: CONTACT_NPC.x,
      y: CONTACT_NPC.y,
      z: CONTACT_NPC.z,
      wanderRadius: 2,
    });
  } catch (error) {
    console.warn("[sunken-hollow] contact npc spawn failed", error?.message);
  }
  console.info("[sunken-hollow] world built — Mort Myre entrance open");
}

// --- run lifecycle ------------------------------------------------------------

function spawnMob(inst, idName, x, y, hp) {
  try {
    const id = core.NpcIdentifiers[idName];
    if (!id) {
      console.warn("[sunken-hollow] unknown npc id", idName);
      return null;
    }
    const npc = api.spawnNpc({ id, x, y, z: 0, wanderRadius: 6 });
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
        console.warn("[sunken-hollow] npc instance enter failed", err?.message);
      }
    }
    return npc;
  } catch (error) {
    console.warn("[sunken-hollow] mob spawn failed", { idName, error: error?.message });
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
  spawnInstanceObject(inst, core.ObjectIdentifiers.TUNNEL, EXIT_TUNNEL.x, EXIT_TUNNEL.y, EXIT_TUNNEL.z);
  for (const c of CRATES) {
    spawnInstanceObject(inst, core.ObjectIdentifiers.CRATE, c.x, c.y, 0);
  }
  for (const m of ROOM_MOBS) {
    const npc = spawnMob(inst, m.id, m.x, m.y);
    if (npc) st.mobs.push(npc);
  }
  // The cell's captive fighter, bound in the sanctum — the stakes of phase 3.
  st.captive = spawnMob(inst, "MAN", CAPTIVE_SPAWN.x, CAPTIVE_SPAWN.y);
  try {
    st.captive?.forceChat?.("Help... please... don't let him take me...");
  } catch {
    // best-effort
  }
  const boss = spawnMob(inst, "FERAL_VAMPYRE", BOSS_SPAWN.x, BOSS_SPAWN.y, VOST_HP);
  if (!boss) return;
  st.boss = boss;
  st.tick = 0;
  console.info("[sunken-hollow] run started", { instance: inst.id, party: [...inst.party] });
}

function wipeInstance(inst, reason) {
  const st = inst.state;
  if (st.over) return;
  st.over = true;
  despawn(inst, st.boss);
  despawn(inst, st.captive);
  despawn(inst, st.thrall);
  for (const m of st.mobs) despawn(inst, m);
  st.boss = null;
  st.captive = null;
  st.thrall = null;
  st.mobs = [];
  // The wiped party sits out one cooldown; other parties are unaffected.
  const until = Date.now() + RESPAWN_COOLDOWN_MS;
  for (const u of inst.party) wipeCooldowns.set(u, until);
  for (const u of st.participants) wipeCooldowns.set(u, until);
  applyWipePolitics();
  instances.release(inst, reason);
  console.info("[sunken-hollow] run wiped", { reason, instance: inst.id });
}

// --- the fight ------------------------------------------------------------------

function bossHpFraction(npc) {
  try {
    const max = npc.getMaxHitpoints?.() ?? VOST_HP;
    const hp = npc.getHitpoints?.() ?? max;
    return max > 0 ? hp / max : 1;
  } catch {
    return 1;
  }
}

function heal(npc, amount) {
  try {
    const max = npc.getMaxHitpoints?.() ?? VOST_HP;
    npc.setHitpoints?.(Math.min(max, (npc.getHitpoints?.() ?? 0) + amount));
  } catch {
    // best-effort
  }
}

function spawnThrall(inst, boss) {
  const st = inst.state;
  const party = playersInInstance(inst);
  if (party.length === 0) return;
  const marked = party[Math.floor(Math.random() * party.length)];
  const bp = xy(locOf(boss)) ?? BOSS_SPAWN;
  const thrall = spawnMob(inst, "FERAL_VAMPYRE_2", bp.x - 2, bp.y, THRALL_HP);
  if (!thrall) return;
  st.thrall = thrall;
  st.thrallMarked = username(marked);
  try {
    thrall.getCombat?.().attack(marked);
    thrall.forceChat?.("Your blood for the Tithe!");
  } catch {
    // best-effort
  }
  boss.forceChat("THE TITHE! Bring me their blood!");
  announce(inst, "Vost looses a blood-thrall — it fixates " + (marked.getUsername?.() ?? "one of you") + "! Kite it, kill it, keep it off them!");
  st.nextThrallAt = st.tick + THRALL_EVERY_TICKS;
  console.info("[sunken-hollow] thrall spawned", { instance: inst.id, marked: st.thrallMarked });
}

function thrallTick(inst) {
  const st = inst.state;
  const thrall = st.thrall;
  if (!alive(thrall)) {
    st.thrall = null;
    st.thrallMarked = null;
    return;
  }
  // Marked player gone (or out of this instance)? Pick another victim here.
  let marked = null;
  try {
    marked = api.core.World.getPlayerByName?.(st.thrallMarked);
  } catch {
    // best-effort
  }
  if (!isRealPlayer(marked) || instances.instanceForPlayer(marked) !== inst || !inDungeon(locOf(marked))) {
    const party = playersInInstance(inst);
    if (party.length === 0) return;
    marked = party[Math.floor(Math.random() * party.length)];
    st.thrallMarked = username(marked);
    try {
      thrall.getCombat?.().attack(marked);
    } catch {
      // best-effort
    }
  }
  const tp = xy(locOf(thrall));
  const mp = xy(locOf(marked));
  if (!tp || !mp) return;
  if (Math.hypot(tp.x - mp.x, tp.y - mp.y) <= THRALL_LATCH_RANGE) {
    // Latched: the victim bleeds, Vost drinks.
    despawn(inst, thrall);
    st.thrall = null;
    st.thrallMarked = null;
    environmentalHit(marked, 6 + Math.floor(Math.random() * 7), "The thrall latches on and drinks deep!");
    heal(st.boss, THRALL_HEAL);
    try {
      st.boss?.forceChat?.("Ahhh. Sweet.");
    } catch {
      // best-effort
    }
    announce(inst, "The blood-thrall drinks its fill — Vost is renewed!");
    console.info("[sunken-hollow] thrall latched, Vost healed", { instance: inst.id });
  }
}

function startChannel(inst, boss) {
  const st = inst.state;
  if (!alive(st.captive)) return; // nothing to threaten
  st.channel = { endsAt: st.tick + CHANNEL_TICKS, dealt: 0 };
  boss.forceChat("Bring me their heart! BLEED THEM DRY!");
  announce(
    inst,
    "Vost begins drawing the life from the captive Myreque fighter! " +
      `Deal ${CHANNEL_INTERRUPT_DAMAGE}+ damage to Vost to break the channel!`
  );
  // Purge hounds pour in — someone has to peel.
  const bp = xy(locOf(boss)) ?? BOSS_SPAWN;
  for (let i = 0; i < 2; i++) {
    const hound = spawnMob(inst, "VAMPIRIC_HOUND", bp.x + (i === 0 ? -3 : 3), bp.y + 2);
    if (hound) {
      st.mobs.push(hound);
      try {
        hound.forceChat?.("For the Tithe!");
      } catch {
        // best-effort
      }
    }
  }
  console.info("[sunken-hollow] channel started", { instance: inst.id });
}

function channelTick(inst, boss) {
  const st = inst.state;
  const ch = st.channel;
  if (!ch) return;
  // The captive suffers while the channel runs.
  if (alive(st.captive) && st.tick % 3 === 0) {
    try {
      const cur = st.captive.getHitpoints?.() ?? 0;
      st.captive.setHitpoints?.(Math.max(1, cur - 2));
      if (st.tick % 9 === 0) st.captive.forceChat?.("No... not like this...");
    } catch {
      // best-effort
    }
  }
  if (st.tick < ch.endsAt) return;
  // Channel complete: the captive dies, Vost feasts and enrages.
  st.channel = null;
  if (alive(st.captive)) {
    try {
      st.captive.forceChat?.("Tell... the cell... I held...");
    } catch {
      // best-effort
    }
    despawn(inst, st.captive);
    st.captive = null;
  }
  heal(boss, CHANNEL_COMPLETE_HEAL);
  st.enraged = true;
  st.novaAt = st.tick + NOVA_EVERY_TICKS;
  boss.forceChat("THE HEART IS MINE! NOW BURN, ALL OF YOU!");
  announce(inst, "Vost drains the captive's heart and ERUPTS — blood-novas incoming! Spread out!");
  console.info("[sunken-hollow] channel completed — Vost enraged", { instance: inst.id });
}

function novaTick(inst, boss) {
  const st = inst.state;
  if (!st.enraged) return;
  if (st.tick < st.novaAt - NOVA_WARN_TICKS) return;
  if (st.tick < st.novaAt) {
    if (st.tick === st.novaAt - NOVA_WARN_TICKS) {
      boss.forceChat("BURN IN MY BLOOD!");
      announce(inst, "Vost swells with stolen blood — a nova is coming! MOVE!");
    }
    return;
  }
  st.novaAt = st.tick + NOVA_EVERY_TICKS;
  const bp = xy(locOf(boss)) ?? BOSS_SPAWN;
  for (const p of playersInInstance(inst)) {
    try {
      const pp = xy(locOf(p));
      if (!pp) continue;
      if (Math.hypot(pp.x - bp.x, pp.y - bp.y) <= NOVA_RADIUS) {
        const hit = 1 + Math.floor(Math.random() * NOVA_MAX_HIT);
        environmentalHit(p, hit, "The blood-nova sears you!");
      }
    } catch {
      // best-effort
    }
  }
}

function bossTick(inst, boss) {
  const st = inst.state;
  if (st.over) return;
  st.tick++;
  const party = playersInInstance(inst);
  // Everyone left or died: the purge wins this round.
  if (party.length === 0) {
    wipeInstance(inst, "wipe");
    return;
  }
  for (const p of party) st.participants.add(username(p));

  // Phase transitions are driven by damage (onDamage); the tick runs the machinery.
  if (st.phase >= 2) {
    if (alive(st.thrall)) thrallTick(inst);
    else if (st.tick >= st.nextThrallAt) spawnThrall(inst, boss);
  }
  if (st.channel) channelTick(inst, boss);
  novaTick(inst, boss);
}

function onDamage({ target, player, hit }) {
  const inst = hollowOf(target);
  if (!inst || !isRealPlayer(player)) return;
  // Only this instance's party drives its own fight.
  if (instances.instanceForPlayer(player) !== inst) return;
  const st = inst.state;
  if (st.over) return;
  inst.started = true; // the run is live: only fighters may rejoin from here
  st.participants.add(username(player));
  const frac = bossHpFraction(target);

  if (st.phase === 1 && frac <= PHASE2_AT) {
    st.phase = 2;
    st.nextThrallAt = st.tick + 5;
    target.forceChat("You bleed nicely. THE TITHE! Bring me their blood!");
    announce(inst, "Vost howls — from here on, blood-thralls will hunt the party!");
    console.info("[sunken-hollow] phase 2", { instance: inst.id });
  }

  if (st.phase === 2 && frac <= PHASE3_AT) {
    st.phase = 3;
    target.forceChat("Enough games. Bring me their HEART!");
    announce(inst, "Vost turns on the captive — stop the channel or lose them!");
    startChannel(inst, target);
    console.info("[sunken-hollow] phase 3", { instance: inst.id });
  }

  // Breaking the channel: raw damage on Vost while he channels.
  if (st.channel) {
    st.channel.dealt += hitDamage(hit);
    if (st.channel.dealt >= CHANNEL_INTERRUPT_DAMAGE) {
      st.channel = null;
      st.captiveSaved = true;
      target.forceChat("NO! You will NOT take them from me!");
      announce(inst, `${player.getUsername?.() ?? "A hero"} breaks the channel — the captive lives! The Myreque will remember this.`);
      try {
        st.captive?.forceChat?.("I... I owe you my life. The cell owes you.");
      } catch {
        // best-effort
      }
      console.info("[sunken-hollow] channel interrupted — captive saved", { instance: inst.id });
    }
  }
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

function bossLoot(captiveSaved) {
  const ids = core.ItemIdentifiers;
  const dust = 3 + Math.floor(Math.random() * 3); // 3-5
  const runes = 8 + Math.floor(Math.random() * 5); // 8-12
  const coins = 300 + Math.floor(Math.random() * 301); // 300-600
  const loot = [
    [ids.VAMPYRE_DUST, dust],
    [ids.BLOOD_RUNE, runes],
    [ids.GARLIC, 2],
    [ids.STAKE, 1],
    [ids.COINS, coins],
  ];
  if (captiveSaved) {
    loot.push([ids.BLOOD_RUNE, 10]);
    loot.push([ids.VAMPYRE_DUST, 5]);
  }
  return loot;
}

function searchCrate({ player, location }) {
  if (!isRealPlayer(player)) return;
  const inst = instances.instanceForPlayer(player);
  if (!inst || inst.state.over) return;
  const p = xy(location);
  if (!p) return;
  const isOurs = CRATES.some((c) => Math.hypot(c.x - p.x, c.y - p.y) <= 2 && p.z === 0);
  if (!isOurs) return; // some other crate in the world
  if (!inDungeon(locOf(player))) return;
  const st = inst.state;
  const name = username(player);
  if (st.cratesSearched.has(name + "@" + p.x + "," + p.y)) {
    player.sendMessage("You've already picked this crate clean.");
    return;
  }
  st.cratesSearched.add(name + "@" + p.x + "," + p.y);
  const ids = core.ItemIdentifiers;
  const loot = [
    [ids.BLOOD_RUNE, 5],
    [ids.GARLIC, 1],
    [ids.SWAMP_PASTE, 2],
    [ids.COINS, 150 + Math.floor(Math.random() * 151)],
  ];
  giveLoot(player, loot);
  player.sendMessage("You search the Myreque supply crate: blood runes, garlic, swamp paste — the cell's war-stock.");
  console.info("[sunken-hollow] crate searched", { instance: inst.id, by: name });
}

// --- politics -------------------------------------------------------------------

function hottestRival() {
  try {
    const pairs = Tension.hottestPairs?.(12) ?? [];
    const hit = pairs.find((e) => e.a === "morytania" || e.b === "morytania");
    if (hit) return hit.a === "morytania" ? hit.b : hit.a;
  } catch {
    // fall through
  }
  return "kandarin"; // seeded hottest at 74
}

function kingdomName(id) {
  try {
    return Store.getKingdom?.(id)?.name ?? id;
  } catch {
    return id;
  }
}

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

function applyKillPolitics(participants, captiveSaved) {
  const rival = hottestRival();
  const rivalName = kingdomName(rival);
  try {
    Tension.addTension("morytania", rival, 8);
  } catch (error) {
    console.warn("[sunken-hollow] tension shift failed", error?.message);
  }
  Store.setFlag("morytania", "morytania:myreque-resurgent", true);
  try {
    Store.save();
  } catch {
    // best-effort
  }
  emitRumor(
    "morytania",
    "Blood in the swamp: Lowerniel's Tithe-Taker Vost was slain in a Myreque hollow. " +
      "The purge falters — and the Lord of the Dark does not forgive failure."
  );
  emitRumor(
    rival,
    `Quiet word from the Mort Myre: the Myreque bloodied Lowerniel's purge tonight, and ${rivalName}'s court takes careful note of who did it.`
  );
  for (const name of participants) {
    try {
      const p = api.core.World.getPlayerByName?.(name);
      if (p && isRealPlayer(p)) {
        grantInfluence(p, rival, "sunken-hollow:vost");
        if (captiveSaved) grantInfluence(p, rival, "sunken-hollow:captive-saved");
        p.sendMessage(
          `[Myreque] ${rivalName} will remember this. (+influence with ${rivalName}${captiveSaved ? ", doubled for the rescue" : ""})`
        );
      }
    } catch {
      // best-effort
    }
  }
}

function applyWipePolitics() {
  const rival = hottestRival();
  try {
    Tension.addTension("morytania", rival, 3);
  } catch (error) {
    console.warn("[sunken-hollow] tension shift failed", error?.message);
  }
  Store.setFlag("morytania", "morytania:purge-succeeding", true);
  try {
    Store.save();
  } catch {
    // best-effort
  }
  emitRumor(
    "morytania",
    "The purge claims another cell — sellswords went into the Mort Myre hollow and never came out. Lowerniel's tithe-men grow bolder."
  );
}

function onBossDeath({ npc }) {
  const inst = hollowOf(npc);
  if (!inst) return;
  const st = inst.state;
  if (st.over) return;
  st.over = true;
  const participants = [...st.participants];
  const captiveSaved = st.captiveSaved;
  const names = participants.join(", ");
  // Clear the field — the boss dies on its own. The instance itself stays
  // alive until the party climbs out (the exit tunnel is per-instance).
  despawn(inst, st.captive);
  despawn(inst, st.thrall);
  for (const m of st.mobs) despawn(inst, m);
  st.boss = null;
  st.captive = null;
  st.thrall = null;
  st.mobs = [];
  // Loot for everyone who fought — per-instance, per-participant.
  for (const name of participants) {
    try {
      const p = api.core.World.getPlayerByName?.(name);
      if (p && isRealPlayer(p)) {
        giveLoot(p, bossLoot(captiveSaved));
        p.sendMessage("[Myreque] Vost's hoard is yours: vampyre dust, blood runes, garlic, stakes.");
      }
    } catch {
      // best-effort
    }
  }
  applyKillPolitics(participants, captiveSaved);
  try {
    api.core.World.getPlayers()
      .stream()
      .filter(Boolean)
      .forEach((p) => {
        try {
          p.sendMessage(
            `[Realm] Vost the Tithe-Taker has fallen in the Mort Myre — slain by ${names}. The Myreque breathes tonight.`
          );
        } catch {
          // best-effort
        }
      });
  } catch {
    // best-effort
  }
  console.info("[sunken-hollow] Vost slain", { instance: inst.id, participants, captiveSaved });
}

// --- the instance area ----------------------------------------------------------

function createAreaClass() {
  class HollowInstanceArea extends core.PrivateArea {
    constructor(inst) {
      super([new core.Boundary(AREA.x1, AREA.x2, AREA.y1, AREA.y2, AREA.z)]);
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
        bossTick(inst, mobile);
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
      // real is left, the run collapses and the hollow goes quiet.
      const left = this.getPlayers().filter(isRealPlayer);
      if (left.length === 0) wipeInstance(inst, "empty");
    }

    canTeleport() {
      // No teleporting out of the hollow — climb the tunnel like everyone else.
      // Death respawn uses moveTo, not TeleportHandler, so the dead still leave.
      return false;
    }

    canAttack(attacker, target) {
      // The captive is not a valid target.
      const st = this.inst?.state;
      if (target && st?.captive && target === st.captive) return false;
      return null;
    }

    isMulti() {
      return true;
    }
  }
  return HollowInstanceArea;
}

// --- wiring ---------------------------------------------------------------------

module.exports = {
  name: "SunkenHollow",
  register(pluginApi) {
    api = pluginApi;
    core = pluginApi.core;

    instances = PartyInstance.createManager({
      api,
      core,
      name: "sunken-hollow",
      pluginName: "SunkenHollow",
      AreaClass: createAreaClass(),
      createState: createHollowState,
      maxInstances: MAX_INSTANCES,
      idleTimeoutMs: INSTANCE_IDLE_TIMEOUT_MS,
      maxLifetimeMs: INSTANCE_MAX_LIFETIME_MS,
      // The leak backstop: an abandoned instance wipes like an empty one.
      onTimeout: (inst, reason) => wipeInstance(inst, `timeout-${reason}`),
    });

    // Entry/exit through the world. Handlers scope by location so the other
    // Tunnel/Crate objects in the world are untouched.
    api.onObjectInteraction("Tunnel", { Enter: climbDown });
    api.onObjectInteraction("Tunnel", { "Climb-up": climbUp });
    api.onNpcInteraction("Polmafi Ferdygris", { "Talk-to": talkToPolmafi });

    api.onPlayerDealtDamage(onDamage);
    api.onNpcBeforeDeath(onBossDeath);
    api.onPlayerLogin(onLogin);

    api.onServerStartup(buildWorld);

    console.info("[sunken-hollow] seeded — a Myreque hollow waits under the Mort Myre (instanced per party)");
  },
};
