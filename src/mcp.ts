import {
  McpServer as V2McpServer,
  type ClientCapabilities,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { annotationsForTool, type McpToolAnnotations } from "./utils/tool-capabilities.js";

export type McpServer = V2McpServer;

export type ToolCallback<TArgs = any> = (args: TArgs, extra: any) => any | Promise<any>;

export interface ToolRegistrationConfig {
  title?: string;
  description?: string;
  inputSchema?: z.ZodRawShape;
  force?: boolean;
}

export interface RegisteredToolRecord {
  name: string;
  description?: string;
  inputSchema?: z.ZodObject<z.ZodRawShape>;
  annotations: McpToolAnnotations;
  execute: ToolCallback;
}

export type RegisteredToolMap = Record<string, RegisteredToolRecord>;

export interface ToolRegistrar {
  registerTool<TArgs = any>(
    name: string,
    config: ToolRegistrationConfig,
    cb: ToolCallback<TArgs>,
  ): void;
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

  hasTool(name: string): boolean {
    return this.records[name] !== undefined;
  }

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

export function createMcpServer(...args: ConstructorParameters<typeof V2McpServer>): McpServer {
  return new V2McpServer(...args);
}

export function getRegisteredTools(server: McpServer): RegisteredToolMap | null {
  return (server as ServerWithRegistry)[REGISTERED_TOOLS] ?? null;
}

export function getMcpClientCapabilities(server: McpServer): ClientCapabilities | undefined {
  return server.server.getClientCapabilities();
}

export function getMcpNegotiatedProtocolVersion(server: McpServer): string | undefined {
  return server.server.getNegotiatedProtocolVersion();
}

export { V2McpServer };
export type { McpRequestContext };
