package local.questbridge;

import static org.junit.jupiter.api.Assertions.*;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

/** What the bridge hands the client's Shortest Path and Bank Tags based features. */
class IntegrationsExportTest {
  static JsonObject cook(String session, int sequence, boolean useShortestPath) {
    var req = BridgeTest.request(session, sequence, "CooksAssistant");
    req.add("config", JsonParser.parseString("{\"useShortestPath\":" + useShortestPath + "}"));
    return req;
  }

  static JsonArray messages(JsonObject result) {
    return result.getAsJsonArray("pluginMessages");
  }

  @Test
  void forwardsUpstreamShortestPathMessages() {
    try (var engine = new BridgeEngine()) {
      var off = engine.evaluate(cook("sp", 1, false));
      assertEquals("active", off.get("status").getAsString(), off.toString());
      assertEquals(0, messages(off).size(), "nothing while the option is off");

      // Turning it on asks Shortest Path for a route from the player to the step's point.
      var on = engine.evaluate(cook("sp", 2, true));
      assertEquals(1, messages(on).size(), on.toString());
      var path = messages(on).get(0).getAsJsonObject();
      assertEquals("shortestpath", path.get("namespace").getAsString());
      assertEquals("path", path.get("name").getAsString());
      var data = path.getAsJsonObject("data");
      var target = data.getAsJsonObject("target");
      var step = on.getAsJsonObject("activeStep").getAsJsonArray("targets").get(0).getAsJsonObject();
      assertEquals(step.get("x").getAsInt(), target.get("x").getAsInt(), "the step's defined point");
      assertEquals(step.get("y").getAsInt(), target.get("y").getAsInt());
      assertTrue(data.getAsJsonObject("start").has("x"), "the player's location");

      assertEquals(0, messages(engine.evaluate(cook("sp", 3, true))).size(), "sent once, not every evaluation");

      // Turning it off clears the route.
      var cleared = engine.evaluate(cook("sp", 4, false));
      assertEquals(1, messages(cleared).size(), cleared.toString());
      assertEquals("clear", messages(cleared).get(0).getAsJsonObject().get("name").getAsString());
    }
  }

  @Test
  void startingWithTheOptionOnSendsTheFirstStepsRoute() {
    try (var engine = new BridgeEngine()) {
      var result = engine.evaluate(cook("sp-start", 1, true));
      assertEquals(1, messages(result).size(), result.toString());
      assertEquals("path", messages(result).get(0).getAsJsonObject().get("name").getAsString());
    }
  }

  @Test
  void exportsAStepsGrandExchangeItems() throws Exception {
    try (var engine = new BridgeEngine()) {
      engine.evaluate(cook("ge", 1, false));
      var session = engine.sessions.get("ge");
      var step = new com.questhelper.steps.NpcStep(session.helper, 80, "Buy it.");
      assertFalse(session.export(step).has("geItems"), "none unless the step names some");
      var field = com.questhelper.steps.QuestStep.class.getDeclaredField("geInterfaceIcon");
      field.setAccessible(true);
      field.set(step, java.util.List.of(net.runelite.api.gameval.ItemID.EGG));
      assertEquals("[" + net.runelite.api.gameval.ItemID.EGG + "]", session.export(step).get("geItems").toString());
    }
  }

  @Test
  void exportsTheQuestBankTabWhenAsked() {
    try (var engine = new BridgeEngine()) {
      var without = engine.evaluate(cook("bank", 1, false));
      assertFalse(without.has("bankTab"), "only while the bank is open");

      var req = cook("bank", 2, false);
      req.addProperty("bankTab", true);
      var result = engine.evaluate(req);
      var bankTab = result.getAsJsonObject("bankTab");
      assertNotNull(bankTab, result.toString());
      var sections = bankTab.getAsJsonArray("sections");
      assertTrue(sections.size() > 0, bankTab.toString());
      var names = new java.util.ArrayList<String>();
      var displayIds = new java.util.ArrayList<Integer>();
      for (var s : sections) {
        names.add(s.getAsJsonObject().get("name").getAsString());
        for (var item : s.getAsJsonObject().getAsJsonArray("items"))
          displayIds.add(item.getAsJsonObject().get("displayId").getAsInt());
      }
      // Cook's Assistant needs an egg, a bucket of milk and a pot of flour.
      for (int id : new int[] {net.runelite.api.gameval.ItemID.EGG, net.runelite.api.gameval.ItemID.BUCKET_MILK, net.runelite.api.gameval.ItemID.POT_FLOUR})
        assertTrue(displayIds.contains(id), "item " + id + " in " + bankTab);
      var item = sections.get(0).getAsJsonObject().getAsJsonArray("items").get(0).getAsJsonObject();
      assertTrue(item.has("met") && item.has("quantity") && item.has("text"), item.toString());
      // The snapshot's player carries none of them: all are missing (the GE search).
      var missing = bankTab.getAsJsonArray("missingItems");
      assertTrue(missing.size() >= 3, missing.toString());
    }
  }
}
