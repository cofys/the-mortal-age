import { strict as assert } from "node:assert";
import { getXpForLevel, MAX_XP, SkillId } from "../rs/skill/skills";
import {
    UNKNOWN,
    XpPauseState,
    XpState,
    XpStateSingle,
    formatTimeTillGoal,
    panelLabelValue,
    progressBarLabelValue,
    quantityToRSDecimalStack,
} from "../game/plugins/xptracker/xpState";

// --- QuantityFormatter.quantityToRSDecimalStack(q, true): floor, K/M/B --------------------
assert.equal(quantityToRSDecimalStack(0), "0");
assert.equal(quantityToRSDecimalStack(9999), "9999");
assert.equal(quantityToRSDecimalStack(10_000), "10K");
assert.equal(quantityToRSDecimalStack(12_399), "12.3K");
assert.equal(quantityToRSDecimalStack(999_999), "999.9K");
assert.equal(quantityToRSDecimalStack(1_234_567), "1.234M");
assert.equal(quantityToRSDecimalStack(13_034_431), "13.034M");
assert.equal(quantityToRSDecimalStack(200_000_000), "200M");

// --- Time to goal: DAYS / HOURS / SHORT fall through as RuneLite's switch -------------------
assert.equal(formatTimeTillGoal(-1, "SHORT"), "∞");
assert.equal(formatTimeTillGoal(65, "DAYS"), "01:05");
assert.equal(formatTimeTillGoal(3 * 3600 + 61, "SHORT"), "3:01:01");
assert.equal(formatTimeTillGoal(3600 + 5, "HOURS"), "1 hour 00:05");
assert.equal(formatTimeTillGoal(5 * 3600 + 5, "DAYS"), "5 hours 00:05");
assert.equal(formatTimeTillGoal(86400 + 3661, "DAYS"), "1 day 01:01:01");
assert.equal(formatTimeTillGoal(3 * 86400, "DAYS"), "3 days 00:00:00");
assert.equal(formatTimeTillGoal(3 * 86400, "HOURS"), "72 hours 00:00");

// --- One skill: gains, actions, rates with the 60 second floor -----------------------------
const s = new XpStateSingle(1000);
s.updateGoals(1000, -1, -1);
assert.equal(s.startLevelExp, getXpForLevel(9), "start of the current level (1000 xp = level 9)");
assert.equal(s.endLevelExp, getXpForLevel(10));
assert.equal(s.update(1000, 0), false, "no change, no action");
assert.equal(s.actionsRemaining, UNKNOWN, "N/A before the first action");
assert.equal(s.secondsTillLevel, -1);
assert.equal(s.update(1025, 1), true);
assert.equal(s.xpGainedSinceReset, 25);
assert.equal(s.actions, 1);
s.tick(30_000);
assert.equal(s.xpPerHour, 25 * 60, "under a minute counts as a minute");
s.tick(90_000);
assert.equal(s.xpPerHour, Math.trunc((1 / (120 / 3600)) * 25));
assert.equal(s.actionsRemaining, Math.ceil((getXpForLevel(10) - 1025) / 25), "the last drops fill the history");
s.update(1050, 2);
s.update(1100, 3);
// history: 25 x8 (initial fill), then 25, 50 replaced indexes 1 and 2 → sum = 25*9 + 50 = 275
assert.equal(s.actionsRemaining, Math.ceil(((getXpForLevel(10) - 1100) * 10) / 275));
assert.equal(s.secondsTillLevel, Math.floor(((getXpForLevel(10) - 1100) * 120) / 100));

// Reset/hr keeps the session's gain, restarts the rate and the time to level.
s.resetPerHour(4);
assert.equal(s.totalXpGained, 100);
assert.equal(s.xpGainedSinceReset, 0);
assert.equal(s.skillTime, 0);
assert.equal(s.secondsTillLevel, -1);
s.tick(10_000);
assert.equal(s.skillTime, 0, "no time accrues without a gain since the reset");

// Goals: the XP-drop goal when set and not passed; 200M past the last virtual level.
const g = new XpStateSingle(5000);
g.updateGoals(5000, 4000, 9000);
assert.deepEqual([g.startLevelExp, g.endLevelExp], [4000, 9000]);
g.updateGoals(9500, 4000, 9000);
assert.deepEqual([g.startLevelExp, g.endLevelExp], [getXpForLevel(26), getXpForLevel(27)], "a passed goal falls back (9500 xp = level 26)");
const maxed = new XpStateSingle(MAX_XP - 10);
maxed.updateGoals(MAX_XP - 10, -1, -1);
assert.equal(maxed.endLevelExp, MAX_XP);
assert.equal(maxed.snapshot().endGoalXp, MAX_XP);

// --- Labels -----------------------------------------------------------------------------------
const snap = s.snapshot();
assert.equal(panelLabelValue("XP_GAINED", snap), "100");
assert.equal(panelLabelValue("TIME_TO_LEVEL", snap), "∞");
assert.equal(panelLabelValue("ACTIONS_DONE", snap), "3");
assert.equal(panelLabelValue("ACTIONS_LEFT", { ...snap, actionsRemainingToGoal: UNKNOWN }), "N/A");
assert.equal(progressBarLabelValue("PERCENTAGE", { ...snap, skillProgressToGoal: 12.3456 }), "12.34%");

