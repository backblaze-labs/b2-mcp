/**
 * MCP SDK adapter and tool registry helpers.
 *
 * @packageDocumentation
 *
 * @remarks
 * The rest of the codebase registers tools through this small abstraction
 * instead of calling the MCP SDK directly. That keeps capability filtering,
 * tool annotations, callback wrapping, deterministic registration order, and
 * test introspection in one place.
 *
 */

import {
  McpServer as V2McpServer,
  type ClientCapabilities,
  type GetPromptResult,
  type InputRequiredResult,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { annotationsForTool, type McpToolAnnotations } from "./utils/tool-capabilities.js";

/** Repository alias for the MCP SDK v2 server type. */
export type McpServer = V2McpServer;

/**
 * Tool callback signature used by repository-owned registrars.
 *
 * @typeParam TArgs - Parsed argument object for a specific tool.
 */
export type ToolCallback<TArgs = any> = (args: TArgs, extra: any) => any | Promise<any>;

/** Prompt callback result shape accepted by the MCP SDK. */
export type PromptCallbackResult = GetPromptResult | InputRequiredResult;

/**
 * Prompt callback signature used by repository-owned registrars.
 *
 * @typeParam TArgs - Parsed argument object for a specific prompt.
 */
export type PromptCallback<TArgs = any> = (
  args: TArgs,
  extra: any,
) => PromptCallbackResult | Promise<PromptCallbackResult>;

/** Whether a tool registration is a real handler or an unavailable compatibility shim. */
export type ToolRegistrationAvailability = "available" | "unavailable";

/**
 * Registration controls for durable-secret-producing tool registrars.
 *
 * @remarks
 * Durable-secret tools (`b2_create_key`, `b2_create_group_member`,
 * `b2_reserve_trial_create_account`) register their full input schema only when
 * an out-of-band secret sink is active. Credential-less discovery mode sets
 * `registerDurableSecretSchemas` so those schemas are advertised in `tools/list`
 * regardless of sink availability; execution is rejected by the discovery guard,
 * so the real handlers never run.
 */
export interface DurableSecretRegistrationOptions {
  /** Advertise the full durable-secret schemas even without an active sink. */
  registerDurableSecretSchemas?: boolean;
}

/** Metadata used when registering a tool through {@link ToolRegistrar}. */
export interface ToolRegistrationConfig {
  /** Optional human-readable title exposed to MCP clients. */
  title?: string;
  /** Tool description exposed during `tools/list`. */
  description?: string;
  /** Zod raw shape used to build the tool input schema. */
  inputSchema?: z.ZodRawShape;
  /** Availability of the registered handler; compatibility stubs are unavailable. */
  availability?: ToolRegistrationAvailability;
  /** Register even when the adapter's capability filter would skip the tool. */
  force?: boolean;
}

/** Introspection record for a registered tool. */
export interface RegisteredToolRecord {
  /** Stable MCP tool name. */
  name: string;
  /** Description passed to the MCP SDK. */
  description?: string;
  /** Materialized Zod object schema for tests and contract generation. */
  inputSchema?: z.ZodObject<z.ZodRawShape>;
  /** MCP tool annotations derived from the server capability map. */
  annotations: McpToolAnnotations;
  /** Whether the registered callback is a real callable handler or a stable stub. */
  availability: ToolRegistrationAvailability;
  /** Wrapped callback that the MCP SDK will invoke. */
  execute: ToolCallback;
}

/** Registered tool records keyed by MCP tool name. */
export type RegisteredToolMap = Record<string, RegisteredToolRecord>;

/** Metadata used when registering a prompt through {@link PromptRegistrar}. */
export interface PromptRegistrationConfig {
  /** Optional human-readable title exposed to MCP clients. */
  title?: string;
  /** Prompt description exposed during `prompts/list`. */
  description?: string;
  /** Zod raw shape used to build the prompt argument schema. */
  argsSchema?: z.ZodRawShape;
  /** Tool names whose available, non-stub handlers are required by this workflow. */
  requiredTools?: readonly string[];
  /** Additional B2 capabilities required by a specific argument branch in the workflow. */
  requiredCapabilities?: readonly string[];
  /** Register even when the adapter's capability filter would skip the prompt. */
  force?: boolean;
}

/** Availability inputs used by prompt registration filters. */
export interface PromptAvailabilityContext {
  /** Tool names whose available, non-stub handlers are required by this workflow. */
  requiredTools: readonly string[];
  /** Additional B2 capabilities required by a specific argument branch in the workflow. */
  requiredCapabilities: readonly string[];
}

/** Introspection record for a registered prompt. */
export interface RegisteredPromptRecord {
  /** Stable MCP prompt name. */
  name: string;
  /** Optional title passed to the MCP SDK. */
  title?: string;
  /** Description passed to the MCP SDK. */
  description?: string;
  /** Materialized Zod object schema for tests and contract generation. */
  argsSchema?: z.ZodObject<z.ZodRawShape>;
  /** Tool names whose available, non-stub handlers are required by this workflow. */
  requiredTools: readonly string[];
  /** Additional B2 capabilities required by a specific argument branch in the workflow. */
  requiredCapabilities: readonly string[];
  /** Wrapped callback that the MCP SDK will invoke. */
  execute: PromptCallback;
}

/** Registered prompt records keyed by MCP prompt name. */
export type RegisteredPromptMap = Record<string, RegisteredPromptRecord>;

/**
 * Minimal registration interface implemented by {@link ToolRegistrationAdapter}.
 *
 * @remarks
 * Tool modules depend on this interface so tests can register against a local
 * adapter and `createServer` can filter or wrap callbacks consistently.
 */
export interface ToolRegistrar {
  /**
   * Register a tool with metadata and a callback.
   *
   * @param name - Stable MCP tool name.
   * @param config - Description, schema, and optional force flag.
   * @param cb - Handler invoked after the MCP SDK validates arguments.
   *
   * @throws Error when registration happens after commit or duplicates a name.
   */
  registerTool<TArgs = any>(
    name: string,
    config: ToolRegistrationConfig,
    cb: ToolCallback<TArgs>,
  ): void;
  /**
   * Return whether a tool has already been registered with this registrar.
   *
   * @param name - MCP tool name to check.
   *
   * @returns `true` when a matching tool record exists.
   */
  hasTool(name: string): boolean;
}

/**
 * Minimal registration interface implemented by {@link PromptRegistrationAdapter}.
 *
 * @remarks
 * Prompt modules depend on this interface so the server can filter reusable
 * workflow prompts against the same credential-derived surface as tools.
 */
export interface PromptRegistrar {
  /**
   * Register a prompt with metadata and a callback.
   *
   * @param name - Stable MCP prompt name.
   * @param config - Description, schema, required tools, and optional force flag.
   * @param cb - Handler invoked after the MCP SDK validates arguments.
   *
   * @throws Error when registration happens after commit or duplicates a name.
   */
  registerPrompt<TArgs = any>(
    name: string,
    config: PromptRegistrationConfig,
    cb: PromptCallback<TArgs>,
  ): void;
  /**
   * Return whether a prompt has already been registered with this registrar.
   *
   * @param name - MCP prompt name to check.
   *
   * @returns `true` when a matching prompt record exists.
   */
  hasPrompt(name: string): boolean;
}

interface PendingTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  annotations: McpToolAnnotations;
  callback: ToolCallback;
}

