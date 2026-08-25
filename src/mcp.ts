import {
  McpServer as V2McpServer,
  ResourceTemplate,
  type CacheHint,
  type ClientCapabilities,
  type McpRequestContext,
  type ReadResourceCallback,
  type ReadResourceTemplateCallback,
  type ResourceMetadata,
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
const REGISTERED_RESOURCES = Symbol("b2-mcp.registeredResources");

type ServerWithRegistry = McpServer & {
  [REGISTERED_TOOLS]?: RegisteredToolMap;
  [REGISTERED_RESOURCES]?: RegisteredResourceRegistry;
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

export type ResourceReadCallback = ReadResourceCallback;
export type ResourceTemplateReadCallback = ReadResourceTemplateCallback;

export interface ResourceRegistrationConfig extends ResourceMetadata {
  cacheHint?: CacheHint;
}

export interface RegisteredStaticResourceRecord {
  kind: "resource";
  name: string;
  uri: string;
  metadata: ResourceRegistrationConfig;
  read: ResourceReadCallback;
}

export interface RegisteredTemplateResourceRecord {
  kind: "template";
  name: string;
  resourceTemplate: ResourceTemplate;
  metadata: ResourceRegistrationConfig;
  read: ResourceTemplateReadCallback;
}

export interface RegisteredResourceRegistry {
  resources: Record<string, RegisteredStaticResourceRecord>;
  resourceTemplates: Record<string, RegisteredTemplateResourceRecord>;
}

export interface ResourceRegistrar {
  registerResource(
    name: string,
    uri: string,
    config: ResourceRegistrationConfig,
    cb: ResourceReadCallback,
  ): void;
  registerResourceTemplate(
    name: string,
    template: ResourceTemplate,
    config: ResourceRegistrationConfig,
    cb: ResourceTemplateReadCallback,
  ): void;
  hasResource(name: string): boolean;
}

type PendingResource = RegisteredStaticResourceRecord | RegisteredTemplateResourceRecord;

interface ResourceRegistrationAdapterOptions {
  shouldRegister?: (name: string) => boolean;
}

export class ResourceRegistrationAdapter implements ResourceRegistrar {
  private readonly pending: PendingResource[] = [];
  private readonly resources: Record<string, RegisteredStaticResourceRecord> = {};
  private readonly resourceTemplates: Record<string, RegisteredTemplateResourceRecord> = {};
  private readonly resourceUris = new Set<string>();
  private committed = false;

  constructor(
    private readonly server: McpServer,
    private readonly options: ResourceRegistrationAdapterOptions = {},
  ) {}

  registerResource(
    name: string,
    uri: string,
    config: ResourceRegistrationConfig,
    cb: ResourceReadCallback,
  ): void {
    if (this.committed) throw new Error(`Resource registered after commit: ${name}`);
    if (this.options.shouldRegister && !this.options.shouldRegister(name)) return;
    if (this.resources[name] || this.resourceTemplates[name]) {
      throw new Error(`Duplicate MCP resource registration: ${name}`);
    }
    if (this.resourceUris.has(uri)) throw new Error(`Duplicate MCP resource URI: ${uri}`);

    const record: RegisteredStaticResourceRecord = {
      kind: "resource",
      name,
      uri,
      metadata: config,
      read: cb,
    };
    this.resources[name] = record;
    this.resourceUris.add(uri);
    this.pending.push(record);
  }

  registerResourceTemplate(
    name: string,
    template: ResourceTemplate,
    config: ResourceRegistrationConfig,
    cb: ResourceTemplateReadCallback,
  ): void {
    if (this.committed) throw new Error(`Resource template registered after commit: ${name}`);
    if (this.options.shouldRegister && !this.options.shouldRegister(name)) return;
    if (this.resources[name] || this.resourceTemplates[name]) {
      throw new Error(`Duplicate MCP resource registration: ${name}`);
    }

    const record: RegisteredTemplateResourceRecord = {
      kind: "template",
      name,
      resourceTemplate: template,
      metadata: config,
      read: cb,
    };
    this.resourceTemplates[name] = record;
    this.pending.push(record);
  }

  hasResource(name: string): boolean {
    return this.resources[name] !== undefined || this.resourceTemplates[name] !== undefined;
  }

  commit(): number {
    if (this.committed) {
      return Object.keys(this.resources).length + Object.keys(this.resourceTemplates).length;
    }
    this.committed = true;
    for (const record of [...this.pending].sort((a, b) => a.name.localeCompare(b.name))) {
      if (record.kind === "resource") {
        this.server.registerResource(record.name, record.uri, record.metadata, record.read);
      } else {
        this.server.registerResource(
          record.name,
          record.resourceTemplate,
          record.metadata,
          record.read,
        );
      }
    }
    (this.server as ServerWithRegistry)[REGISTERED_RESOURCES] = {
      resources: Object.fromEntries(
        Object.entries(this.resources).sort(([a], [b]) => a.localeCompare(b)),
      ),
      resourceTemplates: Object.fromEntries(
        Object.entries(this.resourceTemplates).sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
    return Object.keys(this.resources).length + Object.keys(this.resourceTemplates).length;
  }
}

export function createMcpServer(...args: ConstructorParameters<typeof V2McpServer>): McpServer {
  return new V2McpServer(...args);
}

export function getRegisteredTools(server: McpServer): RegisteredToolMap | null {
  return (server as ServerWithRegistry)[REGISTERED_TOOLS] ?? null;
}

export function getRegisteredResources(server: McpServer): RegisteredResourceRegistry | null {
  return (server as ServerWithRegistry)[REGISTERED_RESOURCES] ?? null;
}

export function getMcpClientCapabilities(server: McpServer): ClientCapabilities | undefined {
  return server.server.getClientCapabilities();
}

export function getMcpNegotiatedProtocolVersion(server: McpServer): string | undefined {
  return server.server.getNegotiatedProtocolVersion();
}

export { V2McpServer };
export { ResourceTemplate };
export type { McpRequestContext };
