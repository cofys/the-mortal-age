// Temple of the Eye production dispatch regression.
// From server/: node --test tests/temple-of-the-eye-named-dispatch.test.cjs (after yarn build).
//
// This does not call the plugin's variant helper directly. It registers the real
// plugin through PluginManager.createApi(), registers NpcDialogues on the same
// production dispatch path, and sends a Talk-to interaction for Felix as the
// third tower apprentice. The named handler must own the interaction; otherwise
// NpcDialogues selects the stage-80 repeat variant and Felix's card never opens.
const assert = require('node:assert/strict');
const path = require('node:path');
const { test, before } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { PluginManager } = require('../dist/plugins/PluginManager');
const { DialogueManager } = require('../dist/game/model/dialogues/DialogueManager');
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { NpcDefinitionLoader } = require('../dist/game/definition/loader/impl/NpcDefinitionLoader');
const core = PluginManager.getCoreApi();
const Runtime = require('../plugins/quests/QuestRuntime');

const N = core.NpcIdentifiers;
const I = core.ItemIdentifiers;
const TOWER_SEEN_ATTRIBUTE = 'quest.temple_of_the_eye.tower-apprentices';

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  new NpcDefinitionLoader().load();
});

function inventoryFixture() {
  const items = new Map();
  return {
    items,
    getAmount: id => items.get(id) ?? 0,
    isFull: () => false,
    getFreeSlots: () => 28 - items.size,
    contains: id => (items.get(id) ?? 0) > 0,
    adds(id, amount = 1) { items.set(id, (items.get(id) ?? 0) + amount); },
    deleteNumber(id, amount = 1) {
      const left = Math.max(0, (items.get(id) ?? 0) - amount);
      if (left === 0) items.delete(id); else items.set(id, left);
    },
  };
}

function playerFixture() {
  const attributes = new Map();
  const messages = [];
  const log = [];
  const inventory = inventoryFixture();
  let location = new core.Location(3111, 3163, 1);
  let packet;
  packet = new Proxy({
    sendConfig() { return packet; },
    sendVarbit() { return packet; },
    sendInterface(id) { log.push(['sendInterface', id]); return packet; },
    sendString(text, uid) { log.push(['sendString', uid, text]); return packet; },
    sendInterfaceRemoval() { player.getDialogueManager().reset(); return packet; },
  }, {
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => { log.push([String(key), ...args]); return packet; };
    },
  });
  const player = {
    inventory,
    messages,
    log,
    getUsername: () => 'tote-dispatch',
    getAttribute: key => attributes.get(key),
    setAttribute(key, value) { attributes.set(key, value); },
    getInventory: () => inventory,
    getEquipment: () => ({ get: () => null, getItems: () => [] }),
    getSkillManager: () => ({
      getCombatLevel: () => 99,
      getMaxLevel: () => 99,
      getCurrentLevel: () => 99,
      addExperiences() {},
      addExperience() {},
    }),
    getLocation: () => location,
    moveTo: to => { location = to; },
    getDialogueManager: () => player.manager,
    getPacketSender: () => packet,
    getAppearance: () => ({ isMale: () => true }),
    isRegistered: () => true,
    isPlayer: () => true,
    isNpc: () => false,
    getAsPlayer: () => player,
    getIndex: () => 1,
    getArea: () => null,
    getPrivateArea: () => null,
    sendMessage: message => messages.push(message),
    setPositionToFace() {},
    performAnimation() {},
  };
  player.manager = new DialogueManager(player);
  return player;
}

function npcEvent(player, name, npcId, action = 'Talk-to') {
  return {
    player,
    npc: {},
    npcId,
    definition: {
      getId: () => npcId,
      getName: () => name,
      getActions: () => [action, null, null, null, null],
    },
    clickType: 1,
    handled: false,
  };
}

