const Common = require("./Common.AdventurePaths");
const Data = require("./Data.AdventurePaths");
function active(player) {
    return Common.eligible(player) && !Common.state(player).disabled;
}
function sync(player) {
    const C = Common.core.CacheDefinitions,
        out = player.getPacketSender(),
        enabled = active(player),
        s = enabled ? Common.state(player) : null;
    out.sendVarbit(
        C.getVarbitId("adventurepath_player_participating"),
        enabled ? 1 : Common.eligible(player) ? 2 : 0,
    );
    if (!s) return;
    for (const [id, value] of Object.entries(s.settings)) out.sendConfig(Number(id), value);
    const mask = (list) => list.reduce((n, id) => n | (1 << id), 0);
    out.sendConfig(C.getVarpId("adventurepath_1_task"), mask(s.completed));
    out.sendConfig(C.getVarpId("adventurepath_1_reward_f2p"), mask(s.free));
    out.sendConfig(C.getVarpId("adventurepath_1_reward_p2p"), mask(s.members));
    out.sendConfig(
        C.getVarpId("adventurepath_1_path_complete"),
        mask(
            Data.paths()
                .filter((p) => p.tasks.every((t) => s.completed.includes(t.id)))
                .map((p) => p.id),
        ),
    );
    out.sendConfig(C.getVarpId("adventurepath_path_reward_1_f2p"), mask(s.paths));
    out.sendConfig(C.getVarpId("adventurepath_kits_1"), mask(s.kits));
    for (const path of Data.paths()) {
        const next = path.tasks.find((t) => !s.completed.includes(t.id));
        out.sendVarbit(
            C.getVarbitId(
                "adventurepath_" + (path.id === 0 ? "combat" : "gatherer") + "_task_recommended",
            ),
            next ? next.index + 1 : 0,
        );
        out.sendVarbit(
            C.getVarbitId("adventurepath_" + (path.id === 0 ? "combat" : "gatherer")),
            path.tasks.filter((t) => s.completed.includes(t.id)).length,
        );
    }
}
function update({ player }) {
    if (!Common.eligible(player)) return sync(player);
    const s = Common.state(player);
    if (s.disabled) return sync(player);
    let changed = false;
    if (s.journal === undefined) {
        s.journal = true;
        changed = true;
    }
    // Keep enrollment when Tutorial Island is later disabled and its attributes are not registered.
    const experience = player.getAttribute("tutorial-island:experience");
    if (s.tutorialComplete !== true || (experience && s.experience !== experience)) {
        s.tutorialComplete = true;
        s.experience = experience ?? s.experience;
        changed = true;
    }
    for (const task of Data.tasks()) {
        const skill = Common.core.Skill.values().find((x) => x.getIndex() === task.skill);
        if (
            player.getSkillManager().getMaxLevel(skill) >= task.level &&
            !s.completed.includes(task.id)
        ) {
            s.completed.push(task.id);
            changed = true;
        }
    }
    sync(player);
    if (changed) Common.save(player);
}
function answer(request) {
    request.eligible = Common.eligible(request.player);
    request.active = active(request.player);
    request.tasks = Data.tasks();
    request.state = request.eligible ? Common.state(request.player) : null;
}
function attach(api) {
    Common.init(api);
    api.persistAttribute(Common.STATE_ATTRIBUTE);
    api.onPlayerLogin(update);
    api.onPlayerLevelUp(update);
    api.onCustomEvent("tutorial:completed", update);
    api.onCustomEvent("adventure-paths:state", answer);
}
module.exports = { attach, update, sync, active };
