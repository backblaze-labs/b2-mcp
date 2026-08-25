import {
  McpServer as V2McpServer,
  type ClientCapabilities,
  type GetPromptResult,
  type InputRequiredResult,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { annotationsForTool, type McpToolAnnotations } from "./utils/tool-capabilities.js";

export type McpServer = V2McpServer;

export type ToolCallback<TArgs = any> = (args: TArgs, extra: any) => any | Promise<any>;
export type PromptCallback<TArgs = any> = (
  args: TArgs,
  extra: any,
) => GetPromptResult | InputRequiredResult | Promise<GetPromptResult | InputRequiredResult>;

export interface ToolRegistrationConfig {
  title?: string;
  description?: string;
  inputSchema?: z.ZodRawShape;
  force?: boolean;
}

export interface PromptRegistrationConfig {
  title?: string;
  description?: string;
  argsSchema?: z.ZodRawShape;
}

export interface RegisteredToolRecord {
  name: string;
  description?: string;
  inputSchema?: z.ZodObject<z.ZodRawShape>;
  annotations: McpToolAnnotations;
  execute: ToolCallback;
}

export interface RegisteredPromptRecord {
  name: string;
  title?: string;
  description?: string;
  argsSchema: z.ZodObject<z.ZodRawShape>;
  execute: PromptCallback;
}

export type RegisteredToolMap = Record<string, RegisteredToolRecord>;
export type RegisteredPromptMap = Record<string, RegisteredPromptRecord>;

export interface ToolRegistrar {
  registerTool<TArgs = any>(
    name: string,
    config: ToolRegistrationConfig,
    cb: ToolCallback<TArgs>,
  ): void;
  hasTool(name: string): boolean;
}

export interface PromptRegistrar {
  registerPrompt<TArgs = any>(
    name: string,
    config: PromptRegistrationConfig,
    cb: PromptCallback<TArgs>,
  ): void;
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

interface ToolRegistrationAdapterOptions {
  shouldRegister?: (name: string) => boolean;
  wrapCallback?: (name: string, cb: ToolCallback) => ToolCallback;
}

interface PromptRegistrationAdapterOptions {
  shouldRegister?: (name: string) => boolean;
}

const REGISTERED_TOOLS = Symbol("b2-mcp.registeredTools");
const REGISTERED_PROMPTS = Symbol("b2-mcp.registeredPrompts");

type ServerWithRegistry = McpServer & {
  [REGISTERED_TOOLS]?: RegisteredToolMap;
  [REGISTERED_PROMPTS]?: RegisteredPromptMap;
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

export class PromptRegistrationAdapter implements PromptRegistrar {
  private readonly pending: PendingPrompt[] = [];
  private readonly records: RegisteredPromptMap = {};
  private committed = false;

  constructor(
    private readonly server: McpServer,
    private readonly options: PromptRegistrationAdapterOptions = {},
  ) {}

  registerPrompt<TArgs = any>(
    name: string,
    config: PromptRegistrationConfig,
    cb: PromptCallback<TArgs>,
  ): void {
    if (this.committed) throw new Error(`Prompt registered after commit: ${name}`);
    if (this.options.shouldRegister && !this.options.shouldRegister(name)) return;
    if (this.records[name]) throw new Error(`Duplicate MCP prompt registration: ${name}`);

    const argsSchema = z.object(config.argsSchema ?? {});
    const callback = cb as PromptCallback;
    this.records[name] = {
      name,
      title: config.title,
      description: config.description,
      argsSchema,
      execute: callback,
    };
    this.pending.push({
      name,
      title: config.title,
      description: config.description,
      argsSchema,
      callback,
    });
  }

  hasPrompt(name: string): boolean {
    return this.records[name] !== undefined;
  }

  commit(): number {
    if (this.committed) return Object.keys(this.records).length;
    this.committed = true;
    for (const { name, title, description, argsSchema, callback } of [...this.pending].sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      this.server.registerPrompt(
        name,
        {
          title,
          description,
          argsSchema,
        },
        callback as any,
      );
    }
    (this.server as ServerWithRegistry)[REGISTERED_PROMPTS] = Object.fromEntries(
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

export function getRegisteredPrompts(server: McpServer): RegisteredPromptMap | null {
  return (server as ServerWithRegistry)[REGISTERED_PROMPTS] ?? null;
}

export function getMcpClientCapabilities(server: McpServer): ClientCapabilities | undefined {
  return server.server.getClientCapabilities();
}

export function getMcpNegotiatedProtocolVersion(server: McpServer): string | undefined {
  return server.server.getNegotiatedProtocolVersion();
}

export { V2McpServer };
export type { McpRequestContext };
