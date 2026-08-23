import { existsSync } from "fs";
import { join } from "path";
import { Client, type CallToolResult, type Tool } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const ROOT = join(__dirname, "..");
const DIST_INDEX = join(ROOT, "dist/index.js");
const SAFE_ENV_NAMES = [
  "PATH",
  "Path",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
];
const PROVIDER_KEY_ENV_NAMES = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_API_KEY"] as const;

export interface EvalToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface EvalRun {
  toolCalls: EvalToolCall[];
  toolResults: unknown[];
  text: string;
}

export type EvalMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: EvalToolCall[] }
  | { role: "tool"; toolCall: EvalToolCall; result: unknown };

export interface DriverInput {
  prompt: string;
  tools: Tool[];
  messages: EvalMessage[];
  step: number;
  maxSteps: number;
}

export interface DriverOutput {
  text?: string;
  toolCalls?: EvalToolCall[];
}

export interface Driver {
  readonly name: string;
  complete(input: DriverInput): Promise<DriverOutput>;
}

export interface RunEvalOptions {
  prompt: string;
  toolNames: string[];
  driver: Driver;
  maxSteps: number;
}

export interface EvalGate {
  enabled: boolean;
  reason?: string;
}

function requireBuiltServer(): void {
  if (!existsSync(DIST_INDEX)) {
    throw new Error("LLM evals require the built stdio server. Run pnpm run build.");
  }
}

function evalServerEnv(extra: NodeJS.ProcessEnv = {}): Record<string, string> {
  const inherited = Object.fromEntries(
    SAFE_ENV_NAMES.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name] as string]],
    ),
  );
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    NODE_ENV: "test",
    B2_REGISTER_ALL_TOOLS: "true",
    B2_APPLICATION_KEY_ID: "eval-key-id",
    B2_APPLICATION_KEY: "eval-key-secret",
    B2_MASTER_KEY_ID: "eval-master-key-id",
    B2_MASTER_KEY: "eval-master-key-secret",
    B2_DESTRUCTIVE_POLICY: "allow",
    ...extra,
  };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function createClient(): Client {
  return new Client({ name: "b2-mcp-eval-harness", version: "1.0.0" }, { defaultCacheTtlMs: 0 });
}

async function connectEvalServer(): Promise<{
  client: Client;
  transport: StdioClientTransport;
}> {
  requireBuiltServer();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_INDEX],
    cwd: ROOT,
    env: evalServerEnv(),
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  const client = createClient();
  try {
    await client.connect(transport);
    return { client, transport };
  } catch (err) {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    throw err;
  }
}

function selectTools(allTools: Tool[], toolNames: string[]): Tool[] {
  const byName = new Map(allTools.map((tool) => [tool.name, tool]));
  const selected = toolNames.map((name) => byName.get(name));
  const missing = toolNames.filter((_name, index) => selected[index] === undefined);
  if (missing.length) {
    throw new Error(`Requested eval tools are not registered: ${missing.join(", ")}`);
  }
  return selected as Tool[];
}

function normalizeToolCall(call: EvalToolCall): EvalToolCall {
  return {
    name: call.name,
    args: call.args ?? {},
  };
}

export function llmEvalGate(env: NodeJS.ProcessEnv = process.env): EvalGate {
  if (env.RUN_LLM_EVALS !== "1") {
    return { enabled: false, reason: "RUN_LLM_EVALS is not 1" };
  }
  const hasProviderKey = PROVIDER_KEY_ENV_NAMES.some((name) => Boolean(env[name]));
  if (!hasProviderKey) {
    return {
      enabled: false,
      reason: `missing provider key (${PROVIDER_KEY_ENV_NAMES.join(" or ")})`,
    };
  }
  return { enabled: true };
}

export async function runEval(options: RunEvalOptions): Promise<EvalRun> {
  if (options.maxSteps < 1) {
    throw new Error("maxSteps must be at least 1");
  }
  const { client, transport } = await connectEvalServer();
  const toolCalls: EvalToolCall[] = [];
  const toolResults: CallToolResult[] = [];
  const textParts: string[] = [];
  const messages: EvalMessage[] = [{ role: "user", content: options.prompt }];

  try {
    const listed = await client.listTools(undefined, { cacheMode: "refresh" });
    const tools = selectTools(listed.tools, options.toolNames);
    const allowedToolNames = new Set(tools.map((tool) => tool.name));

    for (let step = 0; step < options.maxSteps; step += 1) {
      const output = await options.driver.complete({
        prompt: options.prompt,
        tools,
        messages,
        step,
        maxSteps: options.maxSteps,
      });
      const text = output.text ?? "";
      if (text) textParts.push(text);

      const calls = (output.toolCalls ?? []).map(normalizeToolCall);
      messages.push({ role: "assistant", content: text, toolCalls: calls });
      if (calls.length === 0) break;

      for (const call of calls) {
        if (!allowedToolNames.has(call.name)) {
          throw new Error(`Driver ${options.driver.name} requested unexposed tool: ${call.name}`);
        }
        const result = await client.callTool({ name: call.name, arguments: call.args });
        toolCalls.push(call);
        toolResults.push(result);
        messages.push({ role: "tool", toolCall: call, result });
      }
    }

    return { toolCalls, toolResults, text: textParts.join("\n") };
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}
