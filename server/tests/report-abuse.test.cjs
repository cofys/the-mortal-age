// Run after `yarn build`: node --test tests/report-abuse.test.cjs
// Report abuse, as captured (rsprox recs 2375 rev 229, 3719 rev 235): the server sets player
// option 8 "Report"; right-click Report or the chatbox Report button (162:31 op 2) sends
// varbit chatoverlay_unclamp 10689=1, opens interface 875 as an overlay on chatbox:chatoverlay
// (162:567 in the rev 241 cache) and runs reportabuse_init 5084 [enabled, hasName, name]; Close (875:23) sends the
// varbit back to 0, closes the overlay and runs reportabuse_close 5085. The form's submit is
// SEND_SNAPSHOT { name, rule id, mute } (RSProx), here client packet REPORT_ABUSE 199.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { decodeClientPacket } = require('../dist/net/protocol/ClientProtocol');
const { PlayerRights } = require('../dist/game/model/rights/PlayerRights');
const ReportAbuse = require('../plugins/interface/ReportAbuse.plugin');

const CHATBOX_REPORT_BUTTON = (162 << 16) | 31;
const REPORT_CLOSE_BUTTON = (875 << 16) | 23;
const CHATBOX_OVERLAY = (162 << 16) | 567;

test('REPORT_ABUSE (199) decodes name, rule id and mute flag', () => {
  const name = Buffer.from('Bob', 'latin1');
  assert.deepEqual(decodeClientPacket(Buffer.from([199, name.length + 3, ...name, 0, 6, 0])), { type: 'report_abuse', name: 'Bob', ruleId: 6, mute: false });
  assert.deepEqual(decodeClientPacket(Buffer.from([199, name.length + 3, ...name, 0, 15, 1])), { type: 'report_abuse', name: 'Bob', ruleId: 15, mute: true });
});

/** The plugin registered on a fake api: its hooks, and the custom events it emitted. */
function registered() {
  const buttons = new Map();
  const hooks = { logins: [], playerOptions: [], social: [] };
  const emitted = [];
  const ids = (id) => (Array.isArray(id) ? id : [id]);
  const api = {
    onPlayerLogin: (handler) => hooks.logins.push(handler),
    onPlayerOption: (handler) => hooks.playerOptions.push(handler),
    onSocialPacket: (handler) => hooks.social.push(handler),
    onInterfaceActionButton: (id, handler) => ids(id).forEach((one) => buttons.set(one, handler)),
    emitCustomEvent: (name, payload) => emitted.push([name, payload]),
    log: () => {},
  };
  ReportAbuse.register(new Proxy(api, { get: (target, prop) => (prop in target ? target[prop] : () => {}) }));
  return { buttons, hooks, emitted };
}

function recordingPlayer(name, rights = PlayerRights.NONE) {
  const sent = [];
  const sender = {
    sendPlayerOption: (slot, option, priority) => { sent.push(`playerOption ${slot} ${option}${priority ? ' priority' : ''}`); return sender; },
    sendVarbit: (id, value) => { sent.push(`varbit ${id}=${value}`); return sender; },
    sendSubInterface: (uid, group, type) => { sent.push(`open ${uid}:${group}:${type}`); return sender; },
    closeSubInterface: (uid) => { sent.push(`close ${uid}`); return sender; },
    sendClientScript: (id, ...args) => { sent.push(`script ${id}${args.length ? ' ' + args.join(',') : ''}`); return sender; },
    sendMessage: (text) => { sent.push(`message ${text}`); return sender; },
  };
  return { sent, getUsername: () => name, getRights: () => rights, busy: () => false, getPacketSender: () => sender };
}

test('login gives every player the Report option in slot 8', () => {
  const { hooks } = registered();
  const player = recordingPlayer('Alice');
  hooks.logins.forEach((login) => login({ player, username: 'Alice' }));
  assert.deepEqual(player.sent, ['playerOption 8 Report']);
});

test('as captured: right-click Report opens the form over the chatbox with the name filled in', () => {
  const { hooks } = registered();
  const player = recordingPlayer('Alice');
  const target = recordingPlayer('Z-Kris');
  const event = { player, target, option: 8, handled: false };
  hooks.playerOptions.forEach((hook) => hook(event));
  assert.equal(event.handled, true);
  assert.deepEqual(player.sent, ['varbit 10689=1', `open ${CHATBOX_OVERLAY}:875:1`, 'script 5084 1,1,Z-Kris']);
  const other = { player, target, option: 5, handled: false };
  hooks.playerOptions.forEach((hook) => hook(other));
  assert.equal(other.handled, false, 'other slots are not ours');
});

