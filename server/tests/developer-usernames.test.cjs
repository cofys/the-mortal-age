// Run after `yarn build`: node --test tests/developer-usernames.test.cjs
const assert = require("node:assert/strict");
const { test, after } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { isConfiguredDeveloperUsername } = require("../dist/net/NetworkBuilder");

const previous = process.env.DEV_USERNAME;
after(() => {
  if (previous === undefined) delete process.env.DEV_USERNAME;
  else process.env.DEV_USERNAME = previous;
});

test("DEV_USERNAME names one developer account", () => {
  process.env.DEV_USERNAME = "gwdev";
  assert.equal(isConfiguredDeveloperUsername("GwDev"), true);
  assert.equal(isConfiguredDeveloperUsername("gwtest"), false);
});

test("DEV_USERNAME names several, comma-separated", () => {
  process.env.DEV_USERNAME = "gwdev, gwtest";
  assert.equal(isConfiguredDeveloperUsername("gwdev"), true);
  assert.equal(isConfiguredDeveloperUsername("gwtest"), true);
  assert.equal(isConfiguredDeveloperUsername("gw"), false);
});

test("unset or empty entries make no developer", () => {
  delete process.env.DEV_USERNAME;
  assert.equal(isConfiguredDeveloperUsername("gwdev"), false);
  process.env.DEV_USERNAME = " , ";
  assert.equal(isConfiguredDeveloperUsername(""), false);
});
