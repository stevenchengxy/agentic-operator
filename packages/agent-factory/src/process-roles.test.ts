import { describe, it, expect } from "vitest";
import { roleOfTool, ROLE_OF_TOOL } from "./process-roles";
import { FACTORY_TOOLS } from "./tools";

// #ROLE — 角色属于【生成过程中的 agents】。完备性不变量：每个工厂工具都要有过程角色
// （新工具入列时必须补角色——这是显示元数据的质量约束，不是运行时阻断：roleOfTool 对
// 未登记名返回 undefined，UI 优雅省略）。

describe("process roles (#ROLE 过程角色)", () => {
  it("every FACTORY_TOOL has a process role registered", () => {
    const missing = FACTORY_TOOLS.map((t) => t.name).filter((n) => !roleOfTool(n));
    expect(missing).toEqual([]);
  });

  it("spawn/inline sub-agents are OPEN vocabulary (no registry lookup needed)", () => {
    // 动态子大脑的角色由 AI spawn 时自动设定——不查注册表；未登记名 → undefined（不阻断）。
    expect(roleOfTool("某个未来的新工具")).toBeUndefined();
  });

  it("registry names are short human-readable Chinese role titles", () => {
    for (const role of Object.values(ROLE_OF_TOOL)) {
      expect(role.length).toBeGreaterThanOrEqual(2);
      expect(role.length).toBeLessThanOrEqual(10);
    }
  });
});