interface PendingPrompt {
  name: string;
  title?: string;
  description?: string;
  argsSchema: z.ZodObject<z.ZodRawShape>;
  callback: PromptCallback;
}

class DeferredRegistrationSet<TRecord extends { name: string }, TPending extends { name: string }> {
  private readonly pending: TPending[] = [];
  private readonly records: Record<string, TRecord> = {};
  private committed = false;

  constructor(private readonly kind: "tool" | "prompt") {}

  add(input: {
    name: string;
    force?: boolean;
    shouldRegister?: () => boolean;
    record: TRecord;
    pending: TPending;
  }): void {
    if (this.committed) {
      throw new Error(
        `${this.kind === "tool" ? "Tool" : "Prompt"} registered after commit: ${input.name}`,
      );
    }
    if (!input.force && input.shouldRegister && !input.shouldRegister()) return;
    if (this.records[input.name]) {
      throw new Error(`Duplicate MCP ${this.kind} registration: ${input.name}`);
    }
    this.records[input.name] = input.record;
    this.pending.push(input.pending);
  }

  has(name: string): boolean {
    return this.records[name] !== undefined;
  }

  commit(
    register: (pending: TPending) => void,
    attachSnapshot: (records: Record<string, TRecord>) => void,
  ): number {
    if (this.committed) return Object.keys(this.records).length;
    this.committed = true;
    for (const pending of [...this.pending].sort((a, b) => a.name.localeCompare(b.name))) {
      register(pending);
    }
    attachSnapshot(
      Object.fromEntries(Object.entries(this.records).sort(([a], [b]) => a.localeCompare(b))),
    );
    return Object.keys(this.records).length;
  }
}

/** Options that customize tool registration filtering and callback wrapping. */
export interface ToolRegistrationAdapterOptions {
  /** Predicate used to skip tools during capability-aware registration. */
  shouldRegister?: (name: string) => boolean;
  /** Callback wrapper used for auditing, sanitization, and policy enforcement. */
  wrapCallback?: (name: string, cb: ToolCallback) => ToolCallback;
}

