/**
 * Agent 工厂 — 「系统全景」派生层（两套系统总纲的实时投影，架构书 §1.5）。
 *
 * deriveSystemA：把 BrainEvent 流投影成系统 A（生成系统）的活体地图——
 *   协调者行（意图门 / 本体理解 / 能力解析 / 当前阶段）+ 七个内部工作角色卡
 *   （理解/规划/设计/验证/试运行/资产/交付），每个角色带四枚能力徽章：
 *   ⚙ CodeAct（写码/驱动执行）· 🧩 派生 sub-agents · 🔧 造工具 · 🛠 造技能，
 *   以及自己的过程切片（View transcript）。归因规则：spawn/造物事件归属于
 *   「当时未收口的工具调用」所属角色（事件流是顺序的，工具执行期间的冒泡都算它的）。
 *
 * groupFunctions：把交付物（agent 卡片）分组成系统 B 视图——父 function 带
 *   自己的 -sub- 子函数（交付域 sub-agents，slug 约定 `${parent}-sub-…`）。
 *
 * PURE + 自包含（不 import 别名路径）——可被 tsx 脚本直接喂真实 SSE 事件回放测试。
 */

import type { Translate } from "../../../lib/preferences-context";

export type SysBrainEvent = { t: string; [k: string]: unknown };

export type RoleId = "understand" | "plan" | "design" | "verify" | "sandbox" | "asset" | "deliver";

export interface RoleItem {
  id: string;
  kind: "tool" | "spawn" | "make" | "code";
  label: string;
  detail?: string;
  ok?: boolean;
}

export interface RoleCard {
  id: RoleId;
  name: string;
  status: "running" | "ok" | "idle" | "error";
  toolCalls: number;
  badges: { codeact: number; spawns: number; tools: number; skills: number };
  transcript: RoleItem[];
}

export interface SystemAView {
  /** 意图门最新一条（含追加链的最后一行）。 */
  intent?: string;
  /** understand_ontology 的消化结论摘要。 */
  understanding?: string;
  /** capability_resolve 的选型结论摘要。 */
  capability?: string;
  stage?: string;
  roles: RoleCard[];
  specialists: number;
  subbrains: number;
}

const ROLE_OF_TOOL: Record<string, RoleId> = {
  read_ontology: "understand", understand_ontology: "understand", list_domains: "understand",
  describe_domain: "understand", describe_object: "understand", describe_design_constraints: "understand",
  capability_resolve: "understand",
  create_plan: "plan", critique_plan: "plan", propose_boundary_events: "plan",
  design_agent: "design", design_subagent: "design", codegen_agent: "design", refine_agent: "design",
  revert_refine: "design", score_spec: "design", diff_spec: "design", read_spec: "design", create_mock_agent: "design",
  validate_graph: "verify", verify_chain: "verify", generate_test_cases: "verify", supply_test_data: "verify",
  sandbox_run: "sandbox", inspect_run: "sandbox",
  create_tool: "asset", create_skill: "asset", use_skill: "asset", search_tools: "asset",
  fetch_doc: "asset", extract_api_schema: "asset", web_search: "asset",
  review_agent: "deliver", review_context: "deliver", review_completeness: "deliver",
  list_agents: "deliver", analyze_failure: "deliver", finish: "deliver", generate_report: "deliver",
};

export const ROLE_META: Record<RoleId, { nameKey: string; hintKey: string }> = {
  understand: {
    nameKey: "factory.systemView.role.understand.name",
    hintKey: "factory.systemView.role.understand.hint",
  },
  plan: {
    nameKey: "factory.systemView.role.plan.name",
    hintKey: "factory.systemView.role.plan.hint",
  },
  design: {
    nameKey: "factory.systemView.role.design.name",
    hintKey: "factory.systemView.role.design.hint",
  },
  verify: {
    nameKey: "factory.systemView.role.verify.name",
    hintKey: "factory.systemView.role.verify.hint",
  },
  sandbox: {
    nameKey: "factory.systemView.role.sandbox.name",
    hintKey: "factory.systemView.role.sandbox.hint",
  },
  asset: {
    nameKey: "factory.systemView.role.asset.name",
    hintKey: "factory.systemView.role.asset.hint",
  },
  deliver: {
    nameKey: "factory.systemView.role.deliver.name",
    hintKey: "factory.systemView.role.deliver.hint",
  },
};

const s = (v: unknown): string => (v == null ? "" : String(v));
const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

