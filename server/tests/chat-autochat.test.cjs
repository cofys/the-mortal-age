// Run after `yarn build`: node --test tests/chat-autochat.test.cjs
// Autochat: the client repeats a phrase (cache proc 552, every 150 client cycles) with
// chat_sendpublic type 1. Receivers see message type 90 (AUTOTYPER), 91 from a player with a
// mod crown (MODAUTOTYPER), and the public filter mode 4 "Autochat" shows only those lines.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { decodeClientPacket, ChatType } = require('../dist/net/protocol/ClientProtocol');
const { PlayerRelations } = require('../dist/game/model/PlayerRelations');
const { ChatPacketListener } = require('../dist/net/packet/impl/ChatPacketListener');
const { PacketSender } = require('../dist/net/packet/PacketSender');
const { World } = require('../dist/game/World');

const CHAT = 190;
const chatPacket = (kind, text) => Buffer.from([CHAT, text.length + 2, kind, ...Buffer.from(text, 'latin1'), 0]);

test('CHAT kind 3 is public chat flagged as autochat; kinds 0-2 are unchanged', () => {
  assert.deepEqual(decodeClientPacket(chatPacket(3, 'buying gf')), { type: 'chat', messageType: 'public', autoChat: true, text: 'buying gf' });
  assert.deepEqual(decodeClientPacket(chatPacket(0, 'hello')), { type: 'chat', messageType: 'public', text: 'hello' });
  assert.deepEqual(decodeClientPacket(chatPacket(2, 'hi')), { type: 'chat', messageType: 'friends_chat', text: 'hi' });
});

// The Public stone's menu: Show autochat (4), Show standard (0), Show friends (1), Show none (2),
// Hide (3). The cache chatbox shows autochat lines only in mode 4, next to standard chat.
test('public filter mode 4 (Show autochat) receives standard and autochat lines; the other modes never receive autochat', () => {
  const other = { getLongUsername: () => 5n };
  const relations = new PlayerRelations({});
  relations.setChatModes(4, 1, 0);
  assert.equal(relations.getPublicChatMode(), 4, 'mode 4 is not clamped away');
  assert.equal(relations.canReceivePublicChatFrom(other, true), true);
  assert.equal(relations.canReceivePublicChatFrom(other, false), true, 'Show autochat keeps standard chat');
  relations.setChatModes(0, 1, 0);
  assert.equal(relations.canReceivePublicChatFrom(other, true), false, 'Show standard hides autochat');
  assert.equal(relations.canReceivePublicChatFrom(other, false), true);
  relations.setChatModes(1, 1, 0);
  assert.equal(relations.canReceivePublicChatFrom(other, true), false, 'Show friends hides autochat');
  relations.setChatModes(2, 1, 0);
  assert.equal(relations.canReceivePublicChatFrom(other, true), false);
  relations.setChatModes(9, 1, 0);
  assert.equal(relations.getPublicChatMode(), 4, 'clamped to the last mode');
});

/** A player whose CHAT_MESSAGE frames are collected as [type byte, from]. */
function listener(name, index, icons, receives = () => true) {
  const frames = [];
  const player = {
    getUsername: () => name,
    getHostAddress: () => '127.0.0.1',
    getIndex: () => index,
    getChatIcons: () => icons,
    forceChat: (text) => frames.push(['overhead', text]),
    getLocalPlayers: () => [],
    getRelations: () => ({ canReceivePublicChatFrom: receives }),
    getSession: () => ({ sendClientPacket: (frame) => { frames.push(decodeChatFrame(frame)); return true; } }),
  };
  player.getPacketSender = () => Object.assign(Object.create(PacketSender.prototype), { player });
  return { player, frames };
}

// CHAT_MESSAGE body: text\0, type, from\0, prefix\0, player id.
function decodeChatFrame(frame) {
  const body = frame.subarray(frame.length - frame.readUInt16BE(1));
  const textEnd = body.indexOf(0);
  const fromEnd = body.indexOf(0, textEnd + 2);
  return [body[textEnd + 1], body.toString('latin1', textEnd + 2, fromEnd), body.toString('latin1', 0, textEnd)];
}

test('an autochat line reaches listeners as type 90, or 91 from a player with a crown, and respects their filter', () => {
  const nearby = World.getNearbyPlayersForUpdate;
  World.getNearbyPlayersForUpdate = () => [];
  try {
    const speaker = listener('Bob', 7, []);
    const hears = listener('Alice', 8, []);
    const hides = listener('Carol', 9, [], (from, autoChat) => !autoChat);
    speaker.player.getLocalPlayers = () => [hears.player, hides.player];
    ChatPacketListener.handleText(speaker.player, 'buying gf', true);
    assert.deepEqual(speaker.frames, [['overhead', 'buying gf'], [ChatType.AUTOTYPER, 'Bob', 'buying gf']]);
    assert.deepEqual(hears.frames, [[ChatType.AUTOTYPER, 'Bob', 'buying gf']]);
    assert.deepEqual(hides.frames, [], 'her filter was asked with the autochat flag');

    const mod = listener('Mod Ash', 1, [2]);
    ChatPacketListener.handleText(mod.player, 'hello', true);
    assert.deepEqual(mod.frames[1], [ChatType.MODAUTOTYPER, '<img=2>Mod Ash', 'hello']);

    const plain = listener('Dave', 2, []);
    ChatPacketListener.handleText(plain.player, 'hello');
    assert.deepEqual(plain.frames[1], [2, 'Dave', 'hello'], 'ordinary public chat is still type 2');
  } finally {
    World.getNearbyPlayersForUpdate = nearby;
  }
});
