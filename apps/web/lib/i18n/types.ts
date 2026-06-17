/**
 * i18n types.
 *
 * A dictionary is an arbitrarily-nested object whose leaves are strings.
 * Keys are addressed by dot-path (e.g. `"nav.group.run"`). We keep the key
 * type as `string` rather than deriving a dotted-path union from the `en`
 * const: the runtime fallback (`active → en → key`) plus the parity test
 * (`en`/`zh` must share an identical key set) give the safety a generic
 * TS union would, without the type gymnastics.
 */

export type Language = "en" | "zh";

export interface Dict {
  [key: string]: string | Dict;
}
