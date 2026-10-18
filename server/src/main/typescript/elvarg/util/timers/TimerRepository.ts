import { TimerKey } from '../timers/TimerKey'
import { Timer } from '../timers/Timer'



export class TimerRepository {
    private timer: Map<TimerKey, Timer> | null = null;

    public has(key: TimerKey): boolean {
        const timer = this.timer?.get(key);
        if (!timer) {
            return false;
        }
        return timer.ticks() > 0;
    }

    public register(timer: Timer) {
        this.timers().set(timer.key(), timer);
    }
    
    public registerTimerKey(key: TimerKey): void {
        this.timers().set(key, new Timer(key, key.getTicks()));
    }


    public left(key: TimerKey): number {
        const timer = this.timer?.get(key);
        return timer ? timer.ticks() : 0;
    }

    public willEndIn(key: TimerKey, ticks: number): boolean {
        const timer = this.timer?.get(key);
        if (!timer) {
            return true;
        }
        return timer.ticks() <= ticks;
    }


    public getTicks(key: TimerKey): number {
        const timer = this.timer?.get(key);
        if (!timer) {
            return 0;
        }
        return timer.ticks();
    }

    public registers(key: TimerKey, ticks: number) {
        this.timers().set(key, new Timer(key, ticks));
    }

    public extendOrRegister(key: TimerKey, ticks: number) {
        const existing = this.timer?.get(key);
        this.timers().set(key, !existing || existing.ticks() < ticks ? new Timer(key, ticks) : existing);
    }
    public addOrSet(key: TimerKey, ticks: number) {
        const existing = this.timer?.get(key);
        this.timers().set(key, existing ? new Timer(key, existing.ticks() + ticks) : new Timer(key, ticks));
    }

    public cancel(name: TimerKey) {
        this.timer?.delete(name);
    }

    public process() {
        if (this.timer?.size > 0) {
            this.timer.forEach((timer: Timer) => {
                timer.tick();
            });
        }
    }

    public hasActive(): boolean {
        if (!this.timer) return false;
        for (const timer of this.timer.values()) if (timer.ticks() > 0) return true;
        return false;
    }

    public timers(): Map<TimerKey, Timer> {
        return this.timer ??= new Map();
    }
}
