/**
 * Prefixed ID generators per DESIGN.md convention: run-, evt-, agt-, dpl-,
 * tsk-, wf-, ten-. Uses crypto.randomUUID() for the suffix; takes 8 chars
 * to keep IDs short but collision-safe at portal scale.
 */

export type IdPrefix =
  | "run"
  | "evt"
  | "agt"
  | "dpl"
  | "tsk"
  | "wf"
  | "ten"
  | "usr"
  | "tok"
  | "art"
  | "stp"
  | "wfv"
  | "agv"
  | "aud"
  | "cor"
  | "inv"
  | "mdl"
  | "imp"
  | "iss"
  | "cnv"
  | "rfl"
  | "frn";

export function makeId(prefix: IdPrefix): string {
  const uuid = crypto.randomUUID().replace(/-/g, "");
  return `${prefix}-${uuid.slice(0, 12)}`;
}
