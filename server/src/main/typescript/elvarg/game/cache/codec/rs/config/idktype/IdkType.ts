import { ByteBuffer } from "../../io/ByteBuffer";
import { Type } from "../Type";

/**
 * An identity kit (a player body part: head, jaw, torso, ...). Only what the server needs to
 * choose kits is kept; every opcode is still read past.
 */
export class IdkType extends Type {
    /** 0-6 for a male body part (head, jaw, torso, arms, hands, legs, feet), 7-13 female. */
    bodyPartId = -1;

    /** Not offered in the character designer. */
    nonSelectable = false;

    override decodeOpcode(opcode: number, buffer: ByteBuffer): void {
        if (opcode === 1) {
            this.bodyPartId = buffer.readUnsignedByte();
        } else if (opcode === 2) {
            this.skip(buffer, buffer.readUnsignedByte() * 2);
        } else if (opcode === 3) {
            this.nonSelectable = true;
        } else if (opcode === 5) {
            this.skip(buffer, buffer.readUnsignedByte() * 4);
        } else if (opcode === 40 || opcode === 41) {
            this.skip(buffer, buffer.readUnsignedByte() * 4);
        } else if (opcode >= 60 && opcode < 70) {
            this.skip(buffer, 2);
        } else if (opcode >= 70 && opcode < 80) {
            this.skip(buffer, 4);
        } else {
            throw new Error("IdkType: Opcode " + opcode + " not implemented. id: " + this.id);
        }
    }

    /** Called with the length already read: `offset += read()` would add to the offset before the read. */
    private skip(buffer: ByteBuffer, length: number): void {
        buffer.offset += length;
    }
}