/** Options that customize prompt registration filtering. */
export interface PromptRegistrationAdapterOptions {
  /** Predicate used to skip prompts during capability-aware registration. */
  shouldRegister?: (name: string, context: PromptAvailabilityContext) => boolean;
  /** Callback wrapper used for audit logging or other prompt-level policies. */
  wrapCallback?: (name: string, cb: PromptCallback) => PromptCallback;
}

const REGISTERED_TOOLS = Symbol("b2-mcp.registeredTools");
const REGISTERED_PROMPTS = Symbol("b2-mcp.registeredPrompts");

type ServerWithRegistry = McpServer & {
  [REGISTERED_TOOLS]?: RegisteredToolMap;
  [REGISTERED_PROMPTS]?: RegisteredPromptMap;
};

/**
 * Deterministic tool registrar over the MCP SDK server.
 *
 * @remarks
 * The adapter queues registrations until `commit()` so tools are exposed in a
 * stable alphabetical order. It also stores the materialized schemas in a
 * private registry used by contract tests and fixture generation.
 *
 * @example
 * ```ts
 * const registrar = new ToolRegistrationAdapter(server, {
 *   shouldRegister: (name) => name.startsWith("b2_"),
 * });
 * registrar.registerTool("b2_authorize_account", { inputSchema: {} }, handler);
 * registrar.commit();
 * ```
 */
export class ToolRegistrationAdapter implements ToolRegistrar {
  private readonly registrations = new DeferredRegistrationSet<RegisteredToolRecord, PendingTool>(
    "tool",
  );

  /**
   * Create an adapter for a single MCP server instance.
   *
   * @param server - MCP SDK server receiving committed registrations.
   * @param options - Optional filters and callback wrappers.
   */
  constructor(
    private readonly server: McpServer,
    private readonly options: ToolRegistrationAdapterOptions = {},
  ) {}

  /**
   * Queue a tool registration.
   *
   * @param name - Stable MCP tool name.
   * @param config - Tool metadata and raw input schema.
   * @param cb - Tool callback to invoke after validation.
   *
   * @throws Error when the adapter has already committed or a duplicate name is
   * registered.
   */
  registerTool<TArgs = any>(
    name: string,
    config: ToolRegistrationConfig,
    cb: ToolCallback<TArgs>,
  ): void {
    const callback = this.options.wrapCallback?.(name, cb as ToolCallback) ?? (cb as ToolCallback);
    const inputSchema = z.object(config.inputSchema ?? {});
    const annotations = annotationsForTool(name);
    const availability = config.availability ?? "available";
    this.registrations.add({
      name,
      force: config.force,
      shouldRegister: () => this.options.shouldRegister?.(name) ?? true,
      record: {
        name,
        description: config.description,
        inputSchema,
        annotations,
        availability,
        execute: callback,
      },
      pending: {
        name,
        title: config.title,
        description: config.description,
        inputSchema,
        annotations,
        callback,
      },
    });
  }

  /**
   * Check whether a tool was queued for registration.
   *
   * @param name - MCP tool name.
   *
   * @returns `true` when the adapter has a record for the tool.
   */
  hasTool(name: string): boolean {
    return this.registrations.has(name);
  }

  /**
   * Register all queued tools with the MCP SDK.
   *
   * @returns Number of registered tool records.
   */
  commit(): number {
    return this.registrations.commit(
      ({ name, title, description, inputSchema, annotations, callback }) => {
        this.server.registerTool(
          name,
          {
            title,
            description,
            inputSchema,
            annotations,
          },
          callback as any,
        );
      },
      (records) => {
        (this.server as ServerWithRegistry)[REGISTERED_TOOLS] = records;
      },
    );
  }
}

/**
 * Deterministic prompt registrar over the MCP SDK server.
 *
 * @remarks
 * The adapter queues registrations until `commit()` so prompts are exposed in a
 * stable alphabetical order. It also stores the materialized schemas in a
 * private registry used by contract tests and fixture generation.
 *
 * @example
 * ```ts
 * const registrar = new PromptRegistrationAdapter(server, {
 *   shouldRegister: (_name, { requiredTools }) => requiredTools.includes("b2_list_buckets"),
 * });
 * registrar.registerPrompt("b2_audit_public_exposure", {
 *   argsSchema: { limit: z.string().optional() },
 * }, handler);
 * registrar.commit();
 * ```
 */
export class PromptRegistrationAdapter implements PromptRegistrar {
  private readonly registrations = new DeferredRegistrationSet<
    RegisteredPromptRecord,
    PendingPrompt
  >("prompt");

