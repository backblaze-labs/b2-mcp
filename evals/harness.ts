import { Client, type CallToolResult, type Tool } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  DIST_INDEX,
  ROOT,
  requireBuiltFiles,
  safeSpawnEnv,
  stringifySpawnEnv,
} from "../test-support/mcp-server-process";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_LIST_TOOLS_TIMEOUT_MS = 10_000;
const DEFAULT_DRIVER_STEP_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_STDERR_TAIL_BYTES = 8_192;
const DEFAULT_MAX_TOOL_CALLS_PER_STEP = 8;
const DEFAULT_MAX_TOOL_CALLS_TOTAL = 32;

const EVAL_CREDENTIAL_MARKERS: Record<string, string> = {
  B2_APPLICATION_KEY_ID: "eval-application-key-id",
  B2_APPLICATION_KEY: "eval-application-key-secret",
  B2_APP_KEY_ID: "eval-app-key-id",
  B2_APP_KEY: "eval-app-key-secret",
  B2_MASTER_KEY_ID: "eval-master-key-id",
  B2_MASTER_KEY: "eval-master-key-secret",
};

const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
const activeEvalTransports = new Set<StdioClientTransport>();
const signalHandlers = new Map<NodeJS.Signals, () => void>();

export interface EvalToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface EvalRun {
  toolCalls: EvalToolCall[];
  toolResults: CallToolResult[];
  text: string;
}

export type EvalMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: EvalToolCall[] }
  | { role: "tool"; toolCall: EvalToolCall; result: CallToolResult };

export interface DriverInput {
  prompt: string;
  tools: Tool[];
  messages: EvalMessage[];
  step: number;
  maxSteps: number;
  signal: AbortSignal;
}

export interface DriverOutput {
  text?: string;
  toolCalls?: EvalToolCall[];
}

export interface Driver {
  readonly name: string;
  complete(input: DriverInput): Promise<DriverOutput>;
}

export interface EvalServerOptions {
  registerAllTools?: boolean;
  destructivePolicy?: "allow" | "block" | "confirm";
  env?: NodeJS.ProcessEnv;
}

export interface EvalTimeouts {
  connectMs?: number;
  listToolsMs?: number;
  driverStepMs?: number;
  toolCallMs?: number;
}

export interface RunEvalOptions {
  prompt: string;
  toolNames: string[];
  driver: Driver;
  maxSteps: number;
  maxToolCallsPerStep?: number;
  maxToolCallsTotal?: number;
  server?: EvalServerOptions;
  timeouts?: EvalTimeouts;
  stderrTailBytes?: number;
}

export interface EvalGate {
  enabled: boolean;
  reason?: string;
}

export interface EvalGateOptions {
  providerKeyEnvNames?: readonly string[];
}

interface ResolvedEvalTimeouts {
  connectMs: number;
  listToolsMs: number;
  driverStepMs: number;
  toolCallMs: number;
}

interface EvalServerConnection {
  client: Client;
  close(): Promise<void>;
  stderrTail(): string;
}

class EvalTimeoutError extends Error {
  constructor(
    readonly phase: string,
    readonly timeoutMs: number,
    readonly originalError?: unknown,
  ) {
    super(`Timed out during ${phase} after ${timeoutMs}ms.`);
    this.name = "EvalTimeoutError";
  }
}

