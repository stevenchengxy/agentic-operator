// #SKILL-EXPORT (P1-6) — serialize a factory LibrarySkill to the Agent Skills open standard
// (agentskills.io/specification, originally by Anthropic, released 2025-12 as an open format).
//
// Why: our skills live as rows (slug/purpose/promptFragment/tools/decisionRule). Exported as a
// spec-compliant SKILL.md folder they become assets that leave the factory — loadable by Claude
// Code / Agent SDK / any of the 40+ harnesses that adopted the format. Spec contract enforced
// here: name = 1-64 chars, lowercase alnum + hyphen, no leading/trailing/consecutive hyphens,
// MUST equal the parent directory name; description = 1-1024 chars and should say WHAT the skill
// does AND WHEN to use it (the description IS the discovery-stage routing signal).

export interface ExportableSkill {
  slug: string;
  name: string;
  purpose: string;
  promptFragment: string;
  tools: string[];
  decisionRule: string;
  domain?: string | null;
}

/** Spec-compliant name: 1-64 chars, [a-z0-9-], no edge/double hyphens. */
export function toSpecName(slug: string): string {
  const s = (slug || "skill")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return s || "skill";
}

export function isValidSpecName(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length >= 1 && name.length <= 64;
}

const yamlEscape = (s: string): string => JSON.stringify(s.replace(/\s+/g, " ").trim());

/** Render the SKILL.md content. The description carries BOTH what + when（spec 要求：description
 *  即路由信号）——purpose 提供 what，decisionRule 提供 when。Body = 可注入的指令片段 + 工具依赖。 */
export function renderSkillMd(skill: ExportableSkill): { dirName: string; skillMd: string } {
  const dirName = toSpecName(skill.slug);
  const what = (skill.purpose || skill.name || "").trim();
  const when = (skill.decisionRule || "").trim();
  const description = `${what}${when ? ` Use when: ${when}` : ""}`.slice(0, 1024);
  const fm = [
    "---",
    `name: ${dirName}`,
    `description: ${yamlEscape(description)}`,
    "metadata:",
    `  source: ${yamlEscape("agentic-operator factory")}`,
    ...(skill.domain ? [`  domain: ${yamlEscape(skill.domain)}`] : []),
    ...(skill.tools.length ? [`  factory-tools: ${yamlEscape(skill.tools.join(", "))}`] : []),
    "---",
  ].join("\n");
  const body = [
    `# ${skill.name || dirName}`,
    "",
    "## Instructions",
    "",
    skill.promptFragment.trim(),
    "",
    "## When to use",
    "",
    when || "(见 description)",
    ...(skill.tools.length
      ? ["", "## Tool dependencies", "", `This skill was authored against these factory registry tools: ${skill.tools.map((t) => `\`${t}\``).join(", ")}. In other harnesses, substitute equivalent capabilities.`]
      : []),
  ].join("\n");
  return { dirName, skillMd: `${fm}\n\n${body}\n` };
}

/** Spec lint (subset of `skills-ref validate`): returns violations, empty = pass. */
export function lintSkillExport(skill: ExportableSkill): string[] {
  const v: string[] = [];
  const dirName = toSpecName(skill.slug);
  if (!isValidSpecName(dirName)) v.push(`name「${dirName}」不符合规范（1-64 位小写字母数字与连字符）`);
  const desc = `${skill.purpose} ${skill.decisionRule}`.trim();
  if (!desc) v.push("description 为空（purpose + decisionRule 都缺）");
  if (desc.length > 1024) v.push("description 超过 1024 字符");
  if (!skill.promptFragment || skill.promptFragment.trim().length < 24) v.push("promptFragment 过短（<24 字符），不构成可用技能正文");
  return v;
}
