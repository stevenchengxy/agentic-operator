/**
 * Declarative cross-field rules for a tool's non-secret runtime config.
 *
 * These rules intentionally describe relationships between catalog fields;
 * validators must not branch on a tool/vendor name.  Rule values are limited
 * to JSON primitives so definition identities remain deterministic.
 */
export type ToolConfigConditionValue = string | number | boolean | null;

export interface ToolConfigKeyGroupRule {
  /** Config-schema keys participating in this rule. */
  keys: string[];
  /** Optional catalog-authored, user-facing explanation. */
  message?: string;
}

export interface ToolConfigRequiredUnlessRule {
  /** Keys that are required whenever the exception does not match. */
  keys: string[];
  unless: {
    key: string;
    equals: ToolConfigConditionValue;
  };
  /** Optional catalog-authored, user-facing explanation. */
  message?: string;
}

export interface ToolConfigContract {
  /** At least one key in each group must contain a non-empty value. */
  atLeastOne?: ToolConfigKeyGroupRule[];
  /** At most one key in each group may contain a non-empty value. */
  mutuallyExclusive?: ToolConfigKeyGroupRule[];
  /** Require every listed key unless the declared field equals a value. */
  requiredUnless?: ToolConfigRequiredUnlessRule[];
}