export function deriveSystemA(
  t: Translate,
  events: SysBrainEvent[],
  running: boolean,
): SystemAView {
  const roles = new Map<RoleId, RoleCard>();
  for (const id of Object.keys(ROLE_META) as RoleId[]) {
    roles.set(id, {
      id,
      name: t(ROLE_META[id].nameKey),
      status: "idle",
      toolCalls: 0,
      badges: { codeact: 0, spawns: 0, tools: 0, skills: 0 },
      transcript: [],
    });
  }
  const lastIdxOf = new Map<RoleId, number>();
  let intent: string | undefined;
  let understanding: string | undefined;
  let capability: string | undefined;
  let stage: string | undefined;
  let specialists = 0;
  let subbrains = 0;
  let idc = 0;
  const nid = () => `sv-${idc++}`;

  // 归因栈：当前未收口的工具调用（id → role）。spawn/造物事件冒泡归它。
  const openCalls = new Map<string, RoleId>();
  let currentRole: RoleId | null = null;
  const roleErr = new Map<RoleId, boolean>();

  events.forEach((e, idx) => {
    switch (e.t) {
      case "tool.call": {
        const role = ROLE_OF_TOOL[s(e.name)];
        if (!role) break;
        const rc = roles.get(role)!;
        rc.toolCalls++;
        rc.transcript.push({ id: nid(), kind: "tool", label: s(e.name), detail: clip(s(e.reasoning), 110) });
        if (s(e.name) === "codegen_agent") rc.badges.codeact++;
        openCalls.set(s(e.id), role);
        currentRole = role;
        lastIdxOf.set(role, idx);
        break;
      }
      case "tool.result": {
        const role = openCalls.get(s(e.id));
        if (!role) break;
        openCalls.delete(s(e.id));
        const rc = roles.get(role)!;
        const last = [...rc.transcript].reverse().find((x) => x.kind === "tool" && x.ok === undefined);
        if (last) last.ok = Boolean(e.ok);
        if (e.ok === false) roleErr.set(role, true);
        lastIdxOf.set(role, idx);
        if (openCalls.size === 0) currentRole = null;
        break;
      }
      case "subagent.start": {
        const task = s(e.task);
        const isSpecialist = task.startsWith("认知专家");
        if (isSpecialist) specialists++;
        else subbrains++;
        const role = currentRole ?? "understand";
        const rc = roles.get(role)!;
        rc.badges.spawns++;
        rc.transcript.push({
          id: nid(),
          kind: "spawn",
          label: isSpecialist
            ? t("factory.systemView.transcript.spawnSpecialist", {
                name: task.replace(/^认知专家 · /, ""),
              })
            : t("factory.systemView.transcript.spawnSubbrain"),
          detail: isSpecialist ? undefined : clip(task, 90),
        });
        lastIdxOf.set(role, idx);
        break;
      }
      case "tool.created": {
        const role = currentRole ?? "asset";
        const rc = roles.get(role)!;
        rc.badges.tools++;
        rc.transcript.push({
          id: nid(),
          kind: "make",
          label: t("factory.systemView.transcript.toolCreated", {
            name: s(e.name),
          }),
          detail: clip(s(e.description), 90),
          ok: true,
        });
        lastIdxOf.set(role, idx);
        break;
      }
      case "skill.created": {
        const role = currentRole ?? "asset";
        const rc = roles.get(role)!;
        rc.badges.skills++;
        rc.transcript.push({
          id: nid(),
          kind: "make",
          label: t("factory.systemView.transcript.skillCreated", {
            name: s(e.name),
          }),
          detail: clip(s(e.purpose), 90),
          ok: true,
        });
        lastIdxOf.set(role, idx);
        break;
      }
      case "code": {
        const rc = roles.get("design")!;
        if (s(e.codeSource) === "llm") rc.badges.codeact++;
        rc.transcript.push({
          id: nid(),
          kind: "code",
          label: t("factory.systemView.transcript.codeGenerated", {
            source: s(e.codeSource) || "render",
          }),
          detail: s(e.actionName),
          ok: true,
        });
        lastIdxOf.set("design", idx);
        break;
      }
      case "sandbox": {
        const rc = roles.get("sandbox")!;
        const simulated = Boolean(e.simulated);
        const ok =
          !simulated &&
          (Boolean(e.fullChainRan) || Boolean(e.reachedSuccessTerminal));
        // A historical simulated event is diagnostic data, not a CodeAct
        // execution or successful sandbox capability.
        if (!simulated) rc.badges.codeact++;
        rc.transcript.push({
          id: nid(),
          kind: "code",
          label: simulated
            ? t("factory.systemView.transcript.simulatedRecord")
            : t("factory.systemView.transcript.realSandbox"),
          detail: t("factory.systemView.transcript.sandboxDetail", {
            registered: s(e.functionsRegistered ?? 0),
            ran: s(e.ran ?? 0),
          }),
          ok,
        });
        if (ok) roleErr.delete("sandbox");
        else roleErr.set("sandbox", true);
        lastIdxOf.set("sandbox", idx);
        break;
      }
      case "reflect": {
        const kind = s(e.kind);
        const lesson = s(e.lesson);
        if (kind === "intent") intent = lesson.replace(/^意图理解：/, "");
        else if (kind === "understanding") understanding = clip(lesson.replace(/^本体理解[^：]*：/, ""), 200);
        else if (kind === "capability") capability = clip(lesson.replace(/^能力解析：/, ""), 200);
        break;
      }
      case "stage": {
        if (s(e.status) === "active") stage = s(e.stage);
        break;
      }
    }
  });

  const lastIdx = events.length - 1;
  for (const rc of roles.values()) {
    const li = lastIdxOf.get(rc.id);
    rc.status =
      li === undefined ? "idle"
      : roleErr.get(rc.id) ? "error"
      : running && lastIdx - li < 12 ? "running"
      : "ok";
    rc.transcript = rc.transcript.slice(-80);
  }

  return { intent, understanding, capability, stage, roles: [...roles.values()], specialists, subbrains };
}

// ── 系统 B：交付 functions 分组（父 function + 其 -sub- 交付域子函数）────────────────

export interface FunctionGroup<A> {
  parent: A;
  children: A[];
}

export function groupFunctions<A extends { slug: string }>(agents: A[]): FunctionGroup<A>[] {
  const parents = agents.filter((a) => !a.slug.includes("-sub-"));
  const claimed = new Set<string>();
  const groups = parents.map((parent) => {
    const children = agents.filter((a) => a.slug.startsWith(`${parent.slug}-sub-`));
    children.forEach((c) => claimed.add(c.slug));
    return { parent, children };
  });
  // 孤儿 -sub-（父不在本次事件流里）也别丢——各自成组，诚实呈现。
  for (const a of agents) {
    if (a.slug.includes("-sub-") && !claimed.has(a.slug)) groups.push({ parent: a, children: [] });
  }
  return groups;
}
