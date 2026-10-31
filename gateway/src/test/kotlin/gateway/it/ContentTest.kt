package gateway.it

import gateway.cache.VarTypes
import gateway.headless.HeadlessClient
import gateway.headless.TestCache
import net.rsprox.protocol.game.outgoing.model.info.npcinfo.NpcInfo
import net.rsprox.protocol.game.outgoing.model.info.npcinfo.NpcUpdateType
import net.rsprox.protocol.game.outgoing.model.info.playerinfo.PlayerInfo
import net.rsprox.protocol.game.outgoing.model.info.playerinfo.PlayerUpdateType
import net.rsprox.protocol.game.outgoing.model.interfaces.IfOpenSub
import net.rsprox.protocol.game.outgoing.model.interfaces.IfSetText
import net.rsprox.protocol.game.outgoing.model.map.RebuildLoginV2
import net.rsprox.protocol.game.outgoing.model.misc.client.ServerTickEnd
import net.rsprox.protocol.game.outgoing.model.misc.player.UpdateStatV2
import net.rsprox.protocol.game.outgoing.model.varp.VarpLarge
import net.rsprox.protocol.game.outgoing.model.varp.VarpSmall
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test

/** Everyday content through the official client's own interfaces: dialogues, prayers, spells. */
class ContentTest {
    private val vars = VarTypes(TestCache.cache)

    @Test
    fun `an npc dialogue continues and takes an option`() {
        LiveGateway.login(developer()).use { game ->
            game.expect<RebuildLoginV2>()
            game.command("tele $GUIDE_X $GUIDE_Z 0")
            var guide = -1
            var options = 0
            val lines = ArrayList<String>()
            var ticks = 0
            while (ticks < DIALOGUE_TICKS && lines.none { it == ANSWER }) {
                when (val message = game.next() ?: error("stream ended")) {
                    is ServerTickEnd -> if (++ticks == SETTLE_TICKS) game.npcOp1(guide)
                    is NpcInfo ->
                        message.updates.forEach { (index, update) ->
                            if (update is NpcUpdateType.LowResolutionToHighResolution && update.id == LUMBRIDGE_GUIDE) guide = index
                        }
                    // The chatbox's npc and player lines continue on component 5; 219 lists the options.
                    is IfOpenSub ->
                        when (message.interfaceId) {
                            NPC_LINE, PLAYER_LINE -> game.resume(message.interfaceId, CONTINUE)
                            OPTIONS -> if (options++ == 0) game.resume(OPTIONS, OPTION_LIST, QUEST_OPTION)
                        }
                    is IfSetText -> if (message.componentId == LINE_TEXT) lines += message.text
                }
            }
            assertTrue(guide >= 0, "the Lumbridge Guide is in view")
            assertTrue(options > 0, "the guide offers options")
            assertTrue(ANSWER in lines, "the chosen option is said, then answered: $lines")
        }
    }

    @Test
    fun `a prayer turns on and off from the prayer tab`() {
        LiveGateway.login(developer()).use { game ->
            game.expect<RebuildLoginV2>()
            val varps = HashMap<Int, Int>()
            game.ticks(SETTLE_TICKS, varps)
            game.button(PRAYER_TAB, THICK_SKIN)
            game.ticks(2, varps)
            assertEquals(1, varbit(varps, THICK_SKIN_VARBIT), "Thick Skin is on")
            game.button(PRAYER_TAB, THICK_SKIN)
            game.ticks(2, varps)
            assertEquals(0, varbit(varps, THICK_SKIN_VARBIT), "and off again")
        }
    }

    @Test
    fun `a teleport spell from the spellbook takes the player there`() {
        LiveGateway.login(developer()).use { game ->
            game.expect<RebuildLoginV2>()
            var magic = 0
            game.command("tele $GUIDE_X $GUIDE_Z 0")
            game.ticks(SETTLE_TICKS) { if (it is UpdateStatV2 && it.stat == MAGIC) magic = it.currentLevel }
            if (magic < VARROCK_TELEPORT_LEVEL) game.command("setlevel magic $VARROCK_TELEPORT_LEVEL")
            for ((rune, count) in VARROCK_TELEPORT_RUNES) game.command("item $rune $count")
            game.ticks(2)
            game.button(SPELLBOOK, VARROCK_TELEPORT)
            var at: Pair<Int, Int>? = null
            game.ticks(TELEPORT_TICKS) { message ->
                val update = (message as? PlayerInfo)?.updates?.get(game.index) as? PlayerUpdateType.HighResolutionMovement
                if (update != null) at = update.coord.x to update.coord.z
            }
            val (x, z) = requireNotNull(at) { "the player never moved" }
            assertTrue(kotlin.math.abs(x - VARROCK_X) <= LANDING && kotlin.math.abs(z - VARROCK_Z) <= LANDING, "landed at $x,$z, not in Varrock")
        }
    }

    private fun developer(): String {
        val developer = LiveGateway.developerName
        assumeTrue(developer != null, "DEV_USERNAME isn't set; the tests teleport and spawn runes")
        return developer!!
    }

    private fun varbit(varps: Map<Int, Int>, id: Int): Int {
        val bit = requireNotNull(vars.varbit(id))
        return ((varps[bit.varp] ?: 0) ushr bit.lsb) and ((1 shl (bit.msb - bit.lsb + 1)) - 1)
    }

    private fun HeadlessClient.Game.ticks(count: Int, varps: MutableMap<Int, Int>? = null, each: (Any) -> Unit = {}) {
        var seen = 0
        while (seen < count) {
            val message = next() ?: error("stream ended")
            each(message)
            when (message) {
                is ServerTickEnd -> seen++
                is VarpSmall -> varps?.put(message.id, message.value)
                is VarpLarge -> varps?.put(message.id, message.value)
            }
        }
    }

    private companion object {
        const val SETTLE_TICKS = 4
        const val DIALOGUE_TICKS = 20

        /** The Lumbridge Guide stands still at 3238,3220 (npc-spawns.json); this is in front of him. */
        const val LUMBRIDGE_GUIDE = 306
        const val GUIDE_X = 3236
        const val GUIDE_Z = 3220
        const val NPC_LINE = 231
        const val PLAYER_LINE = 217
        const val OPTIONS = 219
        const val OPTION_LIST = 1
        const val CONTINUE = 5
        const val LINE_TEXT = 6
        const val QUEST_OPTION = 1
        const val ANSWER = "Where can I find a quest to go on?"

        const val PRAYER_TAB = 541
        const val THICK_SKIN = 9
        const val THICK_SKIN_VARBIT = 4104

        const val SPELLBOOK = 218
        const val VARROCK_TELEPORT = 26
        const val VARROCK_TELEPORT_LEVEL = 25
        const val MAGIC = 6

        /** Law, air and fire runes. */
        val VARROCK_TELEPORT_RUNES = listOf(563 to 1, 556 to 3, 554 to 1)
        const val VARROCK_X = 3212
        const val VARROCK_Z = 3424
        const val LANDING = 6
        const val TELEPORT_TICKS = 10
    }
}
