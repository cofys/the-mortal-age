// Run after `yarn build`: node --test tests/object-reach.test.cjs
// Reference: OpenRune ReachStrategy, ProtectedAccess.arriveDelay and LadderScript.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { RsmodRouteFinding } = require('../dist/game/model/movement/path/RsmodRouteFinding');
const { PathFinder } = require('../dist/game/model/movement/path/PathFinder');
const { MovementQueue } = require('../dist/game/model/movement/MovementQueue');
const { ObjectDefinition } = require('../dist/game/definition/ObjectDefinition');
const { GameObject } = require('../dist/game/entity/impl/object/GameObject');
const { Location } = require('../dist/game/model/Location');
const { TaskManager } = require('../dist/game/task/TaskManager');
const { World } = require('../dist/game/World');
const { ItemOnGroundManager } = require('../dist/game/entity/impl/grounditem/ItemOnGroundManager');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Sounds } = require('../dist/game/Sounds');

const target = { level: 0, destX: 100, destY: 100, srcSize: 1, privateArea: null };

test('wall-door crossings align both coordinates for every face and angled approach', () => {
  const { crossingFor } = require('../plugins/objects/WallDoor.Doors');
  for (let face = 0; face < 4; face++) {
    const door = new GameObject(30112, new Location(100, 100, 0), 0, face, null);
    const [dx, dy] = [[-1,0],[0,1],[1,0],[0,-1]][face];
    const tile = {x:100,y:100,z:0},neighbour={x:100+dx,y:100+dy,z:0};
    for (const side of [-1,1]) for (const offset of [-5,-1,0,1,5]) {
      const source = {x:100+dx*side*4+dy*offset,y:100+dy*side*4+dx*offset,z:0};
      const crossing = crossingFor(door, source);
      assert.deepEqual(crossing.approach, side>0?neighbour:tile);
      assert.deepEqual(crossing.destination, side>0?tile:neighbour);
      assert.equal(Math.abs(crossing.approach.x-crossing.destination.x)+Math.abs(crossing.approach.y-crossing.destination.y),1);
    }
    assert.deepEqual(crossingFor(door,tile),{approach:tile,destination:neighbour});
  }
  assert.equal(crossingFor(new GameObject(30112,new Location(100,100,0),2,0,null),target),null,'corner walls need their own route');
});

test('object reach respects cardinal sides, walls, rotated footprints and access masks', () => {
  let wall = 0;
  const route = new RsmodRouteFinding(() => wall);
  const reached = (x, y, options = {}) => route.reachedAbsolute({ ...target, locShape: 10, srcX: x, srcY: y, ...options });
  assert.equal(reached(99, 99), false, 'diagonals cannot operate a loc');
  assert.equal(reached(98, 100), false);
  for (const [x, y, flag] of [[99, 100, 8], [101, 100, 128], [100, 99, 2], [100, 101, 32]]) {
    wall = 0;
    assert.equal(reached(x, y), true);
    wall = flag;
    assert.equal(reached(x, y), false, 'a wall blocks the shared edge');
  }
  wall = 0;
  // Cache ladder 132 has clipMask=27: only the south side is accessible at angle 0.
  for (let angle = 0; angle < 4; angle++) {
    const sides = [[100, 99], [99, 100], [100, 101], [101, 100]];
    for (let side = 0; side < sides.length; side++) {
      assert.equal(reached(...sides[side], { locAngle: angle, blockAccessFlags: 27 }), side === angle);
    }
  }
  assert.equal(reached(101, 102, { destWidth: 2, destLength: 3 }), true, 'inside the footprint');
  assert.equal(reached(103, 101, { destWidth: 2, destLength: 3, locAngle: 1 }), true);
  assert.equal(reached(103, 102, { destWidth: 2, destLength: 3, locAngle: 1 }), false);
  assert.equal(reached(100, 100, { locShape: -2 }), false, 'entity reach excludes overlap');
});

test('large actors can reach walls and decorations inside their footprint', () => {
  const route = new RsmodRouteFinding(() => 0x2401ff);
  for (let shape = 0; shape <= 9; shape++) {
    for (let angle = 0; angle < 4; angle++) {
      assert.equal(route.reachedAbsolute({ ...target, srcX: 99, srcY: 99, srcSize: 2, locShape: shape, locAngle: angle }), true);
    }
  }
});

