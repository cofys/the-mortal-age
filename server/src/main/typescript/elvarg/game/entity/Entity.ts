// Avoid heavy imports at module init to prevent circular bootstrap.
import type { Animation } from '../../game/model/Animation';
import type { Graphic } from '../../game/model/Graphic';
import { Location } from '../../game/model/Location';
import type { Area } from '../../game/model/areas/Area';
import { GameConstants } from '../../game/GameConstants';

export abstract class Entity {
    /**
     * Represents the {@link Location} of this {@link Entities}.
     */
    private location: Location = (GameConstants?.DEFAULT_LOCATION?.clone?.() ?? new Location(0, 0));
    private area: Area | null = null;
    private flags: Set<string> | null = null;
    /**
     * The Entities constructor.
     *
     * @param position The position the entity is currently in.
     */
    constructor(position: Location) {
        this.location = position;
    }


    /**
     * Performs an {@link Animation}.
     * @param animation
     */
    abstract performAnimation(animation: Animation): void;

    /**
     * Performs a {@link Graphic}.
     * @param animation
     */
    abstract performGraphic(graphic: Graphic): void;

    /**
     * Returns the size of this {@link Entities}.
     */
    abstract getSize(): number;

    /**
     * Gets the entity position.
     *
     * @return the entity's world position
     */
    getLocation(): Location {
        return this.location;
    }

    /**
     * Sets the entity position
     *
     * @param location the world position
     */
    setLocation(location: Location): Entity {
        this.location = location;
        return this;
    }
    public setArea(area: Area): void {
        this.area = area;
    }

    public getArea(): Area {
        return this.area;
    }

    public getPrivateArea(): any {
        return typeof (this.area as any)?.getObjects === "function" ? this.area : null;
    }

    public hasFlag(flag: string): boolean {
        return typeof flag === "string" && (this.flags?.has(flag) ?? false);
    }

    public setFlag(flag: string, enabled = true): this {
        if (typeof flag !== "string") {
            return this;
        }
        const normalized = flag.trim();
        if (normalized.length === 0) {
            return this;
        }
        if (enabled) {
            (this.flags ??= new Set<string>()).add(normalized);
        } else {
            this.flags?.delete(normalized);
            if (this.flags?.size === 0) this.flags = null;
        }
        return this;
    }

    public removeFlag(flag: string): this {
        return this.setFlag(flag, false);
    }

    public getFlags(): string[] {
        return this.flags ? Array.from(this.flags) : [];
    }

    public setFlags(flags: Iterable<string> | null | undefined): this {
        this.flags = null;
        if (flags == null) {
            return this;
        }
        for (const flag of flags) {
            this.setFlag(flag, true);
        }
        return this;
    }

    public clearFlags(): this {
        this.flags = null;
        return this;
    }
}