// --- All skills: initialise, update, XP going down, overall, order --------------------------
const state = new XpState();
assert.equal(state.updateSkill(SkillId.Woodcutting, 500, -1, -1, 0, false), "INITIALIZED");
assert.equal(state.updateSkill(SkillId.Woodcutting, 500, -1, -1, 0, false), "NO_CHANGE");
assert.deepEqual(state.order, [], "a skill shows once it gains");
assert.equal(state.updateSkill(SkillId.Woodcutting, 525, -1, -1, 1, false), "UPDATED");
assert.equal(state.updateSkill(SkillId.Fishing, 10, -1, -1, 1, false), "INITIALIZED");
assert.equal(state.updateSkill(SkillId.Fishing, 20, -1, -1, 2, false), "UPDATED");
assert.deepEqual(state.order, [SkillId.Woodcutting, SkillId.Fishing]);
assert.equal(state.updateSkill(SkillId.Woodcutting, 550, -1, -1, 3, true), "UPDATED");
assert.deepEqual(state.order, [SkillId.Woodcutting, SkillId.Fishing]);
assert.equal(state.updateSkill(SkillId.Fishing, 30, -1, -1, 4, true), "UPDATED");
assert.deepEqual(state.order, [SkillId.Fishing, SkillId.Woodcutting], "recent first when prioritised");
assert.equal(state.updateSkill(SkillId.Fishing, 5, -1, -1, 5, false), "INITIALIZED", "XP went down: start over");
assert.equal(state.get(SkillId.Fishing)!.totalXpGained, 0);

state.initializeOverall(1000);
state.updateOverall(1100, 6);
assert.equal(state.overall.totalXpGained, 100);
state.updateOverall(900, 7);
assert.equal(state.overall.totalXpGained, 0, "a lower total starts the total over");

// Auto reset/hr after N idle minutes, repeating while idle.
const idle = new XpState();
idle.updateSkill(SkillId.Mining, 0, -1, -1, 0, false);
idle.updateSkill(SkillId.Mining, 50, -1, -1, 1000, false);
idle.tick(SkillId.Mining, 5000, 1000 + 4 * 60_000, 5);
assert.equal(idle.get(SkillId.Mining)!.xpGainedSinceReset, 50);
idle.tick(SkillId.Mining, 5000, 1000 + 5 * 60_000, 5);
assert.equal(idle.get(SkillId.Mining)!.xpGainedSinceReset, 0);
assert.equal(idle.get(SkillId.Mining)!.totalXpGained, 50);

// --- Save / restore: RuneLite's XpSave shape, only skills with gains, in order ------------
const saved = new XpState();
saved.initializeOverall(100);
saved.updateSkill(SkillId.Runecraft, 100, -1, -1, 0, false);
saved.updateSkill(SkillId.Runecraft, 160, -1, -1, 1, false);
saved.updateSkill(SkillId.Magic, 40, -1, -1, 1, false);
saved.get(SkillId.Runecraft)!.tick(70_000);
saved.compactView.add(SkillId.Runecraft);
const save = saved.save()!;
assert.deepEqual(Object.keys(save.skills), ["RUNECRAFT"], "Magic has no gain and isn't saved");
assert.deepEqual(save.skills.RUNECRAFT, { s: 100, br: 0, ar: 60, t: 70_000 });
assert.deepEqual(save.compactViewSkills, ["RUNECRAFT"]);
assert.equal(new XpState().save(), null, "nothing to save before the total tracks");
const restored = new XpState();
restored.restore(JSON.parse(JSON.stringify(save)));
assert.deepEqual(restored.order, [SkillId.Runecraft]);
assert.equal(restored.get(SkillId.Runecraft)!.totalXpGained, 60);
assert.equal(restored.get(SkillId.Runecraft)!.skillTime, 70_000);
assert.ok(restored.compactView.has(SkillId.Runecraft));
assert.ok(restored.isOverallInitialized());

// --- Pauses: manual, logout, timeout; any gain unpauses ------------------------------------
const pause = new XpPauseState();
pause.tickXp(SkillId.Attack, 100, 2, 0);
pause.pauseSkill(SkillId.Attack);
assert.ok(pause.isPaused(SkillId.Attack));
pause.tickXp(SkillId.Attack, 100, 2, 1000);
assert.ok(pause.isPaused(SkillId.Attack), "no gain: stays paused");
pause.tickXp(SkillId.Attack, 110, 2, 2000);
assert.ok(!pause.isPaused(SkillId.Attack), "a gain unpauses");
pause.tickXp(SkillId.Attack, 110, 2, 2000 + 2 * 60_000);
assert.ok(pause.isPaused(SkillId.Attack), "auto pause after 2 idle minutes");
pause.unpauseSkill(SkillId.Attack, 200_000);
pause.tickLogout(true, true);
pause.tickLogout(true, false);
assert.ok(pause.isPaused(SkillId.Attack) && pause.isOverallPaused(), "logout pauses everything");
pause.tickLogout(true, true);
assert.ok(!pause.isPaused(SkillId.Cooking), "login lifts the logout pause");
const noLogoutPause = new XpPauseState();
noLogoutPause.tickLogout(false, true);
noLogoutPause.tickLogout(false, false);
assert.ok(!noLogoutPause.isPaused(SkillId.Cooking), "Pause on logout off");

console.log("xp tracker state tests passed");
