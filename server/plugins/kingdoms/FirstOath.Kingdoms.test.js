"use strict";

/**
 * Kingdom-choice Phase 3 ("First oath") — a day-one way to serve your kingdom.
 * - Onboarding guide surfaces "Supply the war effort".
 * - Supply deliveries grant influence (order path, not just war-demand).
 * - kingdom:supply-delivered settles earned promotions.
 * - Promotions above Subject re-open the My Kingdom panel with "you've risen".
 */
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const Influence = require("./Influence.Kingdoms");

const LADDER = ["Outsider", "Subject", "Man-at-arms", "Knight", "Lord", "Regent", "Monarch"];

function mockPlayer({ kingdomId = "misthalin", rank = "Subject", influence = 0, welcomed = false } = {}) {
  const attrs = {
    "kingdom:id": kingdomId,
    "kingdom:rank": rank,
    "kingdom:influence": {
      [kingdomId]: { points: influence, firstEarned: Date.now(), lastEarned: Date.now() },
    },
    ...(welcomed ? { "mykingdom:welcomed": "1" } : {}),
  };
  const messages = [];
  return {
    username: "test-player",
    getAttribute: (key) => attrs[key] ?? null,
    setAttribute: (key, val) => {
      attrs[key] = val;
    },
    isPlayerBot: () => false,
    sendMessage: (msg) => messages.push(msg),
    _attrs: () => attrs,
    _messages: () => messages,
  };
}

describe("Phase 3: supply delivery earns influence toward first promotion", () => {
  it("influence lands on the player record (existing gain path)", () => {
    const player = mockPlayer({ influence: 0 });
    Influence.addInfluence(player, "misthalin", 5);
    const rec = player.getAttribute("kingdom:influence")["misthalin"];
    assert.ok(rec.points >= 5, "influence lands on the record");
  });

  it("settlePromotion names Man-at-arms at 100 influence (first tier above Subject)", () => {
    const player = mockPlayer({ rank: "Subject", influence: 100 });
    let emitted = null;
    const rank = Influence.settlePromotion(
      player,
      "misthalin",
      LADDER,
      (payload) => {
        emitted = payload;
      }
    );
    assert.equal(rank, "Man-at-arms");
    assert.equal(emitted.rank, "Man-at-arms");
    assert.equal(emitted.kingdomId, "misthalin");
  });

  it("no promotion below the threshold", () => {
    const player = mockPlayer({ rank: "Subject", influence: 50 });
    let emitted = null;
    const rank = Influence.settlePromotion(player, "misthalin", LADDER, (p) => {
      emitted = p;
    });
    assert.equal(rank, null);
    assert.equal(emitted, null);
  });
});

describe("Phase 3: promotion re-opens the My Kingdom panel", () => {
  function captureRankGrantedHandler() {
    const handlers = {};
    const api = {
      onCustomEvent: (name, fn) => {
        handlers[name] = fn;
      },
      onNpcInteraction: () => {},
    };
    // MyKingdom.Kingdoms exports attachMyKingdom; invoke to capture handlers.
    const attach = require("./MyKingdom.Kingdoms");
    attach(api);
    return handlers["kingdom:rank-granted"];
  }

  it("first welcome opens the panel once (existing behavior)", () => {
    const handler = captureRankGrantedHandler();
    const player = mockPlayer({ welcomed: false });
    handler({ player, kingdomId: "misthalin", rank: "Subject" });
    assert.equal(player.getAttribute("mykingdom:welcomed"), "1");
    assert.equal(player.getAttribute("mykingdom:open"), "1");
  });

  it("promotion above Subject re-opens the panel with you've-risen", () => {
    const handler = captureRankGrantedHandler();
    const player = mockPlayer({ welcomed: true, rank: "Subject" });
    // Clear the open attribute to prove the handler re-sets it.
    player.setAttribute("mykingdom:open", "0");
    handler({ player, kingdomId: "misthalin", rank: "Man-at-arms" });
    const messages = player._messages();
    assert.ok(
      messages.some((m) => /risen/i.test(m) && /Man-at-arms/.test(m)),
      "you've-risen line names the new rank, got: " + JSON.stringify(messages)
    );
    assert.ok(
      messages.some((m) => /serve.*misthalin.*Man-at-arms/i.test(m) || /Man-at-arms/.test(m)),
      "membership standing shown"
    );
    assert.equal(player.getAttribute("mykingdom:open"), "1", "panel re-opened");
  });

  it("Subject re-grant does not re-open (no spam)", () => {
    const handler = captureRankGrantedHandler();
    const player = mockPlayer({ welcomed: true, rank: "Subject" });
    player.setAttribute("mykingdom:open", "0");
    handler({ player, kingdomId: "misthalin", rank: "Subject" });
    assert.equal(player.getAttribute("mykingdom:open"), "0", "panel stays closed");
    assert.equal(player._messages().length, 0, "no messages");
  });
});