test('wall approach masks reject door flanks in both reach checks and route searches', () => {
  const route = new RsmodRouteFinding(() => 0);
  for (let face = 0; face < 4; face++) {
    const [dx, dy] = [[-1, 0], [0, 1], [1, 0], [0, -1]][face];
    const door = { ...target, locShape: 0, locAngle: face, blockAccessFlags: 0x5 };
    const valid = [[100, 100], [100 + dx, 100 + dy]];
    for (let x = 98; x <= 102; x++) for (let y = 98; y <= 102; y++) {
      const options = { ...door, srcX: x, srcY: y };
      assert.equal(route.reachedAbsolute(options), valid.some(([vx, vy]) => x === vx && y === vy));
      const path = route.findRoute(options);
      assert.equal(path.alternative, false);
      assert.ok(valid.some(([vx, vy]) => path.endX === vx && path.endY === vy), `face ${face}: ${x},${y}`);
    }
    // An unmarked wall ladder keeps the ordinary wall reach strategy.
    assert.equal(route.reachedAbsolute({ ...door, srcX: 100 + dy, srcY: 100 + dx, blockAccessFlags: 0 }), true);
    for (const [x, y] of [[98, 98], [98, 100], [100, 98], [101, 101]]) {
      const options = { ...door, srcX: x, srcY: y, srcSize: 2 };
      assert.equal(route.reachedAbsolute(options), valid.some(([vx, vy]) =>
        vx >= x && vx < x + 2 && vy >= y && vy < y + 2));
    }
  }

  const blocked = new RsmodRouteFinding((x, y) => x === 100 && y === 100 ? 0x100 : 0);
  const otherSide = blocked.findRoute({ ...target, locShape: 0, locAngle: 2, blockAccessFlags: 0x5,
    srcX: 100, srcY: 99 });
  assert.deepEqual([otherSide.endX, otherSide.endY], [101, 100], 'use the other reachable face when one tile is blocked');
  const sealed = new RsmodRouteFinding((x, y) => y === 100 && (x === 100 || x === 101) ? 0x100 : 0);
  const near = sealed.findRoute({ ...target, locShape: 0, locAngle: 2, blockAccessFlags: 0x5,
    srcX: 100, srcY: 99 });
  assert.equal(near.alternative, true);
  assert.equal(sealed.reachedAbsolute({ ...target, locShape: 0, locAngle: 2, blockAccessFlags: 0x5,
    srcX: near.endX, srcY: near.endY }), false, 'move-near cannot make a blocked doorway operable');
});

test('every walkToObject caller shares route masks and cannot operate a door from its flank', (t) => {
  const noop = () => {};
  let location = new Location(100, 99, 0);
  const player = {
    isPlayer: () => true, isNpc: () => false, isPlayerBot: () => true, getAsPlayer() { return this; },
    getIndex: () => 1, getUsername: () => 'door-reach', getSize: () => 1,
    getLocation: () => location, getPrivateArea: () => null, setPositionToFace: noop, setDirection: noop,
  };
  const queue = new MovementQueue(player);
  player.getMovementQueue = () => queue;
  queue.getMobility = () => ({ canMove: () => true });
  queue.checkDestination = () => true;
  queue.walkToReset = noop;
  const definition = { getName: () => 'Door' };
  t.mock.method(ObjectDefinition, 'forId', () => definition);
  const requests = [];
  let explicitDestination = null;
  t.mock.method(PluginManager, 'emitObjectRoute', (event) => {
    requests.push(event);
    event.blockAccessFlags = 0x5;
    event.destination = explicitDestination;
  });
  const previousRoute = PathFinder.rsmodRouteFinding;
  PathFinder.rsmodRouteFinding = new RsmodRouteFinding(() => 0);
  t.after(() => { PathFinder.rsmodRouteFinding = previousRoute; TaskManager.cancelTasks(1); });
  const door = new GameObject(1535, new Location(100, 100, 0), 0, 2, null);
  for (const clickType of [undefined, 0, 1, 2, 3, 4, 5]) {
    location = new Location(100, 99, 0);
    let operations = 0;
    queue.walkToObject(door, { execute: () => { operations++; } }, clickType);
    assert.ok(queue.points.length > 0, 'even an already adjacent caller must route to a door face');
    assert.equal(requests.at(-1).clickType, clickType ?? 0);
    assert.equal(requests.at(-1).definition, definition);
    // Losing the path beside the wall must repath, not fire the operation early.
    queue.reset();
    TaskManager.process();
    TaskManager.processWalkTo(1);
    assert.equal(operations, 0);
    assert.ok(queue.points.length > 0);
    location = new Location(100, 100, 0);
    queue.reset();
    TaskManager.process();
    TaskManager.processWalkTo(1);
    assert.equal(operations, 1);
  }
  assert.equal(requests.length, 7, 'one route hook per object interaction');

  explicitDestination = { x: 99, y: 98, z: 0 };
  let destination;
  queue.walkToTile = (tile, action) => { destination = tile; action(); };
  queue.walkToObject(door, { execute: noop });
  assert.deepEqual([destination.x, destination.y, destination.z], [99, 98, 0], 'explicit quest routes retain priority');
});

