"use strict";

const fs = require("fs");
const path = require("path");
const { Skill } = require("../../../src/main/typescript/elvarg/game/model/Skill");
const { ItemIds } = require("../../../src/main/typescript/elvarg/util/IdEnums");
const { createInteractObjectAction } = require("./actions/InteractObject");
const { createDropItemsAction } = require("./actions/DropItems");
const { createEquipToolAction } = require("./actions/EquipTool");
const { createBankAction } = require("./actions/Bank");
const { createWalkToAction } = require("./actions/WalkTo");
const { createEnsureItemAction } = require("./actions/EnsureItem");
const { createLightFireAction } = require("./actions/LightFire");
const { createSmeltAction } = require("./actions/Smelt");
const { createPvpCombatAction } = require("./actions/PvpCombat");
const { createWanderAction } = require("./actions/Wander");
const { createFollowOwnerAction } = require("./actions/FollowOwner");

const DEFAULT_DEFINITIONS_PATH = path.join(
  process.cwd(),
  "data",
  "definitions",
  "bot-activities.json"
);

/**
 * Extension seam for the activity catalogue (used by the citizens plugin).
 * Other plugins register new action types / condition kinds here instead of
 * editing this file's dispatch tables. Registrations are consulted before the
 * built-in types, so an extension can also override a built-in if needed.
 */
const EXTENDED_ACTION_TYPES = new Map();
const EXTENDED_CONDITION_KINDS = new Map();
const TRACKED_REGISTRIES = [];

function registerBotActionType(type, factory) {
  if (typeof type !== "string" || typeof factory !== "function") {
    throw new Error("[bot activities] registerBotActionType needs (type, factory)");
  }
  EXTENDED_ACTION_TYPES.set(type, factory);
}

function registerBotConditionKind(kind, factory) {
  if (typeof kind !== "string" || typeof factory !== "function") {
    throw new Error("[bot activities] registerBotConditionKind needs (kind, factory)");
  }
  EXTENDED_CONDITION_KINDS.set(kind, factory);
}

/** Every registry created by this module, oldest first (bots boot first). */
function getBotActivityRegistries() {
  return TRACKED_REGISTRIES.slice();
}

function applyFields(value, fields) {
  if (typeof value === "string") {
    if (value.startsWith("$") && Object.prototype.hasOwnProperty.call(fields, value.slice(1))) {
      return fields[value.slice(1)];
    }
    return value.replace(/\$([A-Za-z0-9_]+)/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(fields, key) ? String(fields[key]) : match
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => applyFields(entry, fields));
  }
  if (value && typeof value === "object") {
    const next = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = applyFields(entry, fields);
    }
    return next;
  }
  return value;
}

function resolveItemId(name) {
  if (Number.isInteger(name)) {
    return name;
  }
  const key = String(name).trim().toUpperCase().replace(/[\s-]+/g, "_");
  return ItemIds[key] ?? null;
}

function resolveSkill(name) {
  const key = String(name).trim().toUpperCase().replace(/[\s-]+/g, "_");
  return Skill[key] ?? null;
}

function createCondition(spec) {
  if (spec && typeof spec === "object") {
    const keys = Object.keys(spec);
    if (keys.length === 1 && EXTENDED_CONDITION_KINDS.has(keys[0])) {
      return EXTENDED_CONDITION_KINDS.get(keys[0])(spec[keys[0]]);
    }
  }
  if (spec.skill) {
    const skill = resolveSkill(spec.skill.id);
    const min = Number(spec.skill.min ?? 1);
    const max = Number(spec.skill.max ?? 99);
    return {
      id: `skill:${spec.skill.id}`,
      check(ctx) {
        const level = ctx.player?.getSkillManager?.().getCurrentLevel?.(skill) ?? 0;
        return level >= min && level <= max;
      },
    };
  }
  if (spec.hasItem) {
    const ids = (Array.isArray(spec.hasItem.id) ? spec.hasItem.id : [spec.hasItem.id])
      .map(resolveItemId)
      .filter((id) => Number.isInteger(id));
    const min = Number(spec.hasItem.min ?? 1);
    return {
      id: `item:${spec.hasItem.id}`,
      resolverKey: spec.resolver ?? `item:${spec.hasItem.id}`,
      check(ctx) {
        const inventory = ctx.player?.getInventory?.();
        if (!inventory) {
          return false;
        }
        return ids.some((id) => inventory.getAmount(id) >= min);
      },
    };
  }
  if (spec.inArea) {
    const area = spec.inArea;
    return {
      id: `area:${area.minX},${area.minY}`,
      resolverKey: spec.resolver ?? "area",
      check(ctx) {
        const loc = ctx.player?.getLocation?.();
        if (!loc) {
          return false;
        }
        return (
          loc.getX() >= area.minX &&
          loc.getX() <= area.maxX &&
          loc.getY() >= area.minY &&
          loc.getY() <= area.maxY &&
          loc.getZ() === (area.z ?? loc.getZ())
        );
      },
    };
  }
  throw new Error(`[bot activities] unknown condition ${JSON.stringify(spec)}`);
}

