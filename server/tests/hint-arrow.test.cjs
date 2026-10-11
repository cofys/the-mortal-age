// Run after `yarn build`: node --test tests/hint-arrow.test.cjs
// Tile hint arrows carry OSRS's position type (tile centre or an edge) and height byte, with the
// target's floor (encodeHintArrow; the client draws them in TutorialHintOverlay).
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { encodeHintArrow } = require("../dist/net/protocol/ClientProtocol");
const { PacketSender } = require("../dist/net/packet/PacketSender");

function sentBy(call) {
  const packets = [];
  const player = { getSession: () => ({ sendClientPacket: (packet) => packets.push(packet) }) };
  call(new PacketSender(player));
  return packets[0];
}

test("a tile hint sends the position type and floor in the last byte, the height before it", () => {
  const at = { getX: () => 3098, getY: () => 3107 };
  const packet = sentBy((sender) => sender.sendPositionalHint(at, 3, 128, 1)); // west edge of a door
  assert.deepEqual([...packet], [...encodeHintArrow(2, 3098, 3107, 128, (3 << 2) | 1)]);
  assert.equal(packet.length, 8, "opcode + 7 bytes");
  assert.equal(packet[6], 128, "the OSRS height byte");
  assert.equal(packet[7], (3 << 2) | 1);
});

test("an unknown position type is sent as the tile's centre", () => {
  const at = { getX: () => 1, getY: () => 1 };
  const packet = sentBy((sender) => sender.sendPositionalHint(at, 9, 0, 0));
  assert.equal(packet[7] >> 2, 2);
});
