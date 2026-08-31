/**
 * MCP SDK adapter and tool registry helpers.
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

/** Metadata used when registering a tool through {@link ToolRegistrar}. */
export interface ToolRegistrationConfig {
  /** Optional human-readable title exposed to MCP clients. */
  title?: string;
  /** Tool description exposed during `tools/list`. */
  description?: string;
  /** Zod raw shape used to build the tool input schema. */
  inputSchema?: z.ZodRawShape;
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
  /** Wrapped callback that the MCP SDK will invoke. */
  execute: ToolCallback;
}

/** Registered tool records keyed by MCP tool name. */
export type RegisteredToolMap = Record<string, RegisteredToolRecord>;

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

interface PendingTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  annotations: McpToolAnnotations;
  callback: ToolCallback;
}

/** Options that customize tool registration filtering and callback wrapping. */
export interface ToolRegistrationAdapterOptions {
  /** Predicate used to skip tools during capability-aware registration. */
  shouldRegister?: (name: string) => boolean;
  /** Callback wrapper used for auditing, sanitization, and policy enforcement. */
  wrapCallback?: (name: string, cb: ToolCallback) => ToolCallback;
}

const REGISTERED_TOOLS = Symbol("b2-mcp.registeredTools");

type ServerWithRegistry = McpServer & {
  [REGISTERED_TOOLS]?: RegisteredToolMap;
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
  private readonly pending: PendingTool[] = [];
  private readonly records: RegisteredToolMap = {};
  private committed = false;

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
    if (this.committed) throw new Error(`Tool registered after commit: ${name}`);
    if (!config.force && this.options.shouldRegister && !this.options.shouldRegister(name)) {
      return;
    }
    if (this.records[name]) throw new Error(`Duplicate MCP tool registration: ${name}`);

    const callback = this.options.wrapCallback?.(name, cb as ToolCallback) ?? (cb as ToolCallback);
    const inputSchema = z.object(config.inputSchema ?? {});
    const annotations = annotationsForTool(name);
    this.records[name] = {
      name,
      description: config.description,
      inputSchema,
      annotations,
      execute: callback,
    };
    this.pending.push({
      name,
      title: config.title,
      description: config.description,
      inputSchema,
      annotations,
      callback,
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
    return this.records[name] !== undefined;
  }

  /**
   * Register all queued tools with the MCP SDK.
   *
   * @returns Number of registered tool records.
   */
  commit(): number {
    if (this.committed) return Object.keys(this.records).length;
    this.committed = true;
    for (const { name, title, description, inputSchema, annotations, callback } of [
      ...this.pending,
    ].sort((a, b) => a.name.localeCompare(b.name))) {
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
    }
    (this.server as ServerWithRegistry)[REGISTERED_TOOLS] = Object.fromEntries(
      Object.entries(this.records).sort(([a], [b]) => a.localeCompare(b)),
    );
    return Object.keys(this.records).length;
  }
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
 */
export function getRegisteredTools(server: McpServer): RegisteredToolMap | null {
  return (server as ServerWithRegistry)[REGISTERED_TOOLS] ?? null;
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
