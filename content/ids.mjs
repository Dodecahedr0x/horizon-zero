// Id names shared by every client, indexed by the byte the engine uses (the `#[repr(u8)]` enums in
// crates/combat/src/ids.rs). Plain module, no imports: the studio serves it to the browser as is.

// Cast effects and aims, as catalog.json writes them.
export const EFFECTS = ["none", "push", "sprint", "reach", "taunt", "heal"];
export const AIMS = ["chosen", "foe", "ally", "self"];
// Effects that stay on a unit for `rounds` rounds.
export const LASTING_EFFECTS = ["sprint", "reach", "taunt"];

export const SIDE_A = 0;
export const SIDE_B = 1;

/** The effect name for a trace byte, or "none" for an unknown one. */
export function effectName(id) {
  return EFFECTS[id] ?? "none";
}