function installSignalHandlers(): void {
  if (signalHandlers.size > 0) return;
  for (const signal of SIGNALS) {
    const handler = () => {
      void closeActiveEvalTransports().finally(() => {
        uninstallSignalHandlers();
        process.kill(process.pid, signal);
      });
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
}

function uninstallSignalHandlers(): void {
  for (const [signal, handler] of signalHandlers) {
    process.removeListener(signal, handler);
  }
  signalHandlers.clear();
}

function trackTransport(transport: StdioClientTransport): void {
  installSignalHandlers();
  activeEvalTransports.add(transport);
}

function untrackTransport(transport: StdioClientTransport): void {
  activeEvalTransports.delete(transport);
  if (activeEvalTransports.size === 0) {
    uninstallSignalHandlers();
  }
}

async function closeActiveEvalTransports(): Promise<void> {
  const transports = [...activeEvalTransports];
  activeEvalTransports.clear();
  await Promise.all(transports.map((transport) => transport.close().catch(() => undefined)));
}

function requireBuiltServer(): void {
  requireBuiltFiles([DIST_INDEX], "LLM evals require the built stdio server. Run pnpm run build.");
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return resolved;
}

function resolveTimeouts(timeouts: EvalTimeouts | undefined): ResolvedEvalTimeouts {
  return {
    connectMs: positiveInteger(timeouts?.connectMs, DEFAULT_CONNECT_TIMEOUT_MS, "connectMs"),
    listToolsMs: positiveInteger(
      timeouts?.listToolsMs,
      DEFAULT_LIST_TOOLS_TIMEOUT_MS,
      "listToolsMs",
    ),
    driverStepMs: positiveInteger(
      timeouts?.driverStepMs,
      DEFAULT_DRIVER_STEP_TIMEOUT_MS,
      "driverStepMs",
    ),
    toolCallMs: positiveInteger(timeouts?.toolCallMs, DEFAULT_TOOL_CALL_TIMEOUT_MS, "toolCallMs"),
  };
}

function assertSafeEvalServerEnv(env: NodeJS.ProcessEnv, options: EvalServerOptions): void {
  const unsafeCredentials = Object.entries(EVAL_CREDENTIAL_MARKERS)
    .filter(([name, marker]) => env[name] !== marker)
    .map(([name]) => name);
  if (unsafeCredentials.length) {
    throw new Error(
      `Eval server refused non-marker B2 credential env vars: ${unsafeCredentials.join(", ")}`,
    );
  }
  const expectedDestructivePolicy = options.destructivePolicy ?? "block";
  if (env.B2_DESTRUCTIVE_POLICY !== expectedDestructivePolicy) {
    throw new Error(
      `Eval server requires B2_DESTRUCTIVE_POLICY=${expectedDestructivePolicy} from the typed destructivePolicy option.`,
    );
  }
  if (env.B2_ALLOW_LOCAL_FILES !== "false") {
    throw new Error("Eval server requires B2_ALLOW_LOCAL_FILES=false.");
  }
  if (env.B2_SECRET_SINK !== "off") {
    throw new Error("Eval server requires B2_SECRET_SINK=off.");
  }
}

export function createEvalServerEnv(options: EvalServerOptions = {}): Record<string, string> {
  const env = safeSpawnEnv({
    NODE_ENV: "test",
    B2_REGISTER_ALL_TOOLS: options.registerAllTools === false ? "false" : "true",
    ...EVAL_CREDENTIAL_MARKERS,
    B2_DESTRUCTIVE_POLICY: options.destructivePolicy ?? "block",
    B2_ALLOW_LOCAL_FILES: "false",
    B2_SECRET_SINK: "off",
    ...options.env,
  });
  assertSafeEvalServerEnv(env, options);
  return stringifySpawnEnv(env);
}

function createClient(): Client {
  return new Client({ name: "b2-mcp-eval-harness", version: "1.0.0" }, { defaultCacheTtlMs: 0 });
}

function captureStderrTail(transport: StdioClientTransport, maxBytes: number): () => string {
  let stderrTail = "";
  transport.stderr?.on("data", (chunk) => {
    stderrTail = `${stderrTail}${chunk.toString()}`.slice(-maxBytes);
  });
  return () => stderrTail;
}

async function withTimeout<T>(
  phase: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  onTimeout?: () => void | Promise<void>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  let timeoutCleanup: Promise<void> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        timeoutCleanup = Promise.resolve(onTimeout?.()).catch(() => undefined);
        reject(new EvalTimeoutError(phase, timeoutMs));
      }, timeoutMs);
      timer.unref();
    });
    return await Promise.race([operation(controller.signal), timeout]);
  } catch (err) {
    if (timedOut) {
      await timeoutCleanup;
      if (err instanceof EvalTimeoutError) throw err;
      throw new EvalTimeoutError(phase, timeoutMs, err);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function withServerStderr(err: unknown, stderrTail: string): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  const stderr = stderrTail.trim();
  if (!stderr) return original;
  const wrapped = new Error(`${original.message}\nServer stderr tail:\n${stderr}`);
  wrapped.name = original.name;
  (wrapped as Error & { cause?: unknown }).cause = original;
  return wrapped;
}

async function connectEvalServer(
  server: EvalServerOptions | undefined,
  timeouts: ResolvedEvalTimeouts,
  stderrTailBytes: number,
): Promise<EvalServerConnection> {
  requireBuiltServer();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_INDEX],
    cwd: ROOT,
    env: createEvalServerEnv(server),
    stderr: "pipe",
  });
  trackTransport(transport);
  const stderrTail = captureStderrTail(transport, stderrTailBytes);
  const client = createClient();
  let closePromise: Promise<void> | undefined;
  const connection = {
    client,
    stderrTail,
    close: async () => {
      closePromise ??= (async () => {
        untrackTransport(transport);
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
      })();
      await closePromise;
    },
  };
  try {
    await withTimeout(
      "connect eval stdio server",
      timeouts.connectMs,
      (signal) => client.connect(transport, { signal, timeout: timeouts.connectMs }),
      connection.close,
    );
    return connection;
  } catch (err) {
    await connection.close();
    throw withServerStderr(err, stderrTail());
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
  if (!call || typeof call !== "object" || typeof call.name !== "string") {
    throw new Error("Driver returned an invalid tool call.");
  }
  if (!call.args || typeof call.args !== "object" || Array.isArray(call.args)) {
    throw new Error(`Driver returned invalid args for tool call ${call.name}.`);
  }
  return {
    name: call.name,
    args: call.args,
  };
}

