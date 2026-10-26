package local.questbridge;

import static org.junit.jupiter.api.Assertions.*;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

class SidebarExportTest {
  static JsonObject cook(String session, int sequence) {
    return BridgeTest.request(session, sequence, "CooksAssistant");
  }

  @Test
  void exportsOverviewSectionsAndOverlayPanel() {
    try (var engine = new BridgeEngine()) {
      var result = engine.evaluate(cook("sidebar", 1));
      assertEquals("active", result.get("status").getAsString(), result.toString());
      var overview = result.getAsJsonObject("overview");
      assertEquals("Cook's Assistant", overview.get("name").getAsString());
      assertEquals("NOVICE", overview.get("difficulty").getAsString());
      assertTrue(overview.get("wikiUrl").getAsString().startsWith("https://oldschool.runescape.wiki/"));
      var items = overview.getAsJsonArray("itemRequirements");
      assertEquals(3, items.size(), overview.toString());
      assertEquals("fail", items.get(0).getAsJsonObject().get("state").getAsString());
      assertTrue(overview.getAsJsonArray("rewards").size() > 0);
      var sections = result.getAsJsonArray("sections");
      assertTrue(sections.size() > 0);
      var first = sections.get(0).getAsJsonObject();
      assertTrue(first.get("active").getAsBoolean(), sections.toString());
      assertEquals(1, first.getAsJsonArray("steps").asList().stream()
          .filter(st -> st.getAsJsonObject().get("active").getAsBoolean()).count());
      var step = new com.questhelper.steps.NpcStep(engine.sessions.get("sidebar").helper, 80, "Talk.");
      step.addDialogStep("Yes.");
      var rules = engine.sessions.get("sidebar").export(step).getAsJsonArray("choiceRules");
      assertEquals(1, rules.size());
      var rule = rules.get(0).getAsJsonObject();
      assertEquals(219, rule.get("groupId").getAsInt());
      assertEquals("Yes.", rule.get("text").getAsString());
      assertTrue(rule.get("number").getAsBoolean());
      var lines = result.getAsJsonArray("overlayPanel");
      assertEquals("Cook's Assistant", lines.get(0).getAsJsonObject().get("left").getAsString(), lines.toString());
    }
  }

  @Test
  void catalogCarriesUpstreamOrderingFields() {
    try (var engine = new BridgeEngine()) {
      var cook =
          engine.catalog().getAsJsonArray("quests").asList().stream()
              .map(q -> q.getAsJsonObject())
              .filter(q -> q.get("questKey").getAsString().equals("cooks_assistant"))
              .findFirst()
              .orElseThrow();
      assertEquals("F2P", cook.get("questType").getAsString());
      assertEquals("NOVICE", cook.get("difficulty").getAsString());
      assertTrue(cook.has("releaseOrder") && cook.has("optimalOrder") && cook.has("ironmanOrder"));
      assertEquals(1, cook.get("questPoints").getAsInt());
      assertTrue(cook.getAsJsonArray("filterSkills").toString().contains("Cooking"), cook.toString());
    }
  }

  @Test
  void forwardsClientConfigToUpstreamConfig() {
    try (var engine = new BridgeEngine()) {
      var req = cook("config", 1);
      req.add(
          "config",
          JsonParser.parseString(
              "{\"solvePuzzles\":false,\"passColour\":" + 0xff112233 + ",\"nested\":{}}"));
      engine.evaluate(req);
      var config = engine.sessions.get("config").services.config;
      assertFalse(config.solvePuzzles());
      assertEquals(0x112233, config.passColour().getRGB() & 0xffffff);
      assertTrue(config.showWidgetHints());
      engine.evaluate(cook("config", 2));
      assertTrue(config.solvePuzzles());
    }
  }

  @Test
  void rejectsLockingAnUnknownSection() {
    try (var engine = new BridgeEngine()) {
      engine.evaluate(cook("lock", 1));
      var req = cook("lock", 2);
      req.add("lockSection", JsonParser.parseString("{\"section\":999,\"locked\":true}"));
      var result = engine.evaluate(req);
      assertEquals(
          "INVALID_SECTION",
          result.getAsJsonArray("diagnostics").get(0).getAsJsonObject().get("code").getAsString());
    }
  }
}
