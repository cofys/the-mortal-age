/** The siege hall's scripted scenery belongs to each defender's instance. */
module.exports = function registerHall({ api, state, process, cleanup, scenery }) {
  const { PrivateArea, Boundary, Location, GameObject, ObjectManager } = api.core;
  const sessions = new WeakMap();
  class SiegeHallArea extends PrivateArea {
    constructor(player) { super([new Boundary(3154, 3183, 7823, 7861, 1)]); this.player = player; }
    canAttack() { return false; }
    process(member) { if (member === this.player) process({ player: member }); }
    postLeave(member, logout) {
      if (member === this.player) { sessions.delete(member); cleanup({ player: member }); }
      super.postLeave(member, logout);
    }
  }
  function enter(player) {
    if (!['hall', 'breach'].includes(state(player).phase)) return false;
    if (sessions.has(player)) return true;
    const area = new SiegeHallArea(player); sessions.set(player, area); area.enter(player);
    for (const [id, x, y, type = 10, face = 0] of scenery(player)) {
      ObjectManager.register(new GameObject(id, new Location(x, y, 1), type, face, area), true);
    }
    return true;
  }
  return { enter, sessions, SiegeHallArea };
};
