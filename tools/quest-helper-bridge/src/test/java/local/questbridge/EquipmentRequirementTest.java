package local.questbridge;

import static org.junit.jupiter.api.Assertions.*;

import com.google.gson.*;
import com.questhelper.questhelpers.BasicQuestHelper;
import com.questhelper.questinfo.QuestHelperQuest;
import com.questhelper.requirements.item.*;
import com.questhelper.steps.*;
import net.runelite.api.gameval.*;
import org.junit.jupiter.api.Test;

class EquipmentRequirementTest {
  static JsonObject fixture() {
    var state = BridgeTest.snapshot();
    var qs = new JsonObject();
    for (var q : QuestHelperQuest.values()) qs.addProperty("" + q.getId(), "NOT_STARTED");
    state.add("questStates", qs);
    var bits = new JsonObject();
    for (var f : VarbitID.class.getFields())
      try {
        if (f.getType() == int.class) bits.addProperty("" + f.getInt(null), 0);
      } catch (IllegalAccessException e) {
        throw new RuntimeException(e);
      }
    state.add("varbits", bits);
    state.getAsJsonObject("localPlayer").addProperty("gender", 0);
    state.getAsJsonObject("localPlayer").addProperty("combatLevel", 126);
    var skills = new JsonObject();
    for (var skill : net.runelite.api.Skill.values())
      skills.add(
          skill.name(), JsonParser.parseString("{\"real\":99,\"boosted\":99,\"xp\":13034431}"));
    state.add("skills", skills);
    return state;
  }

  @Test
  void realMonkeyMadnessGreegreeAndForgettableTaleEmptyHandsRequirementsUseNativeSlots()
      throws Exception {
    try (var engine = new BridgeEngine()) {
      var state = fixture();
      state.add(
          "equipment",
          JsonParser.parseString(
              "[{\"id\":"
                  + ItemID.MM_MONKEY_GREEGREE_FOR_NORMAL_MONKEY
                  + ",\"quantity\":1,\"slot\":3}]"));
      var monkey = engine.new Session("monkey", "MONKEY_MADNESS_I", state);
      monkey.containers();
      monkey.helper.init();
      var greegree =
          (ItemRequirement) BridgeEngine.field(monkey.helper, "karamjanGreegreeEquipped");
      assertTrue(greegree.check(monkey.snapshot.client));
      java.util.Set<QuestStep> steps =
          java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());
      for (var step : ((BasicQuestHelper) monkey.helper).getStepList().values())
        CustomStepCoverageTest.collect(step, steps);
      NoItemRequirement weaponEmpty = null;
      for (var step : steps)
        if (step instanceof DetailedQuestStep d
            && d.getText() != null
            && d.getText().toString().contains("UNEQUIP the greegree"))
          for (var r : d.getRequirements()) if (r instanceof NoItemRequirement n) weaponEmpty = n;
      assertNotNull(weaponEmpty);
      assertFalse(weaponEmpty.check(monkey.snapshot.client));
      var noEquipment = state.deepCopy();
      noEquipment.add("equipment", new JsonArray());
      noEquipment.addProperty("tick", 2);
      monkey.snapshot.update(noEquipment);
      monkey.containers();
      assertTrue(weaponEmpty.check(monkey.snapshot.client));
      var tale = engine.new Session("tale", "FORGETTABLE_TALE", state);
      tale.containers();
      tale.helper.init();
      var handsFree = (NoItemRequirement) BridgeEngine.field(tale.helper, "handsFree");
      assertFalse(handsFree.check(tale.snapshot.client));
      tale.snapshot.update(noEquipment);
      tale.containers();
      assertTrue(handsFree.check(tale.snapshot.client));
    }
  }
}
