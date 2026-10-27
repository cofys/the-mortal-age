/**
 * Which of an account's characters a save belongs to. Live OSRS keeps a separate character per
 * account on a Leagues world; here a world that runs a league (its plugin config) logs every
 * account into its league character, which lives in its own save, never as a flag on the main
 * one. Both share the account's name, so only one of them can be online at a time, as on live.
 */
export type PlayerProfile = "main" | "league";

export const MAIN_PROFILE: PlayerProfile = "main";
export const LEAGUE_PROFILE: PlayerProfile = "league";

/** The account's other character: the one whose save vouches for a login of a character not made yet. */
export function siblingProfile(profile: PlayerProfile): PlayerProfile {
    return profile === MAIN_PROFILE ? LEAGUE_PROFILE : MAIN_PROFILE;
}


/**
 * A backend's key for a profile's save. The main profile keeps the plain (normalised) name; any
 * other is prefixed after normalisation, with a character normalisation never emits, so no real
 * account name can collide with it.
 */
export function profileStorageKey(normalizedUsername: string, profile: PlayerProfile = MAIN_PROFILE): string {
    return profile === MAIN_PROFILE ? normalizedUsername : `${profile}:${normalizedUsername}`;
}