  /**
   * Create an adapter for a single MCP server instance.
   *
   * @param server - MCP SDK server receiving committed registrations.
   * @param options - Optional prompt availability filter and callback wrapper.
   */
  constructor(
    private readonly server: McpServer,
    private readonly options: PromptRegistrationAdapterOptions = {},
  ) {}

  /**
   * Queue a prompt registration.
   *
   * @param name - Stable MCP prompt name.
   * @param config - Prompt metadata and raw argument schema.
   * @param cb - Prompt callback to invoke after validation.
   *
   * @throws Error when the adapter has already committed or a duplicate name is
   * registered.
   */
  registerPrompt<TArgs = any>(
    name: string,
    config: PromptRegistrationConfig,
    cb: PromptCallback<TArgs>,
  ): void {
    const requiredTools = config.requiredTools ?? [];
    const requiredCapabilities = config.requiredCapabilities ?? [];
    const callback =
      this.options.wrapCallback?.(name, cb as PromptCallback) ?? (cb as PromptCallback);
    const argsSchema = z.object(config.argsSchema ?? {});
    this.registrations.add({
      name,
      force: config.force,
      shouldRegister: () =>
        this.options.shouldRegister?.(name, { requiredTools, requiredCapabilities }) ?? true,
      record: {
        name,
        title: config.title,
        description: config.description,
        argsSchema,
        requiredTools,
        requiredCapabilities,
        execute: callback,
      },
      pending: {
        name,
        title: config.title,
        description: config.description,
        argsSchema,
        callback,
      },
    });
  }

  /**
   * Check whether a prompt was queued for registration.
   *
   * @param name - MCP prompt name.
   *
   * @returns `true` when the adapter has a record for the prompt.
   */
  hasPrompt(name: string): boolean {
    return this.registrations.has(name);
  }

  /**
   * Register all queued prompts with the MCP SDK.
   *
   * @returns Number of registered prompt records.
   */
  commit(): number {
    return this.registrations.commit(
      ({ name, title, description, argsSchema, callback }) => {
        this.server.registerPrompt(
          name,
          {
            title,
            description,
            argsSchema,
          },
          callback as any,
        );
      },
      (records) => {
        (this.server as ServerWithRegistry)[REGISTERED_PROMPTS] = records;
      },
    );
  }
}

/**
 * Return whether a workflow prompt's required tools are available as real handlers.
 *
 * @param requiredTools - Tool names declared by a prompt as workflow prerequisites.
 * @param tools - Committed tool registry for the same server instance.
 *
 * @returns `true` when every required tool exists and is not a compatibility stub.
 */
export function promptRequiredToolsAvailable(
  requiredTools: readonly string[],
  tools: RegisteredToolMap,
): boolean {
  return (
    requiredTools.length > 0 &&
    requiredTools.every((toolName) => tools[toolName]?.availability === "available")
  );
}

/**
 * Create an MCP SDK server instance.
 *
 * @remarks
 * This wrapper keeps SDK construction spy-able in tests without exporting
 * dependency-injection hooks from the package root.
 *
 * @param args - Constructor arguments accepted by the MCP SDK server.
 *
 * @returns New MCP server instance.
 */
export function createMcpServer(...args: ConstructorParameters<typeof V2McpServer>): McpServer {
  return new V2McpServer(...args);
}

/**
 * Read the deterministic tool registry attached by {@link ToolRegistrationAdapter}.
 *
 * @param server - MCP server to inspect.
 *
 * @returns Registered tools, or `null` if the server was not committed through
 * this adapter.
 *
 * @internal
 */
export function getRegisteredTools(server: McpServer): RegisteredToolMap | null {
  return (server as ServerWithRegistry)[REGISTERED_TOOLS] ?? null;
}

/**
 * Read the deterministic prompt registry attached by {@link PromptRegistrationAdapter}.
 *
 * @param server - MCP server to inspect.
 *
 * @returns Registered prompts, or `null` if the server was not committed through
 * this adapter.
 *
 * @internal
 */
export function getRegisteredPrompts(server: McpServer): RegisteredPromptMap | null {
  return (server as ServerWithRegistry)[REGISTERED_PROMPTS] ?? null;
}

/**
 * Return the current MCP client capabilities from the SDK server.
 *
 * @param server - MCP server handling a request.
 *
 * @returns Client capabilities negotiated by the SDK, when available.
 */
export function getMcpClientCapabilities(server: McpServer): ClientCapabilities | undefined {
  return server.server.getClientCapabilities();
}

/**
 * Return the negotiated MCP protocol version from the SDK server.
 *
 * @param server - MCP server handling a request.
 *
 * @returns Negotiated protocol version, when the SDK has one.
 */
export function getMcpNegotiatedProtocolVersion(server: McpServer): string | undefined {
  return server.server.getNegotiatedProtocolVersion();
}

export { V2McpServer };
export type { McpRequestContext };
