const core = require('./Core.Farming');

// OSRS Wiki: Redwood tree (Farming). Farmed spots retain pre-Forestry depletion.
const REGROW_TICKS = 200;
const DEPLETION_ROLL = 11;
const BRANCH_COUNT = 4;
// Cache revision 241, region 4922: the four Cut multilocs on the first floor.
const BRANCHES = [
    { name: 'farming_redwood_tree_patch_1_2', dx: -2, dy: 2 },
    { name: 'farming_redwood_tree_patch_1_4', dx: -2, dy: 0 },
    { name: 'farming_redwood_tree_patch_1_6', dx: 2, dy: 0 },
    { name: 'farming_redwood_tree_patch_1_8', dx: 0, dy: -2 },
];

function branchIndex(patch, object) {
    const pos = object.getLocation();
    return BRANCHES.findIndex(branch => pos.getZ() === patch.z + 1
        && pos.getX() === patch.x + branch.dx && pos.getY() === patch.y + branch.dy
        && object.getId() === core.CacheDefinitions.getLocId(branch.name));
}
function advance(state, now) {
    // Old saves cannot identify which spot depleted. Preserve their remaining delay once.
    if (state.stump) {
        state.redwoodBranches = Array(BRANCH_COUNT).fill(state.nextAt > now ? state.nextAt : 0);
        delete state.stump;
    }
    if (state.redwoodBranches) {
        state.redwoodBranches = Array.from({ length: BRANCH_COUNT }, (_, i) => {
            const at = state.redwoodBranches[i];
            return Number.isFinite(at) && at > now ? at : 0;
        });
    }
}
function nextDue(state) {
    return Math.min(...(state.redwoodBranches ?? []).filter(at => Number.isFinite(at) && at > 0), Infinity);
}
function value(state) {
    const mask = (state.redwoodBranches ?? []).reduce((bits, at, i) => at > 0 ? bits | (1 << i) : bits, 0);
    // Cache transforms: 18 is healthy; 41..55 encode the four depleted-spot bits.
    return mask ? 40 + mask : 18;
}
function refresh(player, patch) {
    // The farmed redwood spans nine ground locs and nine first-floor locs. Its shared
    // varbit changes Cut actions upstairs too; rebuilding just the ground anchor is insufficient.
    for (const floor of [0, 1]) {
        for (const dx of [-3 + floor, 0, 2]) {
            for (const dy of [2, 0, -3 + floor]) {
                const pos = new core.Location(patch.x + dx, patch.y + dy, patch.z + floor);
                const object = core.MapObjects.getType(pos, 10, player.getPrivateArea());
                if (!object || core.CacheDefinitions.getObject(object.getId()).transformVarbit !== patch.varbit) continue;
                player.getPacketSender().sendObjectRemoval(object);
                player.getPacketSender().sendObject(object);
            }
        }
    }
}

Object.assign(module.exports, { REGROW_TICKS, DEPLETION_ROLL, branchIndex, advance, nextDue, value, refresh });
