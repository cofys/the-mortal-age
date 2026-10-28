// The rank selection (932), as live (rsprox): the trial is put in varp 4985 (its DB row) and the
// interface opens as a main modal; the client draws the ranks, times and rewards from the cache
// and the player's variables. Clicking rank 0-3 (unranked to Marlin) starts the run; a reward
// shows its examine (script 6003, as captured).
// Ours: a rank whose previous rank hasn't been beaten is refused with a message.
const common = require("./Common.BarracudaTrials");

const GROUP = 932;
const CLICK = 6;
const REWARD_CLICK = 7;
const MAIN_MODAL = (161 << 16) | 16;
const SCRIPT_MAINMODAL_OPEN = 2524;
const SCRIPT_EXAMINE_ITEM = 6003;
const IF_EVENT_OP1 = 1 << 1;
/** examine_item's layout per reward slot (captured). */
const EXAMINE_LAYOUT = { 1: [30, 18, 12], 2: [30, 18, 12], 3: [100, 300, 200] };

/** Who has the selection open, for which trial. */
const open = new Map();

function openSelection(player, trial) {
  const out = player.getPacketSender();
  out.sendConfig(common.varp("sailing_bt_trial_data_if"), trial.dbrow);
  out.sendInterfaceScript(SCRIPT_MAINMODAL_OPEN, [-1, -1]);
  player.setInterfaceId(GROUP);
  out.sendSubInterface(MAIN_MODAL, GROUP, 0);
  out.sendInterfaceFlagsRange((GROUP << 16) | CLICK, 0, 3, IF_EVENT_OP1);
  out.sendInterfaceFlagsRange((GROUP << 16) | REWARD_CLICK, 1, 3, IF_EVENT_OP1);
  open.set(player, trial);
}

function examineReward(player, trial, slot) {
  const reward = common.ranksOf(trial)[slot]?.reward;
  if (!(reward > 0)) return;
  const examine = common.core().ItemDefinition.forId(reward)?.getExamine?.() ?? "";
  const [a, b, c] = EXAMINE_LAYOUT[slot];
  player.getPacketSender().sendClientScript(SCRIPT_EXAMINE_ITEM, reward, 1, examine, 0, a, 1, b, c);
}

function click(event) {
  if (event.groupId !== GROUP) return;
  const { player } = event;
  const trial = open.get(player);
  if (!trial || player.getInterfaceId?.() !== GROUP) return;
  event.handled = true;
  if (event.childId === REWARD_CLICK) return examineReward(player, trial, event.slot);
  if (event.childId !== CLICK || !Number.isInteger(event.slot)) return;
  const rank = event.slot;
  if (rank < 0 || rank > 3) return;
  if (!common.rankBeaten(player, trial, rank - 1)) {
    const ranks = common.ranksOf(trial);
    player.sendMessage(`You need to achieve the ${ranks[rank - 1].name} rank in the ${trial.name} before attempting the ${ranks[rank].name} rank.`);
    return;
  }
  open.delete(player);
  common.api().emitCustomEvent("barracuda-trials:rank-chosen", { player, trial, rank });
}

function attach(api) {
  common.init(api);
  api.onInterfaceActionClick(click);
  api.onCustomEvent("interface:closed", closed);
  api.onPlayerLogout(forget);
}

function closed({ player, interfaceId }) {
  if (interfaceId === GROUP) open.delete(player);
}

function forget({ player }) {
  open.delete(player);
}

module.exports = attach;
module.exports.openSelection = openSelection;
module.exports.isOpen = (player) => open.has(player);
