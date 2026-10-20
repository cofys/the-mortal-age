import { GraphicHeight } from "../GraphicHeight";
import { Priority } from "../Priority";
import { Graphic } from "../Graphic";
import { Animation } from "../Animation";
import { Sound } from "../../Sound";

/** What some teleports do besides their animations (from OSRS captures). */
export interface TeleportTypeOptions {
    /** Played on the cast instead of the spell teleport sound. */
    sound?: Sound;
    /** Varbit busy (12393) is 1 from the cast until arrival. */
    busy?: boolean;
    /** The end animation is sent again the tick after arrival. */
    repeatEndAnimation?: boolean;
}

/** An animation with both a client delay and a priority. */
function delayed(id: number, delay: number, priority: Priority): Animation {
    const animation = new Animation(id, delay);
    animation.priority = priority;
    return animation;
}

export class TeleportType {
    // Spellbooks
    // Standard spellbook teleport: arms wide (714, human_castteleport) on cast, the bubble
    // (308) flashing mid-teleport, 715 (human_castteleport_reverse) on landing 3 ticks after
    // cast. The anim/graphic/sound ids and the landing tick are as captured for the skull
    // sceptre's shared standard teleport (docs/stronghold-of-security.md).
    // The bubble must not fire with the arms: 714 rises first, so a same-tick bubble reads as
    // coming first (seen in game). Fired from TeleportTask's middle step (T+1) with a 15-cycle
    // client delay, the flash lands at ~T+1.5, clear of the arms and ahead of departure. The 15
    // is tuned to that window, not captured.
    // Start tick 4 (not 3): TeleportTask runs steps 0 and 1 on the cast tick, so the
    // arrival step lands a tick later than its number (see TELE_TAB below).
    public static readonly NORMAL = new TeleportType(4, new Animation(714, Priority.HIGH), null, new Animation(715, Priority.HIGH), null, new Graphic(308, 15, GraphicHeight.HIGH), null);
    public static readonly ANCIENT = new TeleportType(5, new Animation(1979, Priority.HIGH), null, Animation.DEFAULT_RESET_ANIMATION, new Graphic(392, GraphicHeight.LOW, Priority.HIGH), null, null);
    public static readonly LUNAR = new TeleportType(4, new Animation(1816, Priority.HIGH), null, new Animation(715, Priority.HIGH), new Graphic(308, GraphicHeight.LOW, Priority.HIGH), null, null);
    public static readonly ARCEUUS = new TeleportType(4, new Animation(1816, Priority.HIGH), null, new Animation(715, Priority.HIGH), new Graphic(747, GraphicHeight.HIGH, Priority.HIGH), null, null);
    // Ladders
    public static readonly LADDER_DOWN = new TeleportType(1, new Animation(827, Priority.HIGH), null, Animation.DEFAULT_RESET_ANIMATION, null, null, null);
    public static readonly LADDER_UP = new TeleportType(1, new Animation(828, Priority.HIGH), null, Animation.DEFAULT_RESET_ANIMATION, null, null, null);
    // Misc
    public static readonly LEVER = new TeleportType(3, new Animation(2140, Priority.HIGH), new Animation(714), new Animation(715, Priority.HIGH), null, new Graphic(308, 0, GraphicHeight.HIGH), null);
    /**
     * Teleport tablets, as in an OSRS capture (docs/teleport-tablets.md): the tablet is smashed
     * (4069, sound 965), absorbed two ticks later (4071 and spotanim 678), and the player lands
     * on the fourth tick. TeleportTask runs its steps 0 and 1 both on the click's tick (once when
     * submitted, once in that tick's task pass), so step n falls on tick n - 1: start tick 5
     * lands on the fourth tick, and the middle step (5 - 2) on the second.
     */
    public static readonly TELE_TAB = new TeleportType(
        5,
        delayed(4069, 16, Priority.HIGH),
        new Animation(4071, Priority.HIGH),
        Animation.DEFAULT_RESET_ANIMATION,
        null,
        new Graphic(678, GraphicHeight.LOW, Priority.HIGH),
        null,
        { sound: new Sound(965, 1, 15, 0), busy: true, repeatEndAnimation: true },
    );
    public static readonly PURO_PURO = new TeleportType(9, new Animation(6601, Priority.HIGH), null, Animation.DEFAULT_RESET_ANIMATION, new Graphic(1118, GraphicHeight.LOW, Priority.HIGH), null, null);

    private readonly startAnim: Animation;
    private readonly middleAnim: Animation;
    private readonly endAnim: Animation;
    private readonly startGraphic: Graphic;
    private readonly middleGraphic: Graphic;
    private readonly endGraphic: Graphic;
    private readonly startTick: number;
    private readonly options: TeleportTypeOptions;

    constructor(
        startTick: number,
        startAnim: Animation,
        middleAnim: Animation,
        endAnim: Animation,
        startGraphic: Graphic,
        middleGraphic: Graphic,
        endGraphic: Graphic,
        options: TeleportTypeOptions = {}
    ) {
        this.options = options;
        this.startTick = startTick;
        this.startAnim = startAnim;
        this.middleAnim = middleAnim;
        this.endAnim = endAnim;
        this.startGraphic = startGraphic;
        this.middleGraphic = middleGraphic;
        this.endGraphic = endGraphic;
    }

    getStartAnimation(): Animation {
        return this.startAnim;
    }

    getEndAnimation(): Animation {
        return this.endAnim;
    }

    getStartGraphic(): Graphic {
        return this.startGraphic;
    }

    getEndGraphic(): Graphic {
        return this.endGraphic;
    }

    getStartTick(): number {
        return this.startTick;
    }

    getMiddleAnim(): Animation {
        return this.middleAnim;
    }

    getMiddleGraphic(): Graphic {
        return this.middleGraphic;
    }

    getOptions(): TeleportTypeOptions {
        return this.options;
    }
}