test('ground-item routes can stop on a reachable tile beside a blocked item tile', (t) => {
  const options = [];
  const checkpoints = [];
  const queue = {
    reset() { return this; },
    setRoute() { return this; },
    setPathX() { return this; },
    setPathY() { return this; },
    syncDestinationFlagToRoute() {},
    addCheckpoint(location) { checkpoints.push(location); },
  };
  const player = {
    isPlayer: () => false,
    getLocation: () => new Location(2598, 7842, 0),
    getSize: () => 1,
    getPrivateArea: () => null,
    getMovementQueue: () => queue,
  };
  const oldRoute = PathFinder.rsmodRouteFinding;
  PathFinder.rsmodRouteFinding = {
    findRoute(request) {
      options.push(request);
      return request.moveNear
        ? { success: true, alternative: false, endX: 2602, endY: 7848, waypoints: [{ x: 2602, y: 7848, z: 0 }] }
        : { success: false, alternative: false, waypoints: [] };
    },
  };
  t.after(() => { PathFinder.rsmodRouteFinding = oldRoute; });

  assert.equal(PathFinder.calculateGroundItemRoute(player, new Location(2603, 7847, 0)), 1);
  assert.equal(options[0].moveNear, true);
  assert.equal(options[0].locShape, -1);
  assert.deepEqual(checkpoints.map(({ x, y, z }) => [x, y, z]), [[2602, 7848, 0]]);
});

test('ground-item pickup accepts only a collision-reachable adjacent tile on the same plane', (t) => {
  const oldRoute = PathFinder.rsmodRouteFinding;
  const oldItems = World.getItems;
  const oldPickup = PluginManager.emitGroundItemPickup;
  const oldDeregister = ItemOnGroundManager.deregister;
  const oldSound = Sounds.sendSound;
  let location = new Location(99, 100, 0);
  let inventoryAdds = 0;
  let resets = 0;
  let removed = 0;
  const groundItem = {
    getItem: () => ({ getId: () => 33788, getAmount: () => 1 }),
    getPosition: () => new Location(100, 100, 0),
    getPrivateArea: () => null,
    isPendingRemoval: () => false,
  };
  const player = {
    getLocation: () => location,
    getSize: () => 1,
    getPrivateArea: () => null,
    getMovementQueue: () => ({ reset: () => { resets++; } }),
    getInventory: () => ({
      getFreeSlots: () => 1,
      getAmount: () => 0,
      addItem: () => { inventoryAdds++; },
    }),
    getLastItemPickup: () => ({ reset() {} }),
  };
  World.getItems = () => [groundItem];
  PluginManager.emitGroundItemPickup = () => false;
  ItemOnGroundManager.deregister = () => { removed++; };
  Sounds.sendSound = () => {};
  let wallMask = 0;
  PathFinder.rsmodRouteFinding = new RsmodRouteFinding((x, y) =>
    x === 100 && y === 100 ? 0x100 : x === 99 && y === 100 ? wallMask : 0);
  t.after(() => {
    PathFinder.rsmodRouteFinding = oldRoute;
    World.getItems = oldItems;
    PluginManager.emitGroundItemPickup = oldPickup;
    ItemOnGroundManager.deregister = oldDeregister;
    Sounds.sendSound = oldSound;
  });

  // The item occupies a blocked tile, but the player can still take it from a
  // reachable side of the tile.
  ItemOnGroundManager.pickup(player, groundItem);
  assert.equal(inventoryAdds, 1);
  assert.equal(removed, 1);

  // A wall between the player and item makes that same adjacent-looking tile
  // unreachable; move-near pathing must not turn it into a pickup.
  wallMask = 8;
  ItemOnGroundManager.pickup(player, groundItem);
  assert.equal(inventoryAdds, 1);

  wallMask = 0;
  location = new Location(99, 100, 1);
  ItemOnGroundManager.pickup(player, groundItem);
  assert.equal(inventoryAdds, 1, 'a ground item on another plane cannot be picked up');

  location = new Location(95, 100, 0);
  ItemOnGroundManager.pickup(player, groundItem);
  assert.equal(inventoryAdds, 1, 'a distant item is not within pickup reach');
  assert.equal(resets, 3, 'all rejected attempts clear their stale movement action');
});

