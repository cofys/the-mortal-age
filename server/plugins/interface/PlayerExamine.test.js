/**
 * PlayerExamine.test — verify the examine interface builds and data functions work.
 */

const Module = require("module");
const path = require("path");
const pluginPath = path.resolve(__dirname, "PlayerExamine.plugin.js");

// Stub the widgetGroup dependency before requiring the plugin.
const widgetGroupPath = path.resolve(__dirname, "widgetGroup.js");
const widgetGroupSrc = require("fs").readFileSync(widgetGroupPath, "utf8");
const widgetGroupModule = new Module(widgetGroupPath, module);
widgetGroupModule._compile(widgetGroupSrc, widgetGroupPath);
require.cache[widgetGroupPath] = widgetGroupModule;

const plugin = require(pluginPath);
const { _test } = plugin;
const { GROUP_ID, COMPONENT, uid, DESCRIPTION_ATTRIBUTE, EXAMINE_OPTION_SLOT } = _test;

// Load the API module (no widget dependency — pure data + endpoint).
const apiPath = path.resolve(__dirname, "ExamineApi.js");
const examineApi = require(apiPath);
const { EXAMINE_OPEN_ATTRIBUTE } = examineApi;

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
    const expected = (30010 << 16) | 3;
    assert(uid(COMPONENT.TITLE) === expected, `uid mismatch`);
  });

  test("DESCRIPTION_ATTRIBUTE is namespaced kebab-case", () => {
    assert(DESCRIPTION_ATTRIBUTE === "examine:description", `got ${DESCRIPTION_ATTRIBUTE}`);
    assert(DESCRIPTION_ATTRIBUTE.includes(":"), "should be namespaced");
  });

  test("All required components defined", () => {
    const required = ["ROOT", "BORDER", "BG", "TITLE", "SUBTITLE", "SUBSUB",
      "DESCRIPTION", "REPUTATION", "ACCOMPLISHMENTS", "GUILD", "SKILLS",
      "CLOSE_BUTTON", "FOOTNOTE"];
    for (const comp of required) {
      assert(COMPONENT[comp] !== undefined, `missing component ${comp}`);
    }
  });

  test("Component IDs are unique", () => {
    const ids = Object.values(COMPONENT);
    const unique = new Set(ids);
    assert(ids.length === unique.size, "duplicate component IDs");
  });

  test("Section panels exist for every body", () => {
    const pairs = [
      ["PERSON_HEAD", "PERSON_PANEL", "DESCRIPTION"],
      ["REP_HEAD", "REP_PANEL", "REPUTATION"],
      ["DEEDS_HEAD", "DEEDS_PANEL", "ACCOMPLISHMENTS"],
      ["GUILD_HEAD", "GUILD_PANEL", "GUILD"],
      ["SKILLS_HEAD", "SKILLS_PANEL", "SKILLS"],
    ];
    for (const [head, panel, body] of pairs) {
      assert(COMPONENT[head] !== undefined, `missing ${head}`);
      assert(COMPONENT[panel] !== undefined, `missing ${panel}`);
      assert(COMPONENT[body] !== undefined, `missing ${body}`);
    }
  });

  test("EXAMINE_OPEN_ATTRIBUTE is namespaced kebab-case", () => {
    assert(EXAMINE_OPEN_ATTRIBUTE === "examine:open", `got ${EXAMINE_OPEN_ATTRIBUTE}`);
    assert(EXAMINE_OPEN_ATTRIBUTE.includes(":"), "should be namespaced");
  });

  test("ExamineApi exposes attach", () => {
    assert(typeof examineApi.attach === "function", "attach should be a function");
  });

  test("ExamineApi registers the examine-status endpoint", () => {
    let registered = null;
    const fakeApi = {
      registerContentEndpoint: (name, handler) => { registered = { name, handler }; },
      core: { World: { getPlayerByName: () => null }, Skill: { values: () => [] } },
    };
    // Silence the console.info in attach.
    const origInfo = console.info;
    console.info = () => {};
    try {
      examineApi.attach(fakeApi);
    } finally {
      console.info = origInfo;
    }
    assert(registered && registered.name === "examine-status", "endpoint name should be examine-status");
    assert(typeof registered.handler === "function", "handler should be a function");
  });

  test("examine-status returns closed when no player", () => {
    let handler = null;
    const fakeApi = {
      registerContentEndpoint: (name, h) => { handler = h; },
      core: { World: { getPlayerByName: () => null }, Skill: { values: () => [] } },
    };
    const origInfo = console.info;
    console.info = () => {};
    try { examineApi.attach(fakeApi); } finally { console.info = origInfo; }
    const query = new Map();
    const result = handler({ get: (k) => query.get(k) });
    assert(result.open === false, "should be closed with no player");
  });

  test("examine-status close action clears the flag", () => {
    let handler = null;
    const attrs = new Map([[EXAMINE_OPEN_ATTRIBUTE, "SomeTarget"]]);
    const fakePlayer = {
      getAttribute: (k) => attrs.get(k),
      setAttribute: (k, v) => attrs.set(k, v),
    };
    const fakeApi = {
      registerContentEndpoint: (name, h) => { handler = h; },
      core: { World: { getPlayerByName: () => fakePlayer }, Skill: { values: () => [] } },
    };
    const origInfo = console.info;
    console.info = () => {};
    try { examineApi.attach(fakeApi); } finally { console.info = origInfo; }
    const query = new Map([["player", "Me"], ["action", "close"]]);
    const result = handler({ get: (k) => query.get(k) });
    assert(result.open === false, "should be closed after close action");
    assert(attrs.get(EXAMINE_OPEN_ATTRIBUTE) === "", "flag should be cleared");
  });

  test("examine-status returns a sheet when open", () => {
    let handler = null;
    const targetAttrs = new Map([
      ["character:display-name", "Aldric Stonehand"],
      ["examine:description", "A weathered smith."],
    ]);
    const fakeTarget = {
      getUsername: () => "aldric",
      getAttribute: (k) => targetAttrs.get(k),
      getSkillManager: () => ({ getCurrentLevel: () => 1 }),
    };
    const viewerAttrs = new Map([[EXAMINE_OPEN_ATTRIBUTE, "aldric"]]);
    const fakeViewer = {
      getAttribute: (k) => viewerAttrs.get(k),
      setAttribute: (k, v) => viewerAttrs.set(k, v),
    };
    const fakeApi = {
      registerContentEndpoint: (name, h) => { handler = h; },
      core: {
        World: { getPlayerByName: (n) => (n === "aldric" ? fakeTarget : fakeViewer) },
        Skill: { values: () => [] },
      },
    };
    const origInfo = console.info;
    console.info = () => {};
    try { examineApi.attach(fakeApi); } finally { console.info = origInfo; }
    const query = new Map([["player", "viewer"]]);
    const result = handler({ get: (k) => query.get(k) });
    assert(result.open === true, "should be open");
    assert(result.sheet && result.sheet.name === "Aldric Stonehand", "sheet should carry display name");
    assert(result.sheet.description === "A weathered smith.", "sheet should carry description");
    assert(Array.isArray(result.sheet.reputation), "reputation should be an array");
    assert(Array.isArray(result.sheet.skills), "skills should be an array");
  });

  test("examine-status closes when target logged out", () => {
    let handler = null;
    const viewerAttrs = new Map([[EXAMINE_OPEN_ATTRIBUTE, "ghost"]]);
    const fakeViewer = {
      getAttribute: (k) => viewerAttrs.get(k),
      setAttribute: (k, v) => viewerAttrs.set(k, v),
    };
    const fakeApi = {
      registerContentEndpoint: (name, h) => { handler = h; },
      core: {
        World: { getPlayerByName: (n) => (n === "viewer" ? fakeViewer : null) },
        Skill: { values: () => [] },
      },
    };
    const origInfo = console.info;
    console.info = () => {};
    try { examineApi.attach(fakeApi); } finally { console.info = origInfo; }
    const query = new Map([["player", "viewer"]]);
    const result = handler({ get: (k) => query.get(k) });
    assert(result.open === false, "should close when target is gone");
    assert(viewerAttrs.get(EXAMINE_OPEN_ATTRIBUTE) === "", "flag should be cleared");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
