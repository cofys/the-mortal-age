package local.questbridge;

import static org.junit.jupiter.api.Assertions.*;

import com.google.gson.*;
import net.runelite.api.events.GameTick;
import org.junit.jupiter.api.Test;

class LifecycleRecoveryTest {
  static JsonObject definition(int id) {
    var d = new JsonObject();
    d.addProperty("id", id);
    d.add("impostorIds", JsonNull.INSTANCE);
    return d;
  }

  @Test
  void actualRomeoJulietLetterTransitionRetriesAfterDefinitionHydration() {
    try (var engine = new BridgeEngine()) {
      // Native QA: Juliet handed over Message 755; actual varp144 becomes20,
      // player3159,3425,plane1. A nonmatching scene object at the stairs makes
      // upstream ObjectStep query its real cache composition during startup.
      var req = BridgeTest.request("romeo-recovery", 1, "romeo_and_juliet");
      var s = req.getAsJsonObject("snapshot");
      s.addProperty("baseX", 3104);
      s.addProperty("baseY", 3376);
      s.addProperty("plane", 1);
      s.add(
          "localPlayer",
          JsonParser.parseString("{\"name\":\"fixture\",\"x\":3159,\"y\":3425,\"plane\":1}"));
      s.getAsJsonObject("questStates")
          .addProperty(
              "" + com.questhelper.questinfo.QuestHelperQuest.ROMEO__JULIET.getId(), "IN_PROGRESS");
      s.getAsJsonObject("varps").addProperty("144", 10);
      assertEquals("active", engine.evaluate(req).get("status").getAsString());
      s.getAsJsonObject("varps").addProperty("144", 20);
      s.add("inventory", JsonParser.parseString("[{\"id\":755,\"quantity\":1,\"slot\":0}]"));
      s.add(
          "objects",
          JsonParser.parseString("[{\"id\":15552,\"type\":10,\"x\":3156,\"y\":3435,\"plane\":1}]"));
      req.addProperty("sequence", 2);
      var missing = engine.evaluate(req);
      assertEquals(
          "MISSING_STATE",
          missing.getAsJsonArray("diagnostics").get(0).getAsJsonObject().get("code").getAsString(),
          missing.toString());
      var defs = new JsonObject();
      defs.add("15552", definition(15552));
      s.add("objectDefinitions", defs);
      req.addProperty("sequence", 3);
      var recovered = engine.evaluate(req);
      assertEquals("active", recovered.get("status").getAsString(), recovered.toString());
      var step = recovered.getAsJsonObject("activeStep");
      assertFalse(step.get("id").getAsString().contains("ConditionalStep"), recovered.toString());
      assertFalse(step.getAsJsonArray("targets").isEmpty(), recovered.toString());
      assertTrue(step.get("text").toString().contains("Romeo"), recovered.toString());
    }
  }

  public static class DefinitionsOnTick {
    final SnapshotClient snapshot;

    DefinitionsOnTick(SnapshotClient snapshot) {
      this.snapshot = snapshot;
    }

    @net.runelite.client.eventbus.Subscribe
    public void onGameTick(GameTick event) {
      snapshot.client.getObjectDefinition(100).getId();
    }
  }

  @Test
  void hydratedDefinitionBatchDoesNotReplayPriorEventBusFailures() {
    var state = BridgeTest.snapshot();
    var objects = new JsonArray();
    for (int id = 100; id < 620; id++)
      objects.add(
          JsonParser.parseString(
              "{\"id\":"
                  + id
                  + ",\"type\":10,\"x\":"
                  + (3152 + (id - 100) % 104)
                  + ",\"y\":"
                  + (3152 + (id - 100) / 104)
                  + ",\"plane\":0}"));
    state.add("objects", objects);
    var snapshot = new SnapshotClient(state);
    var services = new HeadlessServices(snapshot);
    services.bus.register(new DefinitionsOnTick(snapshot));
    for (int i = 0; i < 20; i++) services.bus.post(new GameTick());
    var missing = assertThrows(BridgeFailure.class, services::flush);
    assertEquals(512, missing.requests.size());
    var defs = new JsonObject();
    for (int id = 100; id < 620; id++) defs.add("" + id, definition(id));
    state.add("objectDefinitions", defs);
    snapshot.update(state);
    services.bus.post(new GameTick());
    assertDoesNotThrow(services::flush);
    assertTrue(services.eventErrors.isEmpty());
  }

  @Test
  void cookAuthoritativeHistoryIsReplayedAfterHelperReinitialization() throws Exception {
    try (var engine = new BridgeEngine()) {
      var req = BridgeTest.request("cook-reinit", 1, "cooks_assistant");
      req.getAsJsonObject("snapshot")
          .add("dialogueHistory", JsonParser.parseString("[\"Here's a bucket of milk.\"]"));
      var first = engine.evaluate(req);
      assertTrue(
          first.getAsJsonObject("activeStep").get("text").toString().contains("Purchase a pot"),
          first.toString());
      var session = engine.sessions.get("cook-reinit");
      session.stop();
      session.started = false;
      var initialized =
          com.questhelper.questhelpers.QuestHelper.class.getDeclaredField("hasInitialized");
      initialized.setAccessible(true);
      initialized.set(session.helper, false);
      req.addProperty("sequence", 2);
      var recovered = engine.evaluate(req);
      assertTrue(
          recovered.getAsJsonObject("activeStep").get("text").toString().contains("Purchase a pot"),
          recovered.toString());
    }
  }

  @Test
  void fatalSubscriberFailureIsNotHiddenByMissingStateOrFailingCallback() {
    var services = new HeadlessServices(new SnapshotClient(BridgeTest.snapshot()));
    services.eventErrors.add(BridgeFailure.missing("objectDefinitions", 100));
    services.eventErrors.add(BridgeFailure.unsupported("known-unimplemented-operation"));
    services.callbacks.add(
        () -> {
          throw BridgeFailure.missing("widget", 7);
        });
    var error = assertThrows(BridgeFailure.class, services::flush);
    assertEquals("UNSUPPORTED_API", error.code);
    assertTrue(services.eventErrors.isEmpty());
    assertTrue(services.callbacks.isEmpty());
  }
}
