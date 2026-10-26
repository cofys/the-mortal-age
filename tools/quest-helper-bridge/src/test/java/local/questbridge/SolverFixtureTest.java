package local.questbridge;

import static org.junit.jupiter.api.Assertions.*;

import com.google.gson.*;
import com.questhelper.helpers.quests.deserttreasureii.GolemPuzzleStep;
import net.runelite.api.gameval.InterfaceID;
import net.runelite.api.gameval.VarbitID;
import org.junit.jupiter.api.Test;

class SolverFixtureTest {
  @Test
  void realGolemSolverHighlightsSwapSquaresAndArrow() throws Exception {
    try (var engine = new BridgeEngine()) {
      var req = BridgeTest.request("golem", 1, "CooksAssistant");
      engine.evaluate(req);
      var session = engine.sessions.get("golem");
      var state = req.getAsJsonObject("snapshot");
      JsonArray children = new JsonArray();
      for (int n = 0; n < 64; n++) {
        JsonObject w = new JsonObject();
        w.addProperty("id", InterfaceID.Dt2WarmindPuzzle.SQUARES);
        w.addProperty("index", n);
        w.add(
            "bounds",
            JsonParser.parseString(
                "{\"x\":"
                    + (n % 8 * 20)
                    + ",\"y\":"
                    + (n / 8 * 20)
                    + ",\"width\":20,\"height\":20}"));
        children.add(w);
      }
      JsonObject wrapper = new JsonObject();
      wrapper.addProperty("id", InterfaceID.Dt2WarmindPuzzle.SQUARES);
      wrapper.add("children", children);
      JsonArray widgets = new JsonArray();
      widgets.add(wrapper);
      state.add("widgets", widgets);
      state.getAsJsonObject("varbits").addProperty("" + VarbitID.DT2_WARMIND_CELL_POS_0, 0);
      session.snapshot.update(state);
      var solver = new GolemPuzzleStep(session.helper);
      session.services.inject(solver);
      solver.startUp();
      JsonArray output = session.overlays(solver);
      assertEquals(6, output.size(), output.toString());
      assertEquals("path", output.get(0).getAsJsonObject().get("kind").getAsString());
      var arrow = output.get(5).getAsJsonObject();
      assertEquals(4, arrow.getAsJsonArray("path").size());
    }
  }

  @Test
  void unknownWidgetApiDoesNotMutateSnapshot() {
    var state = BridgeTest.snapshot();
    JsonObject w = new JsonObject();
    w.addProperty("id", 1);
    state.getAsJsonArray("widgets").add(w);
    var snapshot = new SnapshotClient(state);
    assertThrows(
        BridgeFailure.class, () -> snapshot.client.getWidget(1).setText("no player action"));
  }
}
