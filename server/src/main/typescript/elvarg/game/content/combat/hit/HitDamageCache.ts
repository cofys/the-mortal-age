import { TickStopwatch } from "../../../../util/TickStopwatch";

export class HitDamageCache {
    private stopwatch: TickStopwatch;
    private damage: number;

    constructor(damage: number) {
        this.damage = damage;
        this.stopwatch = new TickStopwatch().reset();
    }

    public getDamage(): number {
        return this.damage;
    }

    public incrementDamage(damage: number): void {
        this.damage += damage;
        this.stopwatch.reset();
    }

    public getStopwatch(): number {
        return this.stopwatch.elapsed();
    }
}
