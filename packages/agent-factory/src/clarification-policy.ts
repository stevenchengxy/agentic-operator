export interface ClarificationOption {
  label: string;
  value: string;
  recommended?: boolean;
}

export interface ClarificationTimeoutResolution {
  action: "suspend";
  answer: null;
  message: string;
}

export type ClarificationOptionsResult =
  | { ok: true; options: ClarificationOption[] | undefined }
  | { ok: false; error: string };

/** Validate the interaction shape before it reaches the user. Free-text
 * questions may omit options; a choice question must be small, unambiguous and
 * have exactly one clearly identified recommendation. */
export function normalizeClarificationOptions(
  value: unknown,
): ClarificationOptionsResult {
  if (value === undefined || value === null) return { ok: true, options: undefined };
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) {
    return { ok: false, error: "选项需要 2 到 4 个；如果要用户自由填写，就不要传 options。" };
  }
  const options: ClarificationOption[] = [];
  const values = new Set<string>();
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: `第 ${index + 1} 个选项格式不对。` };
    }
    const row = raw as Record<string, unknown>;
    const label = typeof row.label === "string" ? row.label.trim() : "";
    const optionValue = typeof row.value === "string" ? row.value.trim() : "";
    if (!label || !optionValue) {
      return { ok: false, error: `第 ${index + 1} 个选项缺少清楚的 label 或 value。` };
    }
    if (values.has(optionValue)) {
      return { ok: false, error: `选项 value 重复：${optionValue}` };
    }
    values.add(optionValue);
    options.push({ label, value: optionValue, recommended: row.recommended === true });
  }
  if (options.filter((option) => option.recommended).length !== 1) {
    return { ok: false, error: "有选项时必须且只能标一个 recommended:true。" };
  }
  return { ok: true, options };
}

/**
 * A recommendation helps a person decide; it is not consent.
 *
 * Keep this as a pure policy seam so every caller (ontology questions,
 * credentials and side-effect probes included) shares the same fail-closed
 * timeout behavior. Options are accepted deliberately and never selected.
 */
export function resolveClarificationTimeout(
  _options: ClarificationOption[] | undefined,
): ClarificationTimeoutResolution {
  return {
    action: "suspend",
    answer: null,
    message:
      "⏸ 这个问题还需要你本人确认。当前运行已安全挂起，不会自动选择推荐项；回复后可以从这里继续。",
  };
}
