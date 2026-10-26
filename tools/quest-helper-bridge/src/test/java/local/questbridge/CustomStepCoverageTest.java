package local.questbridge;

import static org.junit.jupiter.api.Assertions.*;

import com.google.gson.*;
import com.questhelper.questhelpers.BasicQuestHelper;
import com.questhelper.questinfo.QuestHelperQuest;
import com.questhelper.steps.*;
import java.nio.file.*;
import java.util.*;
import net.runelite.api.Skill;
import net.runelite.api.events.*;
import org.junit.jupiter.api.Test;

class CustomStepCoverageTest {
  @Test
  void everyReachableCustomStepRunsItsLifecycleEventsAndRenderer() throws Exception {
    JsonArray report = new JsonArray();
    Set<String> classes = new TreeSet<>();
    int fail = 0, pass = 0;
    try (var engine = new BridgeEngine()) {
      for (var route : engine.routes) {
        var row = route.getAsJsonObject();
        if (row.get("native").getAsBoolean()) continue;
        for (var variant : row.getAsJsonArray("variants")) {
          var info =
              QuestHelperQuest.valueOf(
                  variant.getAsJsonObject().get("helperVariant").getAsString());
          var request = BridgeTest.request(info.name(), 1, row.get("questKey").getAsString());
          request.addProperty("helperVariant", info.name());
          var s = request.getAsJsonObject("snapshot");
          var qs = new JsonObject();
          for (var q : QuestHelperQuest.values()) qs.addProperty("" + q.getId(), "IN_PROGRESS");
          s.add("questStates", qs);
          var v = new JsonObject();
          for (var f : net.runelite.api.gameval.VarbitID.class.getFields())
            if (f.getType() == int.class) v.addProperty("" + f.getInt(null), 0);
          v.addProperty("" + net.runelite.api.gameval.VarbitID.HUNDRED_MAIN_QUEST_VAR, 3);
          s.add("varbits", v);
          var skills = new JsonObject();
          for (Skill skill : Skill.values()) {
            var sk = JsonParser.parseString("{\"real\":99,\"boosted\":99,\"xp\":13034431}");
            skills.add(skill.name(), sk);
          }
          s.add("skills", skills);
          s.addProperty("weight", 0);
          s.getAsJsonObject("localPlayer").addProperty("combatLevel", 126);
          s.getAsJsonObject("localPlayer").addProperty("gender", 0);
          engine.evaluate(request);
          var session = engine.sessions.get(info.name());
          if (session == null || !(session.helper instanceof BasicQuestHelper basic)) continue;
          Set<QuestStep> steps = Collections.newSetFromMap(new IdentityHashMap<>());
          for (var st : basic.getStepList().values()) collect(st, steps);
          session.stop();
          for (var step : steps) {
            if (!step.getClass().getName().startsWith("com.questhelper.helpers.quests.")
                || !classes.add(step.getClass().getName())) continue;
            JsonObject record = new JsonObject();
            record.addProperty("class", step.getClass().getName());
            record.addProperty("questKey", row.get("questKey").getAsString());
            try (var projection = new SnapshotProjection(session.snapshot)) {
              validState(step, s, session);
              session.services.inject(step);
              step.startUp();
              session.services.bus.register(step);
              session.services.bus.post(new GameTick());
              session.services.bus.post(new VarbitChanged());
              session.services.flush();
              var output = session.overlays(step);
              record.addProperty("status", "pass");
              record.addProperty("overlayCommands", output.size());
              pass++;
            } catch (Throwable error) {
              fail++;
              record.addProperty("status", "fail");
              record.addProperty("error", error.toString());
            } finally {
              session.services.bus.unregister(step);
              try {
                step.shutDown();
              } catch (Exception ignored) {
              }
              session.services.callbacks.clear();
              session.services.eventErrors.clear();
            }
            report.add(record);
          }
          engine.closeSession(info.name());
        }
      }
    }
    Files.writeString(
        Path.of("coverage-custom-steps.json"),
        new GsonBuilder().setPrettyPrinting().create().toJson(report));
    System.out.println("CUSTOM STEPS " + pass + " pass " + fail + " fail");
    assertEquals(0, fail, "See coverage-custom-steps.json");
  }

  static void validState(QuestStep step, JsonObject s, BridgeEngine.Session session) {
    String name = step.getClass().getSimpleName();
    if (name.equals("GrowthPuzzleStep"))
      for (int n = 0; n < 6; n++)
        s.getAsJsonObject("varbits")
            .addProperty(
                "" + (net.runelite.api.gameval.VarbitID.DT2_SCAR_MAZE_1_RIFT_1 + n), n + 1);
    if (name.equals("TaverleyBalloonFlight")) {
      s.getAsJsonObject("varbits")
          .addProperty("" + net.runelite.api.gameval.VarbitID.ZEP_IF_CURRENT_MAP, 1);
      s.getAsJsonObject("varbits")
          .addProperty("" + net.runelite.api.gameval.VarbitID.ZEP_IF_BALLOON_HEIGHT, 5);
    }
    if (name.equals("TilePuzzleSolver")) {
      byte[] bits = new byte[(4 * 104 * 104 + 7) / 8];
      Arrays.fill(bits, (byte) 255);
      JsonObject packed = new JsonObject();
      packed.addProperty("encoding", "bitset-lsb-base64");
      packed.addProperty("data", Base64.getEncoder().encodeToString(bits));
      packed.add("shape", JsonParser.parseString("[4,104,104]"));
      JsonObject g = new JsonObject();
      g.add("loadedTilesPacked", packed);
      s.add("geometry", g);
    }
    if (name.equals("SelectingCombatGear")) {
      JsonObject parent = new JsonObject();
      parent.addProperty("id", net.runelite.api.gameval.InterfaceID.DreamArmour.BANK_LAYER);
      JsonObject child = new JsonObject();
      child.addProperty("id", net.runelite.api.gameval.InterfaceID.DreamArmour.BANK_LAYER);
      child.addProperty("itemId", 1149);
      child.add("bounds", JsonParser.parseString("{\"x\":0,\"y\":0,\"width\":32,\"height\":32}"));
      JsonArray children = new JsonArray();
      children.add(child);
      parent.add("children", children);
      JsonArray widgets = new JsonArray();
      widgets.add(parent);
      s.add("widgets", widgets);
    }
    session.snapshot.update(s);
  }

  static void collect(QuestStep step, Set<QuestStep> found) {
    if (step == null || !found.add(step)) return;
    if (step instanceof OwnerStep owner) for (var child : owner.getSteps()) collect(child, found);
    for (var child : step.getSubsteps()) collect(child, found);
  }
}
