const Common = require("./Common.AdventurePaths");
const Data = require("./Data.AdventurePaths");
const Progress = require("./Progress.AdventurePaths");
function offers(player) {
    const s = Common.state(player),
        members = Common.core.WorldDefinition.isMembersWorld(),
        all = [];
    for (const task of Data.tasks()) {
        if (!s.completed.includes(task.id)) continue;
        if (!s.free.includes(task.id)) all.push({ key: task.id, field: "free", items: task.free });
        if (members && task.members.length && !s.members.includes(task.id))
            all.push({ key: task.id, field: "members", items: task.members });
    }
    for (const path of Data.paths())
        if (!s.paths.includes(path.id) && path.tasks.every((t) => s.completed.includes(t.id)))
            all.push({ key: path.id, field: "paths", items: path.reward });
    return all;
}
function plan(player, items, source = player.getInventory().getItems()) {
    const core = Common.core,
        copy = new core.Inventory(player);
    copy.getItems().splice(0, source.length, ...source.map((i) => i.clone()));
    for (const r of items) {
        if (!Number.isInteger(r.id) || !Number.isSafeInteger(r.amount) || r.amount <= 0)
            return null;
        const item = new core.Item(r.id, r.amount);
        if (copy.getAddableAmount(item) < r.amount) return null;
        copy.add(item, false);
    }
    return copy.getItems();
}
function grant(player, items) {
    const copy = plan(player, items);
    if (!copy) return false;
    player
        .getInventory()
        .getItems()
        .splice(0, copy.length, ...copy);
    player.getInventory().refreshItems();
    return true;
}
function claim(player, recovered = false) {
    const ctx = Common.current(player);
    if (!ctx || !Progress.active(player)) return false;
    Progress.update({ player });
    const pending = offers(player);
    let moved = recovered,
        blocked = false;
    for (const offer of pending) {
        if (!Common.current(player) || ctx.state !== Common.state(player)) break;
        if (!grant(player, offer.items)) {
            blocked = true;
            continue;
        }
        ctx.state[offer.field].push(offer.key);
        moved = true;
    }
    if (moved) {
        Common.save(player);
        Progress.sync(player);
    }
    player.sendMessage(
        blocked
            ? "You need more inventory space to claim your remaining rewards."
            : moved
              ? "You have received your earned Adventure Path rewards."
              : "You have no Adventure Path rewards to claim on this world.",
    );
    return moved;
}
module.exports = { offers, plan, grant, claim };
