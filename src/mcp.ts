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

class RegistrationState<TRecord, TPending extends { name: string }> {
  private readonly pending: TPending[] = [];
  private readonly records: Record<string, TRecord> = {};
  private committed = false;

  constructor(private readonly kind: string) {}

  assertOpen(name: string): void {
    if (this.committed) throw new Error(`${this.kind} registered after commit: ${name}`);
  }

  add(name: string, record: TRecord, pending: TPending): void {
    this.assertOpen(name);
    if (this.records[name]) throw new Error(`Duplicate MCP ${this.kind} registration: ${name}`);
    this.records[name] = record;
    this.pending.push(pending);
  }

  has(name: string): boolean {
    return this.records[name] !== undefined;
  }

  commit(
    register: (pending: TPending) => void,
    publish: (records: Record<string, TRecord>) => void,
  ): number {
    if (this.committed) return Object.keys(this.records).length;
    this.committed = true;
    for (const pending of [...this.pending].sort((a, b) => a.name.localeCompare(b.name))) {
      register(pending);
    }
    publish(
      Object.fromEntries(
        Object.entries(this.records).sort(([a], [b]) => a.localeCompare(b)),
      ) as Record<string, TRecord>,
    );
    return Object.keys(this.records).length;
  }
}

export class ToolRegistrationAdapter implements ToolRegistrar {
  private readonly state = new RegistrationState<RegisteredToolRecord, PendingTool>("tool");

  constructor(
    private readonly server: McpServer,
    private readonly options: ToolRegistrationAdapterOptions = {},
  ) {}

  registerTool<TArgs = any>(
    name: string,
    config: ToolRegistrationConfig,
    cb: ToolCallback<TArgs>,
  ): void {
    this.state.assertOpen(name);
    if (!config.force && this.options.shouldRegister && !this.options.shouldRegister(name)) {
      return;
    }

    const callback = this.options.wrapCallback?.(name, cb as ToolCallback) ?? (cb as ToolCallback);
    const inputSchema = z.object(config.inputSchema ?? {});
    const annotations = annotationsForTool(name);
    this.state.add(
      name,
      {
        name,
        description: config.description,
        inputSchema,
        annotations,
        execute: callback,
      },
      {
        name,
        title: config.title,
        description: config.description,
        inputSchema,
        annotations,
        callback,
      },
    );
  }

  hasTool(name: string): boolean {
    return this.state.has(name);
  }

  commit(): number {
    return this.state.commit(
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
        (this.server as ServerWithRegistry)[REGISTERED_TOOLS] = records as RegisteredToolMap;
      },
    );
  }
}

export class PromptRegistrationAdapter implements PromptRegistrar {
  private readonly state = new RegistrationState<RegisteredPromptRecord, PendingPrompt>("prompt");

  constructor(
    private readonly server: McpServer,
    private readonly options: PromptRegistrationAdapterOptions = {},
  ) {}

  registerPrompt<TArgs = any>(
    name: string,
    config: PromptRegistrationConfig,
    cb: PromptCallback<TArgs>,
  ): void {
    this.state.assertOpen(name);
    if (this.options.shouldRegister && !this.options.shouldRegister(name)) return;

    const argsSchema = z.object(config.argsSchema ?? {});
    const callback = cb as PromptCallback;
    this.state.add(
      name,
      {
        name,
        title: config.title,
        description: config.description,
        argsSchema,
        execute: callback,
      },
      {
        name,
        title: config.title,
        description: config.description,
        argsSchema,
        callback,
      },
    );
  }

  commit(): number {
    return this.state.commit(
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
        (this.server as ServerWithRegistry)[REGISTERED_PROMPTS] = records as RegisteredPromptMap;
      },
    );
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
