"use strict";

const assert = require("assert");
const path = require("path");
const os = require("os");

const Philosophy = require("../../lib/CitizenPhilosophy");
const { createCitizenPhilosophizeAction } = require("./CitizenPhilosophize");

function freshSave() {
  const p = path.join(os.tmpdir(), `citizen-phil-action-test-${Date.now()}-${Math.random()}.json`);
  Philosophy.resetForTests();
  Philosophy._setSavePathForTests(p);
  return p;
}

// --- factory ---

{
  freshSave();
  const bot = { username: "Alice", personality: ["thoughtful", "curious"] };
  const director = { roster: new Map() };
  const action = createCitizenPhilosophizeAction(bot, director);
  assert(action.id === "citizenPhilosophize", "action id");
  assert(typeof action.canStart === "function", "canStart exists");
  assert(typeof action.start === "function", "start exists");
  console.log("ok: factory");
}

// --- canStart ---

{
  freshSave();
  const action = createCitizenPhilosophizeAction(null, {});
  assert(!action.canStart({}), "no bot -> cannot start");
  const action2 = createCitizenPhilosophizeAction({ username: "Bob" }, null);
  assert(!action2.canStart({}), "no director -> cannot start");
  const action3 = createCitizenPhilosophizeAction({ username: "Bob" }, {});
  assert(action3.canStart({}), "bot + director -> can start");
  console.log("ok: canStart");
}

// --- start joins school for thoughtful citizen ---

{
  freshSave();
  const said = [];
  const bot = { username: "Alice", personality: ["dutiful", "patient", "calm"] };
  const director = { roster: new Map() };
  const action = createCitizenPhilosophizeAction(bot, director);
  const result = action.start({ say: (t) => said.push(t) });
  assert(result.done, "action completes");
  assert(Philosophy.isPhilosopher("Alice"), "Alice joined a school");
  const phil = Philosophy.philosopherFor("Alice");
  assert(phil.school === "stoics", `dutiful+patient -> stoics, got ${phil.school}`);
  assert(said.length > 0, "join announced");
  console.log("ok: start joins school");
}

// --- start contemplates existing philosopher ---

{
  freshSave();
  Philosophy.joinSchool("Bob", "skeptics");
  const wisdomBefore = Philosophy.wisdomFor("Bob");

  const bot = { username: "Bob", personality: ["curious"] };
  const director = { roster: new Map() };
  const action = createCitizenPhilosophizeAction(bot, director);
  const result = action.start({});
  assert(result.done, "action completes");
  assert(Philosophy.wisdomFor("Bob") === wisdomBefore + 3, "wisdom gained from contemplation");
  console.log("ok: start contemplates");
}

// --- start with non-thoughtful citizen ---

{
  freshSave();
  const bot = { username: "Carol", personality: ["aggressive", "ruthless"] };
  const director = { roster: new Map() };
  const action = createCitizenPhilosophizeAction(bot, director);
  const result = action.start({});
  assert(result.done, "action completes even for non-thinker");
  // Carol has no matching traits, so she doesn't join — but doesn't crash
  console.log("ok: non-thoughtful citizen handled");
}

// --- tick ---

{
  freshSave();
  const action = createCitizenPhilosophizeAction({ username: "Dave" }, {});
  const result = action.tick({});
  assert(result.done, "tick completes");
  console.log("ok: tick");
}

console.log("\nAll CitizenPhilosophize action tests passed!");
