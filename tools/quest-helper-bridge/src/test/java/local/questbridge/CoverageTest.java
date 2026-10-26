package local.questbridge;

import static org.junit.jupiter.api.Assertions.*;

import com.google.gson.*;
import com.questhelper.questinfo.QuestHelperQuest;
import java.nio.file.*;
import net.runelite.api.Skill;
import org.junit.jupiter.api.Test;

class CoverageTest {
  @Test
  void everyMappedHelperInitializesAndEvaluatesWithoutUnknownApis() throws Exception {
    JsonArray report = new JsonArray();
    int failed = 0, passed = 0;
    try (var engine = new BridgeEngine()) {
      for (JsonElement route : engine.routes) {
        var row = route.getAsJsonObject();
        if (row.get("native").getAsBoolean()) continue;
        for (JsonElement variant : row.getAsJsonArray("variants")) {
          var info =
              QuestHelperQuest.valueOf(
                  variant.getAsJsonObject().get("helperVariant").getAsString());
          JsonObject request =
              BridgeTest.request(info.name(), 1, row.get("questKey").getAsString());
          request.addProperty("helperVariant", info.name());
          request
              .getAsJsonObject("snapshot")
              .getAsJsonObject("localPlayer")
              .addProperty("combatLevel", 126);
          request
              .getAsJsonObject("snapshot")
              .getAsJsonObject("localPlayer")
              .addProperty("gender", 0);
          JsonObject s = request.getAsJsonObject("snapshot"),
              qs = new JsonObject(),
              varbits = new JsonObject(),
              skills = new JsonObject();
          for (var q : QuestHelperQuest.values()) qs.addProperty("" + q.getId(), "NOT_STARTED");
          s.add("questStates", qs);
          for (var f : net.runelite.api.gameval.VarbitID.class.getFields())
            if (f.getType() == int.class) varbits.addProperty("" + f.getInt(null), 0);
          s.add("varbits", varbits);
          for (Skill skill : Skill.values()) {
            JsonObject sk = new JsonObject();
            sk.addProperty("real", 99);
            sk.addProperty("boosted", 99);
            sk.addProperty("xp", 13034431);
            skills.add(skill.name(), sk);
          }
          s.add("skills", skills);
          var result = engine.evaluate(request);
          if (result.get("status").getAsString().equals("active")
              || result.get("status").getAsString().equals("complete")) passed++;
          else failed++;
          JsonObject record = new JsonObject();
          record.addProperty("questKey", row.get("questKey").getAsString());
          record.addProperty("variant", info.name());
          record.add("result", result);
          report.add(record);
          try {
            engine.closeSession(info.name());
          } catch (Exception e) {
            failed++;
          }
        }
      }
    }
    Files.writeString(
        Path.of("coverage-initialization.json"),
        new GsonBuilder().setPrettyPrinting().create().toJson(report));
    System.out.println(
        "INITIALIZATION " + passed + " pass " + failed + " fail; coverage-initialization.json");
    assertEquals(
        0, failed, "Unknown APIs or missing fixture state; see coverage-initialization.json");
  }

  @Test
  void everyDeclaredQuestStageRunsAndExportsActualCustomSolverOutput() throws Exception {
    JsonArray report = new JsonArray();
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
            JsonObject sk = new JsonObject();
            sk.addProperty("real", 99);
            sk.addProperty("boosted", 99);
            sk.addProperty("xp", 13034431);
            skills.add(skill.name(), sk);
          }
          s.add("skills", skills);
          s.getAsJsonObject("localPlayer").addProperty("combatLevel", 126);
          s.getAsJsonObject("localPlayer").addProperty("gender", 0);
          s.addProperty("weight", 0);
          s.add("geometry", JsonParser.parseString("{\"width\":800,\"height\":600}"));
          engine.evaluate(request);
          var session = engine.sessions.get(info.name());
          if (session == null) continue;
          if (session.helper instanceof com.questhelper.questhelpers.BasicQuestHelper basic) {
            var states = new java.util.TreeSet<>(basic.getStepList().keySet());
            int seq = 1;
            for (int stage : states) {
              request.addProperty("sequence", ++seq);
              s.addProperty("tick", seq);
              var varbit = BridgeEngine.field(info, "varbit");
              var varp = BridgeEngine.field(info, "varPlayer");
              if (varbit != null)
                s.getAsJsonObject("varbits")
                    .addProperty(
                        "" + ((com.questhelper.questinfo.QuestVarbits) varbit).getId(), stage);
              if (varp != null)
                s.getAsJsonObject("varps")
                    .addProperty(
                        "" + ((com.questhelper.questinfo.QuestVarPlayer) varp).getId(), stage);
              var result = engine.evaluate(request);
              boolean ok = result.get("status").getAsString().equals("active");
              if (ok) pass++;
              else fail++;
              JsonObject r = new JsonObject();
              r.addProperty("questKey", row.get("questKey").getAsString());
              r.addProperty("variant", info.name());
              r.addProperty("stage", stage);
              r.add("status", result.get("status"));
              r.add("diagnostics", result.get("diagnostics"));
              r.add("requests", result.get("requests"));
              report.add(r);
            }
          }
          try {
            engine.closeSession(info.name());
          } catch (Exception ex) {
            fail++;
          }
        }
      }
    }
    Files.writeString(
        Path.of("coverage-stages.json"),
        new GsonBuilder().setPrettyPrinting().create().toJson(report));
    System.out.println("STAGES " + pass + " pass " + fail + " fail");
    assertEquals(0, fail, "See coverage-stages.json");
  }
}
