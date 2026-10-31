package gateway.down

import gateway.tsps.TspsPacket
import gateway.tsps.TspsServerPacket
import gateway.tsps.TspsWriter
import net.rsprot.protocol.common.game.outgoing.inv.InventoryObject
import net.rsprot.protocol.game.outgoing.inv.UpdateInvFull
import net.rsprot.protocol.game.outgoing.misc.player.MessageGame
import net.rsprot.protocol.game.outgoing.misc.player.RunClientScript
import net.rsprot.protocol.message.OutgoingGameMessage

/**
 * Trading. tsps opens the real trade interfaces (335 offer, 334 confirm, 336 inventory) and
 * writes their text itself, but sends the two offers in its own TRADE_OPEN/UPDATE packet and
 * takes the player's moves as the browser's TRADE_ACTION. The offers become inventory 90 (and
 * 90 as the other player's, the 0x8000 "invother" form); the trade buttons become TRADE_ACTION.
 */
class Trade(
    private val send: (OutgoingGameMessage) -> Unit,
    private val sendTsps: (ByteArray) -> Unit,
    /** How many of an item the player carries, for Offer-All. */
    private val carried: (Int) -> Int,
) {
    private var ownOffer = emptyList<Offer>()
    private var pendingX: (Int) -> Unit = {}
    private var awaitingCount = false

    private class Offer(val slot: Int, val item: Int, val quantity: Int)

    fun handle(packet: TspsPacket): Boolean {
        val reader = packet.reader()
        when (packet.opcode) {
            TspsServerPacket.TRADE_OPEN, TspsServerPacket.TRADE_UPDATE -> {
                reader.string() // session
                reader.u8() // stage: the interfaces tsps opens say which
                reader.string() // info
                ownOffer = party(reader)
                val theirs = party(reader)
                send(UpdateInvFull(OFFER_INVENTORY, OFFER_SIZE) { slot -> pack(ownOffer, slot) })
                send(UpdateInvFull(OFFER_INVENTORY or INV_OTHER, OFFER_SIZE) { slot -> pack(theirs, slot) })
            }
            TspsServerPacket.TRADE_CLOSE -> {
                ownOffer = emptyList()
                // An Offer-X/Remove-X amount never given mustn't take the next count dialog's.
                awaitingCount = false
                reader.string().takeIf { it.isNotEmpty() }?.let { send(MessageGame(GAME_MESSAGE, it)) }
            }
            // tsps also sends the request as a game message (type 101), which OSRS uses.
            TspsServerPacket.TRADE_REQUEST -> Unit
            else -> return false
        }
        return true
    }

    /** A trade interface button; false when it isn't one. */
    fun button(combinedId: Int, sub: Int, obj: Int, op: Int): Boolean {
        when (combinedId) {
            OFFER_ACCEPT -> action(ACCEPT)
            OFFER_DECLINE, CONFIRM_DECLINE, CONFIRM_CLOSE -> action(DECLINE)
            CONFIRM_ACCEPT -> action(CONFIRM_ACCEPT_ACTION)
            INVENTORY_SIDE -> move(OFFER, sub, obj, op) { carried(obj) }
            OWN_OFFER -> move(REMOVE, sub, obj, op) { ownOffer.filter { it.item == obj }.sumOf { it.quantity } }
            else -> return false
        }
        return true
    }

    /** An Offer-X/Remove-X amount; false when no amount was asked for. */
    fun count(amount: Int): Boolean {
        if (!awaitingCount) return false
        awaitingCount = false
        pendingX(amount)
        return true
    }

    private fun move(action: Int, slot: Int, item: Int, op: Int, all: () -> Int) {
        when (op) {
            1 -> trade(action, slot, item, 1)
            2 -> trade(action, slot, item, 5)
            3 -> trade(action, slot, item, 10)
            4 -> trade(action, slot, item, all())
            5 -> {
                // The browser asks for the amount itself; OSRS has the server open the count dialog.
                awaitingCount = true
                pendingX = { amount -> trade(action, slot, item, amount) }
                send(RunClientScript(COUNT_DIALOG_SCRIPT, listOf("Enter amount:")))
            }
        }
    }

    private fun trade(action: Int, slot: Int, item: Int, quantity: Int) {
        if (quantity <= 0) return
        sendTsps(TspsWriter().u8(action).u16(slot).i32(quantity).u16(item).varByte(TRADE_ACTION))
    }

    private fun action(action: Int) = sendTsps(TspsWriter().u8(action).u16(0).i32(0).u16(0xFFFF).varByte(TRADE_ACTION))

    /** `encodeTradeParty`: s16 player, name, u8 accepted, u8 confirm accepted, u8 n, n × (u16 slot, u16 item, i32 qty). */
    private fun party(reader: gateway.tsps.TspsReader): List<Offer> {
        reader.s16()
        reader.string()
        reader.u8()
        reader.u8()
        return List(reader.u8()) { Offer(reader.u16(), reader.u16(), reader.i32()) }
    }

    private fun pack(offers: List<Offer>, slot: Int): Long =
        offers.firstOrNull { it.slot == slot }?.let { InventoryObject(it.item, it.quantity) } ?: InventoryObject.NULL

    private companion object {
        const val TRADE_ACTION = 180
        const val OFFER = 0
        const val REMOVE = 1
        const val ACCEPT = 2
        const val DECLINE = 3
        const val CONFIRM_ACCEPT_ACTION = 4

        const val OFFER_INVENTORY = 90
        const val INV_OTHER = 0x8000
        const val OFFER_SIZE = 28
        const val GAME_MESSAGE = 0
        const val COUNT_DIALOG_SCRIPT = 108

        const val OFFER_ACCEPT = (335 shl 16) or 10
        const val OFFER_DECLINE = (335 shl 16) or 13
        const val OWN_OFFER = (335 shl 16) or 25
        const val CONFIRM_ACCEPT = (334 shl 16) or 13
        const val CONFIRM_DECLINE = (334 shl 16) or 14
        const val CONFIRM_CLOSE = (334 shl 16) or 32
        const val INVENTORY_SIDE = 336 shl 16
    }
}
