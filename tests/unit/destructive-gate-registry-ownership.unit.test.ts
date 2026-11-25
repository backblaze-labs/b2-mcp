import type * as Gate from "../../src/utils/destructive-gate";
import type { B2Config } from "../../src/utils/types";

let gate: typeof Gate;

beforeEach(async () => {
  vi.resetModules();
  gate = await import("../../src/utils/destructive-gate");
});

it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "not_a_tool"])(
  "does not treat the unregistered tool name %s as a destructive detector",
  (toolName) => {
    expect(gate.isDestructiveTool(toolName)).toBe(false);
    expect(gate.destructiveEffect(toolName, {})).toBeNull();
    expect(gate.checkDestructive(toolName, {}, { destructivePolicy: "block" } as B2Config)).toEqual(
      { ok: true },
    );
  },
);

it("keeps an owned destructive detector and block policy active", () => {
  expect(gate.isDestructiveTool("b2_delete_bucket")).toBe(true);
  expect(gate.destructiveEffect("b2_delete_bucket", {})).toBe("permanently delete a bucket");
  expect(
    gate.checkDestructive("b2_delete_bucket", {}, { destructivePolicy: "block" } as B2Config),
  ).toMatchObject({ ok: false, error: { code: "destructive_policy_blocked", status: 403 } });
});
