"use strict";

/**
 * PartyInstance — per-party instancing for raid dungeons, built on the engine's
 * PrivateArea.
 *
 * Why PrivateArea and not TemplatedInstanceArea: raid dungeons like the Sunken
 * Hollow live on the real map (the client already draws them; no chunk copying
 * or region rebuild needed). A PrivateArea over the dungeon's real coordinates,
 * with countsAsMainWorld() === false, makes the engine isolate the party for
 * free:
 *   - World.updateLocalNpcs only shows NPCs whose BoatManager.syncArea matches
 *     the player's (the private area when countsAsMainWorld() is false),
 *   - NPC.getPlayersWithinDistance skips players in a different private area,
 *   - ObjectManager only sends runtime objects to players viewing the same area.
 * Each party therefore gets its own boss, adds, objects and loot at the same
 * coordinates, with zero cross-party interference.
 *
 * The manager owns the lifecycle; the dungeon owns the content:
 *   - the dungeon supplies an AreaClass (extends core.PrivateArea) whose
 *     process/postEnter/postLeave run that instance's fight, and a
 *     createState() factory. createState() MUST return an object with a
 *     `participants` Set of lowercase usernames — the manager uses it (plus
 *     the entry party) as the rejoin roster. The dungeon sets
 *     `instance.started = true` when the run starts (first boss damage);
 *     after that only fighters may rejoin, so the creation-time party can't
 *     pull bystanders into a live run.
 *   - the manager handles find-or-create on entry, rejoin after
 *     leave/logout, the concurrent-instance cap, and a sweep that reaps idle
 *     and over-lifetime instances so they can never leak.
 *
 * Instances are claimed explicitly (area.enter(player)) and never registered
 * with AreaManager: AreaManager keeps an actor's area while its boundaries
 * match, so the instance holds its members without polluting the shared
 * boundary index with N overlapping copies.
 */

function usernameOf(player) {
  try {
    return (player.getUsername?.() ?? "").toLowerCase() || null;
  } catch {
    return null;
  }
}