test('as captured: the chatbox Report button opens the form with no name; Report game bug is not ours', () => {
  const { buttons } = registered();
  const player = recordingPlayer('Alice');
  assert.equal(buttons.get(CHATBOX_REPORT_BUTTON)({ player, buttonId: CHATBOX_REPORT_BUTTON, action: 2, opId: 2 }), true);
  assert.deepEqual(player.sent, ['varbit 10689=1', `open ${CHATBOX_OVERLAY}:875:1`, 'script 5084 1,0,']);
  player.sent.length = 0;
  assert.equal(buttons.get(CHATBOX_REPORT_BUTTON)({ player, buttonId: CHATBOX_REPORT_BUTTON, action: 4, opId: 4 }), false);
  assert.deepEqual(player.sent, []);
});

test('a busy player is told to finish first', () => {
  const { buttons } = registered();
  const player = recordingPlayer('Alice');
  player.busy = () => true;
  buttons.get(CHATBOX_REPORT_BUTTON)({ player, buttonId: CHATBOX_REPORT_BUTTON, action: 2, opId: 2 });
  assert.deepEqual(player.sent, ["message Please finish what you're doing first."]);
});

test('as captured: Close drops the unclamp varbit, closes the overlay and runs reportabuse_close', () => {
  const { buttons } = registered();
  const player = recordingPlayer('Alice');
  assert.equal(buttons.get(REPORT_CLOSE_BUTTON)({ player, buttonId: REPORT_CLOSE_BUTTON, action: 1, opId: 1 }), true);
  assert.deepEqual(player.sent, ['varbit 10689=0', `close ${CHATBOX_OVERLAY}`, 'script 5085']);
});

test('a report is appended to the log as one JSON line and announced; the mute flag counts only from staff', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tsps-reports-')), 'abuse-reports.jsonl');
  process.env.TSPS_ABUSE_REPORTS_FILE = file;
  try {
    const { hooks, emitted } = registered();
    const deliver = (player, packet) => {
      const event = { player, packet, handled: false };
      hooks.social.forEach((hook) => hook(event));
      return event.handled;
    };
    const alice = recordingPlayer('Alice');
    assert.equal(deliver(alice, { type: 'report_abuse', name: 'Bob', ruleId: 6, mute: true }), true);
    const mod = recordingPlayer('Mod Ash', PlayerRights.MODERATOR);
    assert.equal(deliver(mod, { type: 'report_abuse', name: 'Bob', ruleId: 14, mute: true }), true);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].reporter, 'Alice');
    assert.equal(lines[0].reported, 'Bob');
    assert.equal(lines[0].ruleId, 6);
    assert.equal(lines[0].rule, 'Macroing or use of bots');
    assert.equal(lines[0].mute, false, 'a player cannot request a mute');
    assert.ok(typeof lines[0].time === 'string' && !Number.isNaN(Date.parse(lines[0].time)));
    assert.equal(lines[1].rule, 'Scamming');
    assert.equal(lines[1].mute, true, 'a moderator can');
    assert.deepEqual(emitted.map(([name, payload]) => [name, payload.reporter.getUsername(), payload.reported, payload.ruleId]), [
      ['report:abuse', 'Alice', 'Bob', 6], ['report:abuse', 'Mod Ash', 'Bob', 14],
    ]);
    assert.deepEqual(alice.sent, [], 'the form shows its own thank-you page; nothing is sent back');

    assert.equal(deliver(alice, { type: 'report_abuse', name: 'Bob', ruleId: 99, mute: false }), true, 'an unknown rule is swallowed');
    assert.equal(deliver(alice, { type: 'report_abuse', name: '', ruleId: 6, mute: false }), true, 'so is a missing name');
    assert.equal(deliver(alice, { type: 'report_abuse' }), true, 'and a malformed packet does not throw');
    assert.equal(deliver(alice, { type: 'chat_filter', publicMode: 0, privateMode: 0, tradeMode: 0 }), false, 'other packets pass through');
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2, 'nothing more was logged');
  } finally {
    delete process.env.TSPS_ABUSE_REPORTS_FILE;
  }
});
