package local.questbridge;

import static org.junit.jupiter.api.Assertions.*;

import com.google.gson.*;
import com.questhelper.helpers.quests.biohazard.GiveIngredientsToHelpersStep;
import net.runelite.api.gameval.*;
import org.junit.jupiter.api.Test;

class BiohazardInteractionTest {
  static void injectGraph(
      BridgeEngine.Session s,
      com.questhelper.steps.QuestStep step,
      java.util.Set<com.questhelper.steps.QuestStep> visited) {
    if (step == null || !visited.add(step)) return;
    s.services.inject(step);
    if (step instanceof com.questhelper.steps.OwnerStep o)
      for (var child : o.getSteps()) injectGraph(s, child, visited);
    for (var child : step.getSubsteps()) injectGraph(s, child, visited);
  }

  @Test
  void localPlayerInteractionsSelectAllThreeRealBiohazardHelpers() {
    try (var engine = new BridgeEngine()) {
      var request = BridgeTest.request("chemicals", 1, "CooksAssistant");
      var state = request.getAsJsonObject("snapshot");
      state.getAsJsonObject("localPlayer").addProperty("interactingIndex", -1);
      state.getAsJsonObject("localPlayer").addProperty("index", 1);
      JsonArray inventory = new JsonArray();
      for (int id : new int[] {ItemID.SULPHURIC_BROLINE, ItemID.LIQUID_HONEY, ItemID.ETHENEA}) {
        JsonObject item = new JsonObject();
        item.addProperty("id", id);
        item.addProperty("quantity", 1);
        inventory.add(item);
      }
      state.add("inventory", inventory);
      JsonArray npcs = new JsonArray();
      int index = 10;
      for (int id : new int[] {NpcID.DRUNK1, NpcID.GAMBLER1, NpcID.ARTIST1}) {
        JsonObject npc = new JsonObject();
        npc.addProperty("id", id);
        npc.addProperty("index", index++);
        npc.addProperty("name", "Helper");
        npc.addProperty("x", 3210);
        npc.addProperty("y", 3220);
        npc.addProperty("plane", 0);
        npcs.add(npc);
      }
      state.add("npcs", npcs);
      engine.evaluate(request);
      var session = engine.sessions.get("chemicals");
      var actual = new GiveIngredientsToHelpersStep(session.helper);
      injectGraph(
          session, actual, java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>()));
      actual.startUp();
      session.services.bus.register(actual);
      session.services.flush();
      int sequence = 1;
      for (var choice :
          java.util.List.of(
              new Object[] {11, "Chancy"},
              new Object[] {12, "Da Vinci"},
              new Object[] {10, "Hops"})) {
        var next = state.deepCopy();
        next.addProperty("tick", ++sequence);
        next.getAsJsonObject("localPlayer").addProperty("interactingIndex", (Integer) choice[0]);
        request.addProperty("sequence", sequence);
        request.add("snapshot", next);
        var result = engine.evaluate(request);
        assertEquals("active", result.get("status").getAsString(), result.toString());
        assertTrue(
            actual.getActiveStep().getText().toString().contains((String) choice[1]),
            actual.getActiveStep().getText().toString());
        state = next;
      }
    }
  }
}