function assertToolCallBudget(args: {
  driverName: string;
  calls: EvalToolCall[];
  executedToolCalls: number;
  maxToolCallsPerStep: number;
  maxToolCallsTotal: number;
}): void {
  if (args.calls.length > args.maxToolCallsPerStep) {
    throw new Error(
      `Driver ${args.driverName} exceeded maxToolCallsPerStep ` +
        `(${args.calls.length} > ${args.maxToolCallsPerStep}).`,
    );
  }
  const projectedTotal = args.executedToolCalls + args.calls.length;
  if (projectedTotal > args.maxToolCallsTotal) {
    throw new Error(
      `Driver ${args.driverName} exceeded maxToolCallsTotal ` +
        `(${projectedTotal} > ${args.maxToolCallsTotal}).`,
    );
  }
}

async function runServerOperation<T>(
  connection: EvalServerConnection,
  phase: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  try {
    return await withTimeout(phase, timeoutMs, operation, connection.close);
  } catch (err) {
    throw withServerStderr(err, connection.stderrTail());
  }
}

export function llmEvalGate(
  env: NodeJS.ProcessEnv = process.env,
  options: EvalGateOptions = {},
): EvalGate {
  if (env.RUN_LLM_EVALS !== "1") {
    return { enabled: false, reason: "RUN_LLM_EVALS is not 1" };
  }
  const providerKeyEnvNames = options.providerKeyEnvNames ?? [];
  if (providerKeyEnvNames.length === 0) return { enabled: true };
  const hasProviderKey = providerKeyEnvNames.some((name) => Boolean(env[name]));
  if (!hasProviderKey) {
    return {
      enabled: false,
      reason: `missing provider key (${providerKeyEnvNames.join(" or ")})`,
    };
  }
  return { enabled: true };
}

export async function runEval(options: RunEvalOptions): Promise<EvalRun> {
  if (!Number.isInteger(options.maxSteps) || options.maxSteps < 1) {
    throw new Error("maxSteps must be a positive integer.");
  }
  const timeouts = resolveTimeouts(options.timeouts);
  const maxToolCallsPerStep = nonNegativeInteger(
    options.maxToolCallsPerStep,
    DEFAULT_MAX_TOOL_CALLS_PER_STEP,
    "maxToolCallsPerStep",
  );
  const maxToolCallsTotal = nonNegativeInteger(
    options.maxToolCallsTotal,
    DEFAULT_MAX_TOOL_CALLS_TOTAL,
    "maxToolCallsTotal",
  );
  const stderrTailBytes = positiveInteger(
    options.stderrTailBytes,
    DEFAULT_STDERR_TAIL_BYTES,
    "stderrTailBytes",
  );
  const connection = await connectEvalServer(options.server, timeouts, stderrTailBytes);
  const { client } = connection;
  const toolCalls: EvalToolCall[] = [];
  const toolResults: CallToolResult[] = [];
  const textParts: string[] = [];
  const messages: EvalMessage[] = [{ role: "user", content: options.prompt }];

  try {
    const listed = await runServerOperation(
      connection,
      "list eval tools",
      timeouts.listToolsMs,
      (signal) =>
        client.listTools(undefined, {
          cacheMode: "refresh",
          signal,
          timeout: timeouts.listToolsMs,
          maxTotalTimeout: timeouts.listToolsMs,
        }),
    );
    const tools = selectTools(listed.tools, options.toolNames);
    const allowedToolNames = new Set(tools.map((tool) => tool.name));

    for (let step = 0; step < options.maxSteps; step += 1) {
      const output = await withTimeout(
        `driver step ${step + 1}`,
        timeouts.driverStepMs,
        (signal) =>
          options.driver.complete({
            prompt: options.prompt,
            tools,
            messages,
            step,
            maxSteps: options.maxSteps,
            signal,
          }),
        connection.close,
      );
      const text = output.text ?? "";
      if (text) textParts.push(text);

      const calls = (output.toolCalls ?? []).map(normalizeToolCall);
      assertToolCallBudget({
        driverName: options.driver.name,
        calls,
        executedToolCalls: toolCalls.length,
        maxToolCallsPerStep,
        maxToolCallsTotal,
      });
      messages.push({ role: "assistant", content: text, toolCalls: calls });
      if (calls.length === 0) break;

      for (const call of calls) {
        if (!allowedToolNames.has(call.name)) {
          throw new Error(`Driver ${options.driver.name} requested unexposed tool: ${call.name}`);
        }
        const result = await runServerOperation(
          connection,
          `tool call ${call.name}`,
          timeouts.toolCallMs,
          (signal) =>
            client.callTool(
              { name: call.name, arguments: call.args },
              {
                signal,
                timeout: timeouts.toolCallMs,
                maxTotalTimeout: timeouts.toolCallMs,
              },
            ),
        );
        toolCalls.push(call);
        toolResults.push(result);
        messages.push({ role: "tool", toolCall: call, result });
      }
    }

    return { toolCalls, toolResults, text: textParts.join("\n") };
  } finally {
    await connection.close();
  }
}