test('ladder click waits for arrival before animating and changes plane one tick later', (t) => {
  const events = [];
  let location = new Location(100, 97, 0);
  let forceMovement = null;
  const noop = () => {};
  const player = {
    isPlayer: () => true, isNpc: () => false, isPlayerBot: () => true, getAsPlayer() { return this; },
    getIndex: () => 1, getUsername: () => 'tester', getSize: () => 1,
    getLocation: () => location, setLocation: (value) => { location = value; },
    getPrivateArea: () => null, getHitpoints: () => 10, isNeedsPlacement: () => false,
    getForceMovement: () => forceMovement,
    getTimers: () => ({ has: () => false }), getFollowing: () => null,
    getDueling: () => ({ getButtonDelay: () => ({ finished: () => true }), inDuel: () => false }),
    getTrading: () => ({ getButtonDelay: () => ({ finished: () => true }) }),
    getCombat: () => ({ setCastSpell: noop, reset: noop }),
    getSkillManager: () => ({ stopSkillable: noop }),
    setFollowing: noop, setCombatFollowing: noop, setPositionToFace: noop,
    setDirection: noop, setWalkingDirection: noop, setRunningDirection: noop,
    isRunningReturn: () => false, sendMessage: noop,
    performAnimation: (animation) => events.push(['anim', World.getProcessCycle(), animation.getId()]),
    moveTo: (destination) => { queue.reset(); location = destination.clone(); events.push(['tele', World.getProcessCycle()]); },
  };
  const queue = new MovementQueue(player);
  player.getMovementQueue = () => queue;
  queue.handleRegionChange = noop;
  queue.syncWildernessStateForMovedPlayer = noop;
  queue.drainRunEnergy = noop;
  queue.canWalkTo = (next) => !(next.x === 100 && next.y === 100);
  const route = new RsmodRouteFinding((x, y) => x === 100 && y === 100 ? 0x100 : 0);
  const oldRoute = PathFinder.rsmodRouteFinding;
  const oldCycle = World.processCycle;
  PathFinder.rsmodRouteFinding = route;
  t.after(() => { PathFinder.rsmodRouteFinding = oldRoute; World.processCycle = oldCycle; TaskManager.cancelTasks(player); TaskManager.cancelTasks(1); });
  // Match the cache's directional ladder without booting a world or loading map regions.
  t.mock.method(ObjectDefinition, 'forId', () => ({ getSizeX: () => 1, getSizeY: () => 1, getBlockingMask: () => 27 }));
  const handlers = new Map();
  require('../plugins/objects/Ladders.plugin').register({
    getTaskManager: () => TaskManager,
    onCustomEvent: (name, handler) => handlers.set(name, handler),
    onObjectInteraction: noop,
  });
  const climb = () => handlers.get('ladders:climbUp')({ player, destination: new Location(location.x, location.y, 1) });
  const tick = () => {
    World.processCycle++;
    TaskManager.process();
    queue.beginCycle();
    if (queue.hasPendingWork()) queue.process();
    TaskManager.processWalkTo(1);
  };
  World.processCycle = 100;
  queue.walkToObject(new GameObject(132, new Location(100, 100, 0), 10, 0, null), { execute: climb });
  tick();
  assert.equal(location.y, 98);
  tick();
  assert.equal(location.y, 99);
  assert.deepEqual(events, [], 'no operation on the movement cycle');
  tick();
  assert.deepEqual(events, [], 'arriveDelay leaves another cycle for the final client step');
  assert.equal(queue.isMovementBlocked(), true);
  tick();
  assert.deepEqual(events, [['anim', 104, 828]]);
  tick();
  assert.equal(location.z, 1);
  assert.equal(location.y, 99, 'translate the arrival tile, not the blocked ladder tile');
  assert.deepEqual(events.at(-1), ['tele', 105]);
  assert.equal(queue.isMovementBlocked(), false);

  events.length = 0;
  location = new Location(100, 99, 0);
  queue.walkToObject(new GameObject(132, new Location(100, 100, 0), 10, 0, null), { execute: climb });
  assert.deepEqual(events, [], 'an adjacent click must still run from the player turn');
  tick();
  assert.deepEqual(events, [['anim', 106, 828]], 'a stationary player needs no arriveDelay');
  tick();
  assert.equal(location.z, 1);

  events.length = 0;
  location = new Location(100, 99, 0);
  climb();
  assert.equal(queue.isMovementBlocked(), true);
  location = new Location(200, 200, 0);
  tick();
  assert.equal(location.x, 200, 'an intervening teleport cancels the climb');
  assert.equal(queue.isMovementBlocked(), false);
  assert.equal(events.some(([event]) => event === 'tele'), false);

  // Every forced movement (ditch jumps, knockback, etc.) owns movement until
  // completion. A walk click must not queue a competing route from its start.
  forceMovement = {};
  assert.equal(queue.getMobility().canMove(), false);
  queue.requestWalk(new Location(200, 201, 0));
  assert.equal(queue.hasPendingWork(), false);
  forceMovement = null;
  assert.equal(queue.getMobility().canMove(), true);
});