function createAction(spec, world) {
  const extended = EXTENDED_ACTION_TYPES.get(spec.type);
  if (extended) {
    return extended(spec, world);
  }
  if (spec.type === "interactObject") {
    return createInteractObjectAction(spec, world);
  }
  if (spec.type === "dropItems") {
    return createDropItemsAction({
      ...spec,
      itemIds: (spec.itemIds ?? []).map(resolveItemId).filter((id) => Number.isInteger(id)),
    });
  }
  if (spec.type === "equipTool") {
    return createEquipToolAction(spec);
  }
  if (spec.type === "bank") {
    return createBankAction(
      {
        ...spec,
        withdraw: (spec.withdraw ?? [])
          .map((entry) => ({
            item: resolveItemId(entry.item),
            amount: Math.max(1, Math.floor(Number(entry.amount ?? 1))),
          }))
          .filter((entry) => Number.isInteger(entry.item)),
      },
      world
    );
  }
  if (spec.type === "walkTo") {
    return createWalkToAction(spec);
  }
  if (spec.type === "ensureItem") {
    return createEnsureItemAction({
      ...spec,
      item: resolveItemId(spec.item),
    });
  }
  if (spec.type === "lightFire") {
    return createLightFireAction(spec, world);
  }
  if (spec.type === "smelt") {
    return createSmeltAction(spec, world);
  }
  if (spec.type === "pvpCombat") {
    return createPvpCombatAction(spec, world?.pvpController ?? null);
  }
  if (spec.type === "wander") {
    return createWanderAction(spec, world);
  }
  if (spec.type === "followOwner") {
    return createFollowOwnerAction(spec, world);
  }
  throw new Error(`[bot activities] unknown action type '${spec.type}'`);
}

function compileActivity(definition, templates, world, options = {}) {
  const template = definition.template ? templates[definition.template] : null;
  if (definition.template && !template) {
    throw new Error(`[bot activities] unknown template '${definition.template}'`);
  }
  const merged = applyFields(
    template ? { ...template, ...definition } : definition,
    definition.fields ?? {}
  );
  return {
    id: merged.id,
    resolver: options.resolver === true,
    resolves: options.resolver === true ? merged.resolves ?? null : null,
    mode: merged.mode ?? null,
    capacity: Number.isFinite(merged.capacity) ? Math.max(1, Math.floor(merged.capacity)) : 1,
    repeat: merged.repeat === true,
    ephemeral: merged.ephemeral === true,
    manual: merged.manual === true,
    failureCooldownMs: Math.max(
      0,
      Math.floor(Number(merged.failureCooldownSeconds ?? 15)) * 1000
    ),
    requires: (merged.requires ?? []).map(createCondition),
    setup: (merged.setup ?? []).map(createCondition),
    actions: (merged.actions ?? []).map((action) => createAction(action, world)),
    produces: merged.produces ?? [],
    site: merged.site ?? null,
  };
}

/**
 * Loads data-driven activities, their resolver links and sites. Capacity slots
 * cap how many bots may run an activity at once; assignment happens only when a
 * brain goes idle, never per tick.
 */
