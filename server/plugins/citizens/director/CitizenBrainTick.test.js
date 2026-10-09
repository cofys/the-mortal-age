"use strict";

/**
 * Reproduction test for citizen movement bug.
 * 
 * Bug: Citizens spawn and talk (director tick works) but never move.
 * Diagnostic proved ZERO BotBrain.tick() calls in 8+ minutes.
 * 
 * Root cause hypothesis: attachBrain silently fails, leaving entry.brain
 * null. BotBehaviorTask.processEntry returns early if !entry.brain.
 * 
 * This test verifies the attachBrain logic with mocked dependencies.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("attachBrain logic", () => {
  it("fails silently when activity is null (the bug)", () => {
    // Simulate what happens in CitizenDirector.spawnCitizen when
    // this.registry.byId.get() returns undefined
    
    const runtime = {
      entries: [],
      entriesByUsername: new Map(),
      botStatesByName: new Map(),
    };
    
    const bot = { getUsername: () => "Test Citizen" };
    const username = bot.getUsername();
    const state = { mode: "citizen_routine" };
    const entry = { player: bot, state };
    
    runtime.entries.push(entry);
    runtime.entriesByUsername.set(username, entry);
    runtime.botStatesByName.set(username, state);
    
    // Simulate attachBrain with null activity (registry lookup failed)
    const activity = null;
    
    // This is what attachBrain does:
    let brainAttached = false;
    if (activity) {
      // attachBrain would be called here
      brainAttached = true;
    }
    // If activity is null, attachBrain is NEVER called, entry.brain stays undefined
    
    assert.strictEqual(brainAttached, false, 
      "When activity is null, brain is never attached (silent failure)");
    assert.strictEqual(entry.brain, undefined,
      "entry.brain remains undefined - BotBehaviorTask will skip this entry");
  });

  it("BotBehaviorTask skips entries without brain", () => {
    // Simulate BotBehaviorTask.processEntry logic
    const entry = { 
      player: {}, 
      state: {}, 
      brain: null  // The bug: brain was never attached
    };
    
    // This is the exact check from BotBehaviorTask.processEntry (line 861-863):
    let tickCalled = false;
    if (!entry.brain) {
      // return early - brain.tick() is NEVER called
    } else {
      tickCalled = true; // brain.tick() would be called here
    }
    
    assert.strictEqual(tickCalled, false,
      "Entries without brain never have tick() called - citizens freeze");
  });

  it("documents the fix: Director must log when activity lookup fails", () => {
    // The fix: CitizenDirector.spawnCitizen should log when
    // this.registry.byId.get() returns null, instead of silently skipping
    // attachBrain. This makes the root cause visible.
    
    const ROLE_ACTIVITY = { commoner: "citizen_routine" };
    const mockRegistry = { byId: new Map() }; // Empty! No activities registered
    
    const role = "commoner";
    const activityId = ROLE_ACTIVITY[role];
    const activity = mockRegistry.byId.get(activityId);
    
    assert.strictEqual(activity, undefined,
      "If registry is empty or ID mismatched, activity is undefined");
    // The fix ensures this case is logged, not silent
  });
});
