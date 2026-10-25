/** Postquest public access. The quest retains its own stage-gated routes. */
const Common = require('./Common.Whisperer');
const TELEPORTERS_ATTRIBUTE = 'whisperer:teleporters';
function complete(player) {
  const event = { player, key: Common.data.quest, complete: false };
  Common.api.emitCustomEvent('quest:is-complete', event);
  return event.complete === true;
}
function coordinates(event) {
  const p = event.location ?? event.object?.getLocation();
  return p ? [p.getX?.() ?? p.x, p.getY?.() ?? p.y, p.getZ?.() ?? p.z ?? 0] : [];
}
function sameTile([x, y, z], [tx, ty, tz]) {
  return x === tx && y === ty && z === tz;
}
function route(event) {
  const config = Common.data.travel, p = event.object?.getLocation();
  if (!p || event.clickType !== 1 || !config.ropeIds.includes(event.objectId))
    return;
  if (sameTile([p.getX(), p.getY(), p.getZ()], config.sinkhole) && complete(event.player)) {
    const [x, y, z] = Common.data.site.grave;
    event.destination = { x, y, z };
  }
}
function landing([x, y, z = 0]) {
  const { Location, RegionManager } = Common.core;
  for (const [dx, dy] of [[0, 0], [0, -1], [1, 0], [-1, 0], [0, 1]]) {
    const tile = new Location(x + dx, y + dy, z);
    if (!RegionManager.blocked(tile, null))
      return tile;
  }
  return null;
}
function choose(player, source, destinations, offset = 0) {
  const choices = destinations.slice(offset, offset + 4).flatMap(target => [target[0], () => {
      if (Common.sessionOf(player) || !complete(player) ||
        player.getLocation().getDistance(new Common.core.Location(source[1], source[2], 0)) > 3)
        return;
      player.getPacketSender().sendInterfaceRemoval();
      const at = landing([target[1], target[2], 0]);
      if (at)
        player.moveTo(at);
    }]);
  if (offset + 4 < destinations.length)
    choices.push('More...', () => choose(player, source, destinations, offset + 4));
  if (choices.length)
    Common.api.sendMultiChatboxPrompt(player, 'Choose an active Lassar teleporter', ...choices);
}
function travel(event) {
  const { player } = event, id = event.objectId ?? event.definition?.id, config = Common.data.travel;
  const teleporter = config.teleporters.some(t => t[3] === id) || config.teleporterForms.includes(id);
  if (!config.ropeIds.includes(id) && id !== config.returnRope && !teleporter)
    return false;
  if (Common.sessionOf(player) || !complete(player))
    return false;
  const tile = coordinates(event), [x, y, z] = tile, action = String(event.option ?? '').toLowerCase();
  if (z !== 0)
    return false;
  if (config.ropeIds.includes(id) && sameTile(tile, config.sinkhole) && ['climb-rope', 'climb-down', 'climb'].includes(action)) {
    const at = landing(config.undercity);
    if (at)
      player.moveTo(at);
  }
  else if (id === config.returnRope && Common.inBounds(config.returnBounds, new Common.core.Location(x, y, z)) && ['climb-up', 'climb', 'exit', 'leave'].includes(action)) {
    player.moveTo(Common.location(Common.data.site.grave));
  }
  else {
    const index = config.teleporters.findIndex(t => t[1] === x && t[2] === y && (t[3] === id || config.teleporterForms.includes(id)));
    if (index < 0 || !['activate', 'travel', 'use'].includes(action))
      return false;
    const saved = player.getAttribute(TELEPORTERS_ATTRIBUTE) ?? [];
    const active = config.teleporters.map((t, i) => saved.includes(i) || Number(player.getPacketSender().getVarbit(t[4])) > 0);
    if (!active[index]) {
      player.setAttribute(TELEPORTERS_ATTRIBUTE, [...new Set([...saved, index])]);
      player.getPacketSender().sendVarbit(config.teleporters[index][4], 1);
      Common.messageBox(player, 'You activate the teleporter.');
      Common.sound(player, Common.data.sounds.teleporter);
    }
    else if (action !== 'activate') {
      choose(player, config.teleporters[index], config.teleporters.filter((_, i) => active[i]));
    }
  }
  event.handled = true;
  return true;
}
function restore({ player }) {
  if (!complete(player))
    return;
  // Apply discoveries after DT2 synchronizes its own login varbits.
  Common.later(1, () => {
    if (!player.isRegistered())
      return;
    for (const index of player.getAttribute(TELEPORTERS_ATTRIBUTE) ?? []) {
      const target = Common.data.travel.teleporters[index];
      if (target)
        player.getPacketSender().sendVarbit(target[4], 1);
    }
  });
}
function attach(api) {
  api.persistAttribute(TELEPORTERS_ATTRIBUTE, []);
  api.onObjectRoute(route);
  api.onObjectInteraction('Rock', { 'Climb-rope': travel, 'Climb-down': travel, Climb: travel });
  api.onObjectInteraction('Rope', { 'Climb-up': travel, Climb: travel, Exit: travel, Leave: travel });
  api.onObjectInteraction('Teleporter', { Activate: travel, Travel: travel, Use: travel });
  api.onPlayerLogin(restore);
}
module.exports = { attach, travel, route, restore, TELEPORTERS_ATTRIBUTE };
