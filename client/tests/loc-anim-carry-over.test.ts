import assert from "node:assert/strict";
import { LocAnimated } from "../render/loc/LocAnimated";

/** A loc playing `seqId` at one spot; only what carryOver and the constructor read. */
function loc(seqId: number, x = 10, cycle = 0): LocAnimated {
    const seqType: any = { id: seqId, frameStep: 1, frameIds: [1, 2, 3], frameLengths: [5, 5, 5], isSkeletalSeq: () => false };
    return new LocAnimated(0, 0, 0, 0, 0, 0, 0, 0, {} as any, seqType, cycle, false, 44776, x, 20, 0, 1);
}

// The Giants' Foundry crucible empties mid-pour: its square is rebuilt, and the pour goes on.
{
    const before = loc(9447);
    before.frame = 2;
    before.cycleStart = 40;
    const after = [loc(9447, 10, 300)];
    LocAnimated.carryOver([before], after);
    assert.equal(after[0].frame, 2, "the rebuilt loc keeps its frame");
    assert.equal(after[0].cycleStart, 40, "and its timing");
}

// Another sequence, or another loc, starts fresh.
{
    const before = loc(9447);
    before.frame = 2;
    const other = [loc(9449, 10, 300), loc(9447, 11, 300)];
    LocAnimated.carryOver([before], other);
    assert.equal(other[0].frame, 0, "a new sequence starts at its first frame");
    assert.equal(other[1].frame, 0, "a loc elsewhere starts at its first frame");
}

console.log("loc anim carry-over checks passed");
