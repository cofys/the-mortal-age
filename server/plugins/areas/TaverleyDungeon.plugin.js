/** Shared Taverley Dungeon key doors and Velrak's canonical dusty-key hand-out. */
const DOORS = [
  { id: 'DOOR_99', key: 'JAIL_KEY', tile: [2931, 9690, 0], inside: [2931, 9689, 0], freeExit: true },
  { id: 'DOOR_99', key: 'JAIL_KEY', tile: [2931, 9694, 0], inside: [2931, 9695, 0], freeExit: true },
  { id: 'GATE_57', key: 'DUSTY_KEY', tile: [2924, 9803, 0], inside: [2923, 9803, 0], freeExit: false },
];
const VELRAK_PAGE = 'Velrak the explorer';
const DUSTY_KEY_RECEIPT = 'sM-0Hv';

function at(location, [x, y, z]) {
  return (location?.getX?.() ?? location?.x) === x
    && (location?.getY?.() ?? location?.y) === y
    && (location?.getZ?.() ?? location?.z) === z;
}

function doorAt(core, event) {
  const location = event.location ?? event.object?.getLocation?.();
  return DOORS.find(door => event.objectId === core.ObjectIdentifiers[door.id] && at(location, door.tile));
}

function checkDoorKey(core, event) {
  if (event.handled) return;
  const door = doorAt(core, event);
  if (!door) return;
  if (door.freeExit && at(event.player.getLocation(), door.inside)) return;
  if (event.player.getInventory().getAmount(core.ItemIdentifiers[door.key]) > 0) return;
  event.player.sendMessage('The door is locked.');
  event.handled = true;
}

function useKey(api, event) {
  const door = doorAt(api.core, event);
  if (!door || event.itemId !== api.core.ItemIdentifiers[door.key]) return;
  const request = { ...event, handled: false };
  api.emitCustomEvent('door:open', request);
  if (request.handled) event.handled = true;
}

function isVelrak(core, event) {
  return event.npcId === core.NpcIdentifiers.VELRAK_THE_EXPLORER
    && event.pages?.some(({ page }) => page === VELRAK_PAGE);
}

function answerVelrak(core, event) {
  if (!isVelrak(core, event)) return null;
  const held = event.player.getInventory().getAmount(core.ItemIdentifiers.DUSTY_KEY) > 0;
  if (event.text === 'Without having a dusty key in the inventory:') return !held;
  if (event.text === 'With a dusty key in the inventory:') return held;
  return null;
}

function giveDustyKey(core, event) {
  if (event.kind !== 'message' || event.stepId !== DUSTY_KEY_RECEIPT || !isVelrak(core, event)) return;
  event.handled = true;
  const inventory = event.player.getInventory();
  const key = core.ItemIdentifiers.DUSTY_KEY;
  const before = inventory.getAmount(key);
  if (before > 0) {
    event.end = true;
    return;
  }
  if (inventory.getFreeSlots() < 1) {
    inventory.full();
    event.end = true;
    return;
  }
  inventory.adds(key, 1);
  if (inventory.getAmount(key) !== before + 1) {
    event.end = true;
    return;
  }
  event.box = { items: [key] };
}

module.exports = {
  name: 'TaverleyDungeon',
  members: true,
  register(api) {
    api.onCustomEvent('door:toggle', checkDoorKey.bind(null, api.core));
    api.onItemOnObject(useKey.bind(null, api), { noted: false });
    api.onNpcDialogueCondition(answerVelrak.bind(null, api.core));
    api.onCustomEvent('npc-dialogue:action', giveDustyKey.bind(null, api.core));
  },
};
