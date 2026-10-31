package gateway.down

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class ActorBlocksTest {
    @Test
    fun `an npc tint is read in the npc block's byte order`() {
        // tsps writeNpcUpdateBlock: say text, then the tint (start/end shortBEA, hue byteC,
        // saturation byteS, lightness byteC, weight byteS), then the spot anim count.
        val tint = byteArrayOf(0, (0 + 128).toByte(), 0, (50 + 128).toByte(), (-21).toByte(), (128 - 5).toByte(), 1, (128 - 90).toByte())
        val block = ActorBlocks.npcTint(BlockReader(tint))
        assertEquals(listOf(0, 50, 21, 5, 255, 90), listOf(block.start, block.end, block.hue, block.saturation, block.lightness, block.weight))
    }

    @Test
    fun `a chat style reads its pattern colours`() {
        val style = ChatStyle.read(gateway.tsps.TspsReader(byteArrayOf(14, 2, 3, 4)))!!
        assertEquals(14 to 2, style.colour to style.effect)
        assertEquals(listOf<Byte>(3, 4), style.pattern!!.toList())
        assertEquals(null, ChatStyle.read(gateway.tsps.TspsReader(byteArrayOf())), "builds that send none")
    }
}
