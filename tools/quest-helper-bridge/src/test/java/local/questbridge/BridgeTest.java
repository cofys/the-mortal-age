package local.questbridge;

import static org.junit.jupiter.api.Assertions.*;

import com.google.gson.*;
import org.junit.jupiter.api.Test;

class BridgeTest {
  public static class TickCounter {
    int count;

    @net.runelite.client.eventbus.Subscribe
    public void onGameTick(net.runelite.api.events.GameTick event) {
      count++;
    }
  }

  static JsonObject snapshot() {
    return JsonParser.parseString(
            """
   {"hintArrowNpcIndex":-1,"varps":{},"varbits":{},"inventory":[],"equipment":[],"bank":[],
 "localPlayer":{"name":"fixture","x":3206,"y":3214,"plane":0},
 "skills":{},"npcs":[],"objects":[],"groundItems":[],"widgets":[],"baseX":3152,"baseY":3152,"plane":0,"tick":1}
""")
        .getAsJsonObject();
  }

  static JsonObject request(String session, int sequence, String quest) {
    JsonObject r = new JsonObject();
    r.addProperty("protocol", 1);
    r.addProperty("session", session);
    r.addProperty("sequence", sequence);
    r.addProperty("questKey", quest);
    r.add("snapshot", snapshot());
    JsonObject qs = new JsonObject();
    qs.addProperty(
        "" + com.questhelper.questinfo.QuestHelperQuest.COOKS_ASSISTANT.getId(), "NOT_STARTED");
    r.getAsJsonObject("snapshot").add("questStates", qs);
    r.add("events", new JsonArray());
    return r;
  }

  @Test
  void actualCookLifecycleChoosesBucketThenEggFromInventory() {
    try (var engine = new BridgeEngine()) {
      var req = request("cook", 1, "CooksAssistant");
      var result = engine.evaluate(req);
      assertEquals("active", result.get("status").getAsString(), result.toString());
      assertTrue(
          result.getAsJsonObject("activeStep").get("text").toString().contains("Purchase a bucket"),
          result.toString());
      req.addProperty("sequence", 2);
      req.getAsJsonObject("snapshot").addProperty("tick", 2);
      req.getAsJsonObject("snapshot")
          .add(
              "inventory",
              JsonParser.parseString(
                  "[{\"id\":1925,\"quantity\":1},{\"id\":1931,\"quantity\":1}]"));
      result = engine.evaluate(req);
      assertTrue(
          result.getAsJsonObject("activeStep").get("text").toString().contains("Grab an egg"),
          result.toString());
    }
  }

  @Test
  void unknownApiFailsExplicitly() {
    var adapter = new SnapshotClient(snapshot());
    var error = assertThrows(BridgeFailure.class, () -> adapter.client.getMenu());
    assertEquals("UNSUPPORTED_API", error.code);
  }

  @Test
  void sequenceMustIncreaseAtomically() {
    try (var engine = new BridgeEngine()) {
      var req = request("sequence", 1, "CooksAssistant");
      engine.evaluate(req);
      assertEquals(
          "STALE_SEQUENCE",
          engine
              .evaluate(req)
              .getAsJsonArray("diagnostics")
              .get(0)
              .getAsJsonObject()
              .get("code")
              .getAsString());
    }
  }

  @Test
  void nativeEventsAndDialogTypeArePreserved() {
    try (var engine = new BridgeEngine()) {
      var req = request("events", 1, "cooks_assistant");
      JsonObject npc =
          JsonParser.parseString(
                  "{\"id\":2813,\"index\":7,\"name\":\"Shopkeeper\",\"x\":3212,\"y\":3246,\"plane\":0}")
              .getAsJsonObject();
      req.getAsJsonObject("snapshot").getAsJsonArray("npcs").add(npc);
      int sequence = 1;
      for (String type :
          java.util.List.of(
              "npcSpawned",
              "npcDespawned",
              "npcChanged",
              "animationChanged",
              "interactingChanged",
              "overheadTextChanged",
              "widgetClosed",
              "itemContainerChanged",
              "itemSpawned",
              "itemDespawned",
              "itemQuantityChanged")) {
        JsonObject e = new JsonObject();
        e.addProperty("type", type);
        e.add("npc", npc);
        e.addProperty("oldId", 2813);
        e.addProperty("text", "Hi");
        e.addProperty("groupId", 219);
        e.addProperty("containerId", 93);
        e.addProperty("oldQuantity", 1);
        e.add(
            "item",
            JsonParser.parseString(
                "{\"id\":1944,\"quantity\":2,\"x\":3206,\"y\":3214,\"plane\":0}"));
        JsonArray events = new JsonArray();
        events.add(e);
        req.add("events", events);
        req.addProperty("sequence", sequence++);
        req.getAsJsonObject("snapshot").addProperty("tick", sequence);
        var result = engine.evaluate(req);
        assertEquals("active", result.get("status").getAsString(), type + ": " + result);
      }
      JsonArray events = new JsonArray();
      JsonObject chat = new JsonObject();
      chat.addProperty("type", "chatMessage");
      chat.addProperty("typeId", net.runelite.api.ChatMessageType.DIALOG.getType());
      chat.addProperty("message", "Here's a bucket of milk.");
      events.add(chat);
      req.add("events", events);
      req.addProperty("sequence", sequence);
      req.getAsJsonObject("snapshot").addProperty("tick", sequence + 1);
      var result = engine.evaluate(req);
      assertTrue(
          result.getAsJsonObject("activeStep").get("text").toString().contains("Purchase a pot"),
          result.toString());
    }
  }

  @Test
  void dispatchesActualGameTicksOnceAndSynthesizesOnlyWhenAbsent() {
    try (var engine = new BridgeEngine()) {
      var req = request("ticks", 1, "CooksAssistant");
      engine.evaluate(req);
      var counter = new TickCounter();
      engine.sessions.get("ticks").services.bus.register(counter);
      req.addProperty("sequence", 2);
      req.getAsJsonObject("snapshot").addProperty("tick", 2);
      req.add("events", JsonParser.parseString("[{\"type\":\"gameTick\",\"tick\":2}]"));
      engine.evaluate(req);
      assertEquals(1, counter.count);
      req.addProperty("sequence", 3);
      req.getAsJsonObject("snapshot").addProperty("tick", 3);
      req.add("events", new JsonArray());
      engine.evaluate(req);
      assertEquals(2, counter.count);
      req.addProperty("sequence", 4);
      req.getAsJsonObject("snapshot").addProperty("tick", 5);
      req.add(
          "events",
          JsonParser.parseString(
              "[{\"type\":\"gameTick\",\"tick\":4},{\"type\":\"gameTick\",\"tick\":5}]"));
      engine.evaluate(req);
      assertEquals(4, counter.count);
    }
  }
}