function createManager(opts) {
  const { api, core, name, AreaClass, createState } = opts ?? {};
  if (!api || !core || !name || !AreaClass || !createState) {
    throw new Error(
      "[party-instance] createManager needs { api, core, name, AreaClass, createState }"
    );
  }
  const pluginName = opts.pluginName ?? name;
  const maxInstances = opts.maxInstances ?? 8;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60 * 1000;
  const maxLifetimeMs = opts.maxLifetimeMs ?? 2 * 60 * 60 * 1000;
  const sweepEveryMs = opts.sweepEveryMs ?? 30 * 1000;
  const onTimeout = typeof opts.onTimeout === "function" ? opts.onTimeout : null;

  const instances = new Map(); // id -> instance
  const byArea = new Map(); // area -> instance
  const byPlayer = new Map(); // username -> instance
  let nextId = 1;

  function log(...args) {
    console.info(`[party-instance:${name}]`, ...args);
  }

  function isLive(inst) {
    return !!inst && !inst.destroyed && !inst.area.isDestroyed();
  }

  function discard(inst, reason) {
    if (!inst || inst.destroyed) return;
    inst.destroyed = true;
    inst.over = true;
    try {
      inst.area.destroy();
    } catch (err) {
      console.warn(`[party-instance:${name}] area destroy failed`, err?.message);
    }
    instances.delete(inst.id);
    byArea.delete(inst.area);
    for (const [user, cur] of [...byPlayer]) {
      if (cur === inst) byPlayer.delete(user);
    }
    log("discarded", { id: inst.id, reason });
  }

  function reapDead() {
    for (const inst of [...instances.values()]) {
      if (!isLive(inst)) discard(inst, "reap-dead");
    }
  }

  /** Roster that may (re)join: fighters any time; the entry party only
   *  while the run hasn't started (no boss damage yet). This keeps a
   *  bystander who loitered at creation from wandering into a live run. */
  function findJoinable(uname) {
    for (const inst of instances.values()) {
      if (!isLive(inst) || inst.over) continue;
      let member = false;
      try {
        member = inst.state.participants.has(uname);
      } catch {
        // a state without participants simply has no fighter roster
      }
      if (!member && !inst.started) member = inst.party.has(uname);
      if (member) return inst;
    }
    return null;
  }

  function trackPlayer(inst, uname) {
    inst.party.add(uname);
    byPlayer.set(uname, inst);
    inst.touch();
  }

  /**
   * Find the player's live instance, or create one for their party.
   * Returns null when the instance cap is reached (caller refuses entry).
   */
  function acquire(player, partyUsernames) {
    const uname = usernameOf(player);
    if (!uname) return null;
    let inst = byPlayer.get(uname);
    if (!isLive(inst)) {
      if (inst) byPlayer.delete(uname);
      inst = findJoinable(uname);
    }
    if (inst) {
      trackPlayer(inst, uname);
      return inst;
    }
    reapDead();
    if (instances.size >= maxInstances) {
      log("at cap, refusing entry", { player: uname, instances: instances.size });
      return null;
    }
    const created = {
      id: nextId++,
      manager: publicApi,
      party: new Set(
        partyUsernames && partyUsernames.length ? partyUsernames : [uname]
      ),
      state: createState(),
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      over: false,
      destroyed: false,
      /** Set by the dungeon when the run starts (first boss damage); after
       *  that only fighters (state.participants) may rejoin. */
      started: false,
      area: null,
      touch() {
        this.lastActiveAt = Date.now();
      },
    };
    created.party.add(uname);
    let area;
    try {
      area = new AreaClass(created);
    } catch (err) {
      console.warn(`[party-instance:${name}] AreaClass threw`, err?.message);
      return null;
    }
    // Attribute the area's tick cost to the dungeon plugin in ::pluginperf.
    area.pluginName = pluginName;
    created.area = area;
    instances.set(created.id, created);
    byArea.set(area, created);
    byPlayer.set(uname, created);
    log("created", { id: created.id, party: [...created.party] });
    return created;
  }

  /** Find the player's live instance without creating one (login rejoin). */
  function rejoin(player) {
    const uname = usernameOf(player);
    if (!uname) return null;
    let inst = byPlayer.get(uname);
    if (!isLive(inst)) {
      if (inst) byPlayer.delete(uname);
      inst = findJoinable(uname);
    }
    if (!inst) return null;
    trackPlayer(inst, uname);
    return inst;
  }

  function unassign(player) {
    const uname = usernameOf(player);
    if (uname) byPlayer.delete(uname);
  }

  function instanceForPlayer(player) {
    const inst = byPlayer.get(usernameOf(player));
    return isLive(inst) ? inst : null;
  }

  function instanceForArea(area) {
    const inst = byArea.get(area);
    return isLive(inst) ? inst : null;
  }

  /** The leak backstop: idle and over-lifetime instances are always reaped. */
  function sweep() {
    const now = Date.now();
    for (const inst of [...instances.values()]) {
      if (!isLive(inst)) {
        discard(inst, "reap-dead");
        continue;
      }
      if (now - inst.createdAt > maxLifetimeMs) {
        try {
          onTimeout?.(inst, "lifetime");
        } catch (err) {
          console.warn(`[party-instance:${name}] onTimeout failed`, err?.message);
        }
        discard(inst, "lifetime");
        continue;
      }
      if (now - inst.lastActiveAt > idleTimeoutMs) {
        try {
          onTimeout?.(inst, "idle");
        } catch (err) {
          console.warn(`[party-instance:${name}] onTimeout failed`, err?.message);
        }
        discard(inst, "idle");
      }
    }
  }

  const publicApi = {
    name,
    acquire,
    rejoin,
    unassign,
    instanceForPlayer,
    instanceForArea,
    count: () => instances.size,
    sweep,
    /** Introspection for ops/tests: proves instances don't leak. */
    stats: () => ({
      instances: instances.size,
      trackedAreas: byArea.size,
      trackedPlayers: byPlayer.size,
      nextId,
    }),
    /** Destroy an instance now (wipe / boss slain / shutdown). Idempotent. */
    release(inst, reason) {
      discard(inst, reason ?? "released");
    },
  };

  // The janitor: runs forever, cheap (a Map walk every sweep interval).
  core.TaskManager.submit(
    new (class extends core.Task {
      constructor() {
        super(Math.max(1, Math.round(sweepEveryMs / 600)), true);
      }

      execute() {
        try {
          sweep();
        } catch (err) {
          console.warn(`[party-instance:${name}] sweep failed`, err?.message);
        }
      }
    })()
  );

  return publicApi;
}

module.exports = { createManager };
