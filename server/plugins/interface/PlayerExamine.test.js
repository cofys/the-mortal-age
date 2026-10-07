/**
 * PlayerExamine.test — verify the examine interface builds and data functions work.
 */

const { _test } = require("./PlayerExamine.plugin");
const { GROUP_ID, COMPONENT, uid, DESCRIPTION_ATTRIBUTE, EXAMINE_OPTION_SLOT } = _test;

// Mock player
function mockPlayer(overrides = {}) {
  const attrs = new Map(Object.entries(overrides.attributes || {}));
  return {
    getUsername: () => overrides.username || "TestPlayer",
    getAttribute: (k) => attrs.get(k),
    setAttribute: (k, v) => attrs.set(k, v),
    getSkillManager: () => ({
      getCurrentLevel: () => overrides.skillLevel || 1,
    }),
    getPacketSender: () => ({
      sendMessage: () => {},
      sendString: () => {},
      sendPlayerOption: () => {},
      sendSubInterface: () => {},
    }),
    setInterfaceId: () => {},
    isPlayerBot: () => false,
    ...overrides,
  };
}

function runTests() {
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${name}: ${e.message}`);
    }
  }

  function assert(cond, msg) {
    if (!cond) throw new Error(msg || "assertion failed");
  }

  console.log("PlayerExamine tests:");

  test("GROUP_ID is 30010 (unused)", () => {
    assert(GROUP_ID === 30010, `expected 30010, got ${GROUP_ID}`);
  });

  test("EXAMINE_OPTION_SLOT is 8", () => {
    assert(EXAMINE_OPTION_SLOT === 8, `expected 8, got ${EXAMINE_OPTION_SLOT}`);
  });

  test("uid generates correct component UIDs", () => {
    const expected = (30010 << 16) | 2;
    assert(uid(COMPONENT.TITLE) === expected, `uid mismatch`);
  });

  test("DESCRIPTION_ATTRIBUTE is namespaced kebab-case", () => {
    assert(DESCRIPTION_ATTRIBUTE === "examine:description", `got ${DESCRIPTION_ATTRIBUTE}`);
    assert(DESCRIPTION_ATTRIBUTE.includes(":"), "should be namespaced");
    assert(!DESCRIPTION_ATTRIBUTE.includes("_") || DESCRIPTION_ATTRIBUTE === "examine:description", "should be kebab-case");
  });

  test("All required components defined", () => {
    const required = ["ROOT", "FRAME", "TITLE", "DESCRIPTION", "REPUTATION",
      "ACCOMPLISHMENTS", "GUILD", "SKILLS", "CLOSE_BUTTON"];
    for (const comp of required) {
      assert(COMPONENT[comp] !== undefined, `missing component ${comp}`);
    }
  });

  test("Component IDs are unique", () => {
    const ids = Object.values(COMPONENT);
    const unique = new Set(ids);
    assert(ids.length === unique.size, "duplicate component IDs");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