function createBotActivityRegistry(options = {}) {
  const api = options.api ?? null;
  const world = options.world ?? {};
  const definitionsPath = options.definitionsPath ?? DEFAULT_DEFINITIONS_PATH;
  const raw = JSON.parse(fs.readFileSync(definitionsPath, "utf8"));
  if (!raw || typeof raw !== "object") {
    throw new Error("[bot activities] definitions must be an object");
  }
  const templates = raw.templates ?? {};
  const activities = [];
  const resolvers = [];
  const byId = new Map();
  for (const definition of raw.activities ?? []) {
    if (!definition?.id || byId.has(definition.id)) {
      throw new Error("[bot activities] activity ids must be unique");
    }
    const activity = compileActivity(definition, templates, world);
    activities.push(activity);
    byId.set(activity.id, activity);
  }
  for (const definition of raw.resolvers ?? []) {
    if (!definition?.id || byId.has(definition.id)) {
      throw new Error("[bot activities] resolver ids must be unique");
    }
    const resolver = compileActivity(definition, templates, world, { resolver: true });
    if (!resolver.resolves) {
      throw new Error(`[bot activities] resolver '${resolver.id}' needs a resolves key`);
    }
    resolvers.push(resolver);
    byId.set(resolver.id, resolver);
  }
  const sites = (raw.sites ?? []).map((site) => {
    const activity = byId.get(site.activity);
    if (!activity) {
      throw new Error(`[bot activities] site '${site.id}' references unknown activity '${site.activity}'`);
    }
    return { ...site, activity };
  });
  const slots = new Map();
  const lastActivityByPlayer = new WeakMap();
  const blockedUntilByPlayer = new WeakMap();
  // Optional scored-activity picker (the citizens plugin sets one): consulted
  // before the default sticky-random choice. Must return a candidate from the
  // given list, or null to fall back. A throwing picker never breaks the brain.
  let activityPicker = null;

  function isBlocked(player, activityId, nowMs) {
    const until = blockedUntilByPlayer.get(player)?.get(activityId);
    return until !== undefined && until > nowMs;
  }

  function available(player, nowMs) {
    return activities.filter(
      (activity) =>
        activity.manual !== true &&
        (slots.get(activity.id) ?? 0) < activity.capacity &&
        !isBlocked(player, activity.id, nowMs) &&
        activity.requires.every((condition) => condition.check({ player }))
    );
  }

  const registryApi = {
    activities,
    resolvers,
    byId,
    sites,
    hasRoom(activityId) {
      const activity = byId.get(activityId);
      return (
        !!activity && (slots.get(activity.id) ?? 0) < activity.capacity
      );
    },
    /**
     * Installs the scored-activity picker (see pickActivity). Pass null to
     * restore the default sticky-random choice.
     */
    setActivityPicker(fn) {
      activityPicker = typeof fn === "function" ? fn : null;
    },
    /** The current candidate list for a player (requires/capacity/blocked). */
    listAvailable(player, nowMs = Date.now()) {
      return available(player, nowMs);
    },
    occupy(activity) {
      slots.set(activity.id, (slots.get(activity.id) ?? 0) + 1);
    },
    release(activity) {
      const next = Math.max(0, (slots.get(activity.id) ?? 0) - 1);
      slots.set(activity.id, next);
    },
    blockActivity(player, activityId, nowMs = Date.now(), durationMs = 15000) {
      let blocked = blockedUntilByPlayer.get(player);
      if (!blocked) {
        blocked = new Map();
        blockedUntilByPlayer.set(player, blocked);
      }
      blocked.set(activityId, nowMs + Math.max(0, durationMs));
    },
    pickActivity(player, nowMs = Date.now()) {
      const previousId = lastActivityByPlayer.get(player);
      const candidates = available(player, nowMs);
      if (activityPicker) {
        let picked = null;
        try {
          picked = activityPicker(player, candidates, nowMs) ?? null;
        } catch (error) {
          world?.log?.("bot_activity_picker_failed", {
            error: String(error?.message ?? error),
          });
        }
        if (picked && candidates.includes(picked)) {
          lastActivityByPlayer.set(player, picked.id);
          return picked;
        }
      }
      const previous = candidates.find((activity) => activity.id === previousId);
      const picked = previous ?? candidates[Math.floor(Math.random() * candidates.length)] ?? null;
      if (picked) {
        lastActivityByPlayer.set(player, picked.id);
      }
      return picked;
    },
    resolversFor(condition) {
      const key = condition?.resolverKey;
      if (!key) {
        return [];
      }
      return resolvers.filter((resolver) => resolver.resolves === key);
    },
    getSite(siteId) {
      return sites.find((site) => site.id === siteId) ?? null;
    },
    // The brain world this registry's actions were compiled against (ditch
    // config, objectSearch, pvpController...). Extension plugins that append
    // activities need it for attachBrain and director wiring.
    world,
  };
  TRACKED_REGISTRIES.push(registryApi);
  return registryApi;
}

/**
 * Compiles a raw definitions object ({ templates?, activities?, resolvers? })
 * and appends it to a live registry. Id collisions throw, like the boot load.
 * Lets extension plugins (citizens) add activities without touching the base
 * definitions file. `world` defaults to the registry's own brain world.
 */
function appendActivityDefinitions(registry, raw, worldOverride = null) {
  if (!registry || typeof registry !== "object" || !(registry.byId instanceof Map)) {
    throw new Error("[bot activities] appendActivityDefinitions needs a registry");
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("[bot activities] definitions must be an object");
  }
  const world = worldOverride ?? registry.world ?? {};
  const templates = raw.templates ?? {};
  const added = [];
  for (const definition of raw.activities ?? []) {
    if (!definition?.id || registry.byId.has(definition.id)) {
      throw new Error(`[bot activities] activity id '${definition?.id}' is not unique`);
    }
    const activity = compileActivity(definition, templates, world);
    registry.activities.push(activity);
    registry.byId.set(activity.id, activity);
    added.push(activity.id);
  }
  for (const definition of raw.resolvers ?? []) {
    if (!definition?.id || registry.byId.has(definition.id)) {
      throw new Error(`[bot activities] resolver id '${definition?.id}' is not unique`);
    }
    const resolver = compileActivity(definition, templates, world, { resolver: true });
    if (!resolver.resolves) {
      throw new Error(`[bot activities] resolver '${resolver.id}' needs a resolves key`);
    }
    registry.resolvers.push(resolver);
    registry.byId.set(resolver.id, resolver);
    added.push(resolver.id);
  }
  return added;
}

module.exports = {
  createBotActivityRegistry,
  appendActivityDefinitions,
  registerBotActionType,
  registerBotConditionKind,
  getBotActivityRegistries,
};