test('an inventory item action cancels the queued object op but keeps the walk', (t) => {
  const events = [];
  let location = new Location(100, 97, 0);
  const noop = () => {};
  const combat = { clearInteraction: () => events.push('clear-interaction'), setCastSpell: noop, reset: noop };
  const player = {
    isPlayer: () => true, isNpc: () => false, isPlayerBot: () => true, getAsPlayer() { return this; },
    getIndex: () => 1, getUsername: () => 'tester', getSize: () => 1,
    getLocation: () => location, setLocation: (value) => { location = value; },
    getPrivateArea: () => null, getHitpoints: () => 10, isNeedsPlacement: () => false,
    getForceMovement: () => null,
    getTimers: () => ({ has: () => false }), getFollowing: () => null,
    getDueling: () => ({ getButtonDelay: () => ({ finished: () => true }), inDuel: () => false }),
    getTrading: () => ({ getButtonDelay: () => ({ finished: () => true }) }),
    getCombat: () => combat,
    getSkillManager: () => ({ stopSkillable: noop }),
    setFollowing: noop, setCombatFollowing: noop, setPositionToFace: noop,
    setDirection: noop, setWalkingDirection: noop, setRunningDirection: noop,
    isRunningReturn: () => false, sendMessage: noop, performAnimation: noop,
    moveTo: (destination) => { queue.reset(); location = destination.clone(); },
  };
  const queue = new MovementQueue(player);
  player.getMovementQueue = () => queue;
  queue.handleRegionChange = noop;
  queue.syncWildernessStateForMovedPlayer = noop;
  queue.drainRunEnergy = noop;
  queue.canWalkTo = (next) => !(next.x === 100 && next.y === 100);
  const route = new RsmodRouteFinding((x, y) => x === 100 && y === 100 ? 0x100 : 0);
  const oldRoute = PathFinder.rsmodRouteFinding;
  const oldCycle = World.processCycle;
  PathFinder.rsmodRouteFinding = route;
  t.after(() => { PathFinder.rsmodRouteFinding = oldRoute; World.processCycle = oldCycle; TaskManager.cancelTasks(1); });
  t.mock.method(ObjectDefinition, 'forId', () => ({ getSizeX: () => 1, getSizeY: () => 1, getBlockingMask: () => 27 }));
  World.processCycle = 100;
  const tick = () => {
    World.processCycle++;
    TaskManager.process();
    queue.beginCycle();
    if (queue.hasPendingWork()) queue.process();
    TaskManager.processWalkTo(1);
  };

  queue.walkToObject(new GameObject(132, new Location(100, 100, 0), 10, 0, null), { execute: () => events.push('op') });
  tick();
  assert.equal(location.y, 98, 'the red click walks toward the object');

  // What an Eat/Drink click does before the plugin runs: clear the interaction, keep walking.
  require('../dist/game/entity/impl/player/Player').Player.prototype.clearPendingAction.call(player);
  assert.ok(events.includes('clear-interaction'), 'the item action cleared the combat interaction');
  assert.ok(queue.hasRoute() || queue.points.length > 0, 'the walk queue survives the item action');

  tick();
  tick();
  tick();
  assert.equal(location.y, 99, 'the player walks on to the clicked object');
  assert.equal(events.includes('op'), false, 'the queued object op never runs');
});
