import { SecondsTimer } from "../../model/SecondsTimer";

export interface PoisonClockState {
    counter: number;
    ticksUntilPulse: number;
    briefPoisonSeconds?: number;
    briefVenomSeconds?: number;
}

/** Shared player status pulse. Advancing it is owned by CombatPoisonEffect. */
export class PoisonClock extends SecondsTimer {
    public static readonly PERIOD_TICKS = 30;
    public static readonly PERIOD_SECONDS = 18;
    public static readonly VENOM_CUTOFF = 38;
    private counter = 0;
    private ticksUntilPulse = PoisonClock.PERIOD_TICKS;
    private readonly briefPoison = new SecondsTimer();
    private readonly briefVenom = new SecondsTimer();
    private startingSeconds = 0;

    constructor(private readonly ensureTask: () => void) { super(); }

    /** A dose changes the counter, never the phase of an existing pulse. */
    public start(seconds: number): void {
        if (!Number.isFinite(seconds) || seconds <= 0) { this.stop(); return; }
        this.counter = Math.ceil(seconds / PoisonClock.PERIOD_SECONDS);
        this.startingSeconds = seconds;
        this.ensureTask();
    }

    /** Separate short flags, e.g. equipment/food; neither replace a dose nor cure. */
    public protectBriefly(seconds: number, venom = false): void {
        if (!Number.isFinite(seconds) || seconds <= 0) return;
        if (this.briefPoison.secondsRemaining() < seconds) this.briefPoison.start(seconds);
        if (venom && this.briefVenom.secondsRemaining() < seconds) this.briefVenom.start(seconds);
    }

    public getCounter(): number { return this.counter; }
    public hasCounter(): boolean { return this.counter > 0; }
    public clearCounter(): void { this.counter = 0; }
    public isVenomImmune(): boolean {
        return this.counter > PoisonClock.VENOM_CUTOFF || !this.briefVenom.finished();
    }

    /** Count towards one deadline while modal; retain only one overdue pulse. */
    public tickPulse(modal: boolean): boolean {
        this.ticksUntilPulse = Math.max(0, this.ticksUntilPulse - 1);
        if (modal || this.ticksUntilPulse > 0) return false;
        this.ticksUntilPulse = PoisonClock.PERIOD_TICKS;
        if (this.counter > 0) this.counter--;
        return true;
    }

    public resetPhase(): void { this.ticksUntilPulse = PoisonClock.PERIOD_TICKS; }
    public stop(): void {
        this.counter = 0;
        this.briefPoison.stop();
        this.briefVenom.stop();
    }
    public finished(): boolean { return this.counter === 0 && this.briefPoison.finished(); }
    public isRunning(): boolean { return !this.finished(); }
    public secondsRemaining(): number {
        const dose = this.counter > 0
            ? Math.ceil((this.counter - 1) * PoisonClock.PERIOD_SECONDS + this.ticksUntilPulse * 0.6)
            : 0;
        return Math.max(dose, this.briefPoison.secondsRemaining());
    }
    public secondsElapsed(): number { return Math.max(0, this.startingSeconds - this.secondsRemaining()); }

    public snapshot(): PoisonClockState {
        const state: PoisonClockState = { counter: this.counter, ticksUntilPulse: this.ticksUntilPulse };
        const briefPoisonSeconds = this.briefPoison.secondsRemaining();
        const briefVenomSeconds = this.briefVenom.secondsRemaining();
        if (briefPoisonSeconds > 0) state.briefPoisonSeconds = briefPoisonSeconds;
        if (briefVenomSeconds > 0) state.briefVenomSeconds = briefVenomSeconds;
        return state;
    }

    public restore(state: PoisonClockState | undefined, legacySeconds = 0): void {
        this.stop(); this.resetPhase();
        if (state && Number.isSafeInteger(state.counter) && state.counter >= 0 &&
            state.counter <= Number.MAX_SAFE_INTEGER / PoisonClock.PERIOD_TICKS &&
            Number.isInteger(state.ticksUntilPulse) && state.ticksUntilPulse >= 0 &&
            state.ticksUntilPulse <= PoisonClock.PERIOD_TICKS &&
            (state.briefPoisonSeconds === undefined || (Number.isFinite(state.briefPoisonSeconds) && state.briefPoisonSeconds >= 0)) &&
            (state.briefVenomSeconds === undefined || (Number.isFinite(state.briefVenomSeconds) && state.briefVenomSeconds >= 0 &&
                state.briefVenomSeconds <= (state.briefPoisonSeconds ?? 0)))) {
            this.counter = state.counter;
            this.ticksUntilPulse = state.ticksUntilPulse;
            if (state.briefPoisonSeconds) this.briefPoison.start(state.briefPoisonSeconds);
            if (state.briefVenomSeconds) this.briefVenom.start(state.briefVenomSeconds);
        } else if (Number.isFinite(legacySeconds) && legacySeconds > 0) {
            // Old saves knew only whole seconds; exact historical phase is unavailable.
            if (legacySeconds <= 2) this.protectBriefly(legacySeconds);
            else {
                this.counter = Math.ceil(legacySeconds / PoisonClock.PERIOD_SECONDS);
                this.ticksUntilPulse = Math.min(PoisonClock.PERIOD_TICKS,
                    Math.ceil((legacySeconds - (this.counter - 1) * PoisonClock.PERIOD_SECONDS) / 0.6));
            }
        }
        this.startingSeconds = this.secondsRemaining();
        if (this.counter > 0) this.ensureTask();
    }
}
