// Run after `yarn build`: node --test tests/browser-host-bridge.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");

const { BROWSER_HOST_BRIDGE_HTML } = require("../dist/net/BrowserHostHttpBridge");

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs the bridge page's script against a fake port and a server that always has a frame to poll. */
function startBridge() {
  const script = /<script>([\s\S]*)<\/script>/.exec(BROWSER_HOST_BRIDGE_HTML)[1];
  const port = { postMessage: () => {}, start: () => {}, onmessage: null };
  let polls = 0;
  let connect;
  const fetch = async (url, init = {}) => {
    await tick(1);
    if (url === "/browser-host/session" && init.method === "POST") {
      return { ok: true, status: 200, text: async () => "session" };
    }
    if (url.endsWith("/poll")) {
      polls++;
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1) };
    }
    return { ok: true, status: 204 };
  };
  vm.runInNewContext(script, {
    addEventListener: (_type, listener) => { connect = listener; },
    removeEventListener: () => {},
    parent: { postMessage: () => {} },
    fetch,
    AbortSignal,
  });
  connect({ data: "browser-host-connect", ports: [port] });
  return {
    polls: () => polls,
    send: (type) => port.onmessage({ data: { type } }),
  };
}

test("the host pauses and resumes polling", async (t) => {
  const bridge = startBridge();
  t.after(() => bridge.send("close"));
  await tick();
  assert.ok(bridge.polls() > 0, "polls once the session opens");

  bridge.send("pause");
  await tick();
  const paused = bridge.polls();
  await tick(50);
  assert.equal(bridge.polls(), paused, "no polls while paused");

  bridge.send("resume");
  await tick();
  assert.ok(bridge.polls() > paused, "polls again after resume");
});
