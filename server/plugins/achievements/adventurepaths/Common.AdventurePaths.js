const STATE_ATTRIBUTE = "adventure-paths:state";
let api;
const sessions = new WeakMap();
function init(value) {
    api = value;
}
function state(player) {
    let s = player.getAttribute(STATE_ATTRIBUTE);
    if (!s) {
        s = {
            completed: [],
            free: [],
            members: [],
            paths: [],
            kits: [],
            vouchers: [],
            settings: {},
        };
        player.setAttribute(STATE_ATTRIBUTE, s);
    }
    return s;
}
function eligible(player) {
    const q = { player, mode: "none" };
    api.emitCustomEvent("ironman:mode", q);
    return (
        q.mode === "none" &&
        ["new", "returning"].includes(
            player.getAttribute("tutorial-island:experience") ??
                player.getAttribute(STATE_ATTRIBUTE)?.experience,
        ) &&
        (player.getAttribute("tutorial-island:progress") === 1000 ||
            player.getAttribute(STATE_ATTRIBUTE)?.tutorialComplete === true)
    );
}
function save(player) {
    api.emitCustomEvent("persistence:save", { player, reason: "adventure-paths" });
}
function near(player, npc) {
    return (
        npc &&
        (!npc.isOwnerOnly() || npc.getOwner() === player) &&
        npc.getPrivateArea() === player.getPrivateArea() &&
        player.getHitpoints() > 0 &&
        player.getStatus() === api.core.PlayerStatus.NONE &&
        !player.isNeedsPlacement() &&
        !player.isTeleportingReturn() &&
        !player.getForceMovement() &&
        player.getLocation().isWithinDistance(npc.getLocation(), 5)
    );
}
function current(player) {
    const x = sessions.get(player);
    return x && eligible(player) && x.state === state(player) && near(player, x.npc) ? x : null;
}
module.exports = {
    sessions,
    near,
    current,
    init,
    state,
    eligible,
    save,
    STATE_ATTRIBUTE,
    get api() {
        return api;
    },
    get core() {
        return api.core;
    },
};
