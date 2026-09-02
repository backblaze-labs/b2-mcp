/**
 * Unit coverage for the deferred prompt-registration machinery shared with the
 * tool registrar. These paths guard against duplicate names, registrations that
 * arrive after commit, and repeated commits.
 */

import { createMcpServer, getRegisteredPrompts, PromptRegistrationAdapter } from "../../src/mcp";

function makePrompt(text: string) {
  return () => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
  });
}

describe("PromptRegistrationAdapter deferred registration", () => {
  it("rejects duplicate prompt names before commit", () => {
    const server = createMcpServer({ name: "prompt-dup-test", version: "1.0.0" });
    const registrar = new PromptRegistrationAdapter(server);

    registrar.registerPrompt("b2_demo_prompt", { description: "first" }, makePrompt("one"));
    expect(() =>
      registrar.registerPrompt("b2_demo_prompt", { description: "second" }, makePrompt("two")),
    ).toThrow("Duplicate MCP prompt registration: b2_demo_prompt");
  });

  it("rejects prompt registration after commit", () => {
    const server = createMcpServer({ name: "prompt-late-test", version: "1.0.0" });
    const registrar = new PromptRegistrationAdapter(server);

    registrar.registerPrompt("b2_demo_prompt", { description: "first" }, makePrompt("one"));
    expect(registrar.commit()).toBe(1);
    expect(() =>
      registrar.registerPrompt("b2_late_prompt", { description: "late" }, makePrompt("late")),
    ).toThrow("Prompt registered after commit: b2_late_prompt");
  });

  it("is idempotent across repeated commits", () => {
    const server = createMcpServer({ name: "prompt-recommit-test", version: "1.0.0" });
    const registrar = new PromptRegistrationAdapter(server);

    registrar.registerPrompt("b2_demo_prompt", { description: "first" }, makePrompt("one"));
    expect(registrar.commit()).toBe(1);
    expect(registrar.commit()).toBe(1);
    expect(Object.keys(getRegisteredPrompts(server) ?? {})).toEqual(["b2_demo_prompt"]);
  });
});
