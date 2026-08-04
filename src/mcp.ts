import {
  McpServer as V2McpServer,
  type McpRequestContext,
  type RegisteredTool,
} from "@modelcontextprotocol/server";
import { z } from "zod";

export type McpServer = V2McpServer;

export type ToolCallback<TArgs = any> = (args: TArgs, extra: any) => any | Promise<any>;

export interface ToolRegistrationConfig {
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  force?: boolean;
}

export interface RegisteredToolRecord {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  callback: ToolCallback;
  handler: ToolCallback;
  execute: ToolCallback;
}

export type RegisteredToolMap = Record<string, RegisteredToolRecord>;

export interface ToolRegistrar {
  registerTool<TArgs = any>(
    name: string,
    config: ToolRegistrationConfig,
    cb: ToolCallback<TArgs>,
  ): RegisteredTool | undefined;
}

interface PendingTool {
  name: string;
  config: ToolRegistrationConfig;
  callback: ToolCallback;
}

interface ToolRegistrationAdapterOptions {
  shouldRegister?: (name: string) => boolean;
  wrapCallback?: (name: string, cb: ToolCallback) => ToolCallback;
}

const REGISTERED_TOOLS = Symbol("b2-mcp.registeredTools");

type ServerWithRegistry = McpServer & {
  [REGISTERED_TOOLS]?: RegisteredToolMap;
};

export class ToolRegistrationAdapter implements ToolRegistrar {
  private readonly pending: PendingTool[] = [];
  private readonly records: RegisteredToolMap = {};
  private committed = false;

  constructor(
    private readonly server: McpServer,
    private readonly options: ToolRegistrationAdapterOptions = {},
  ) {}

  registerTool<TArgs = any>(
    name: string,
    config: ToolRegistrationConfig,
    cb: ToolCallback<TArgs>,
  ): RegisteredTool | undefined {
    if (this.committed) throw new Error(`Tool registered after commit: ${name}`);
    if (!config.force && this.options.shouldRegister && !this.options.shouldRegister(name)) {
      return undefined;
    }
    if (this.records[name]) throw new Error(`Duplicate MCP tool registration: ${name}`);

    const callback = this.options.wrapCallback?.(name, cb as ToolCallback) ?? (cb as ToolCallback);
    this.records[name] = {
      name,
      description: config.description,
      inputSchema: z.object((config.inputSchema ?? {}) as any) as any,
      callback,
      handler: callback,
      execute: callback,
    };
    this.pending.push({ name, config, callback });
    return undefined;
  }

  commit(): number {
    if (this.committed) return Object.keys(this.records).length;
    this.committed = true;
    for (const { name, config, callback } of [...this.pending].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      this.server.registerTool(
        name,
        {
          title: config.title,
          description: config.description,
          inputSchema: config.inputSchema as any,
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

export function createMcpServer(...args: ConstructorParameters<typeof V2McpServer>): McpServer {
  return new V2McpServer(...args);
}

export function getRegisteredTools(server: McpServer): RegisteredToolMap | null {
  return (server as ServerWithRegistry)[REGISTERED_TOOLS] ?? null;
}

export { V2McpServer };
export type { McpRequestContext };