function registerProductionPlugins() {
  const beforeLengths = {
    interaction: PluginManager.npcInteractionHooks.length,
    any: PluginManager.npcAnyInteractionHooks.length,
    variant: PluginManager.npcDialogueVariantHooks.length,
    condition: PluginManager.npcDialogueConditionHooks.length,
    itemAction: PluginManager.itemActionHooks.length,
    itemOnNpc: PluginManager.itemOnNpcHooks.length,
    itemOnObject: PluginManager.itemOnObjectHooks.length,
    objectInteraction: PluginManager.objectInteractionHooks.length,
    npcDeath: PluginManager.npcDeathHooks.length,
    login: PluginManager.loginHooks.length,
    logout: PluginManager.logoutHooks.length,
    interfaceAction: PluginManager.interfaceActionClickHooks.length,
  };
  const customBefore = new Map([...PluginManager.customEventHooks].map(([name, hooks]) => [name, hooks.length]));

  const templeApi = PluginManager.createApi('TempleOfTheEyeDispatchTest');
  const spawned = [];
  templeApi.spawnNpc = definition => {
    const npc = {
      definition,
      getId: () => definition.id,
      isRegistered: () => true,
      isVisible: () => true,
      isOwnerOnly: () => true,
      getOwner: () => definition.owner,
      getPrivateArea: () => null,
      getLocation: () => new core.Location(definition.x, definition.y, definition.z),
    };
    spawned.push(npc);
    return npc;
  };
  templeApi.removeNpc = () => {};
  require('../plugins/quests/quests/TempleOfTheEye.Quest')(templeApi);

  const dialogueApi = PluginManager.createApi('NpcDialoguesDispatchTest');
  require('../plugins/npcs/NpcDialogues.plugin.js').register(dialogueApi);

  const quest = Runtime.getRegisteredQuests().findLast(entry => entry.key === 'temple_of_the_eye');
  return {
    quest,
    spawned,
    cleanup() {
      PluginManager.npcInteractionHooks.length = beforeLengths.interaction;
      PluginManager.npcAnyInteractionHooks.length = beforeLengths.any;
      PluginManager.npcDialogueVariantHooks.length = beforeLengths.variant;
      PluginManager.npcDialogueConditionHooks.length = beforeLengths.condition;
      PluginManager.itemActionHooks.length = beforeLengths.itemAction;
      PluginManager.itemOnNpcHooks.length = beforeLengths.itemOnNpc;
      PluginManager.itemOnObjectHooks.length = beforeLengths.itemOnObject;
      PluginManager.objectInteractionHooks.length = beforeLengths.objectInteraction;
      PluginManager.npcDeathHooks.length = beforeLengths.npcDeath;
      PluginManager.loginHooks.length = beforeLengths.login;
      PluginManager.logoutHooks.length = beforeLengths.logout;
      PluginManager.interfaceActionClickHooks.length = beforeLengths.interfaceAction;
      for (const [name, hooks] of [...PluginManager.customEventHooks]) {
        const kept = hooks.filter(hook => hook.pluginName !== 'TempleOfTheEyeDispatchTest'
          && hook.pluginName !== 'NpcDialoguesDispatchTest');
        const oldLength = customBefore.get(name) ?? 0;
        if (kept.length > oldLength) kept.splice(oldLength);
        if (kept.length) PluginManager.customEventHooks.set(name, kept);
        else PluginManager.customEventHooks.delete(name);
      }
    },
  };
}

function advanceAll(player, limit = 200) {
  const lines = [];
  while (player.manager.getCurrent() && limit-- > 0) {
    const current = player.manager.getCurrent();
    lines.push(current.getText?.() ?? '');
    player.manager.advance();
    core.TaskManager.process();
  }
  assert.ok(limit > 0, 'dialogue did not finish');
  return lines;
}

test('Felix the third tower apprentice keeps his named conversation and opens his riddle card', () => {
  const { quest, cleanup } = registerProductionPlugins();
  try {
    assert.ok(quest, 'Temple of the Eye registered');
    const player = playerFixture();
    quest.setStage(player, 75);
    player.setAttribute(TOWER_SEEN_ATTRIBUTE, 5); // Cordelia (1) and Tamara (4) done.

    const event = npcEvent(player, 'Apprentice Felix', N.APPRENTICE_FELIX_2);
    const handled = PluginManager.emitNpcInteraction(event);

    assert.equal(handled, true, 'the named Talk-to owns the interaction');
    assert.equal(event.handled, true);
    assert.equal(quest.getStage(player), 80, 'Felix is the third riddle');
    assert.equal(player.getAttribute(TOWER_SEEN_ATTRIBUTE) & 7, 7);

    const first = player.manager.getCurrent();
    assert.ok(first, 'the named handler started a conversation');
    assert.match(first.getText(), /^So, if that's six and this is eight/);
    assert.doesNotMatch(first.getText(), /Could I see that puzzle again\?/);

    const lines = advanceAll(player);
    assert.ok(lines.includes("Okay, I'll show you the puzzle."),
      `Felix's first riddle transcript ran: ${JSON.stringify(lines)}`);
    assert.ok(!lines.includes('Could I see that puzzle again?'),
      'the generic fallback did not replace the first-time conversation');
    assert.ok(lines.some(line => line.length > 0), 'dialogue had lines');
    assert.ok(player.log.some(([name, id]) => name === 'sendInterface' && id === 291),
      'Felix riddle interface 291 opened');
  } finally {
    cleanup();
  }
});
