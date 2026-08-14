import { McpServer as V2McpServer, type McpRequestContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DESTRUCTIVE_TOOL_NAMES } from "./utils/destructive-gate.js";
import { TOOL_CAPABILITIES } from "./utils/tool-capabilities.js";

export type McpServer = V2McpServer;

export type ToolCallback<TArgs = any> = (args: TArgs, extra: any) => any | Promise<any>;

export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

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
const DESTRUCTIVE_TOOL_NAME_SET = new Set(DESTRUCTIVE_TOOL_NAMES);

const READ_ONLY_OPERATION_TOOL_NAMES = new Set([
  "b2_authorize_account",
  "b2_list_groups",
  "b2_list_group_members",
  // This is a read operation. TOOL_CAPABILITIES includes writeBucketNotifications
  // because B2 permits writers to read rules too, not because the tool mutates rules.
  "b2_get_bucket_notification_rules",
]);

const IDEMPOTENT_EFFECT_TOOL_NAMES = new Set([
  "b2_delete_bucket",
  "b2_delete_key",
  "b2_eject_group_member",
  // Conditional destructive tools stay destructive at tool granularity because
  // their destructive variants are enforced by checkDestructive; repeating the
  // same replacement/update payload has no additional effect.
  "b2_set_bucket_notification_rules",
  "b2_update_bucket",
  "b2_update_file_legal_hold",
  "b2_update_file_retention",
  "s3_abort_multipart_upload",
  "s3_delete_object",
  "s3_delete_objects",
  // s3_get_presigned_url can mint a PutObject bearer URL, so it is deliberately
  // destructive/not read-only at tool level. Presign tools do not mutate B2 state
  // on repeat.
  "s3_get_presigned_url",
  "s3_presign_upload_part",
  "s3_put_bucket_lifecycle",
]);

type ServerWithRegistry = McpServer & {
  [REGISTERED_TOOLS]?: RegisteredToolMap;
};

function isReadListCapability(capability: string): boolean {
  return capability.startsWith("read") || capability.startsWith("list");
}

export function hasReadOnlyToolCapabilities(name: string): boolean {
  const capabilities = TOOL_CAPABILITIES[name];
  return (
    capabilities !== undefined &&
    capabilities.length > 0 &&
    capabilities.every(isReadListCapability)
  );
}

export function annotationsForTool(name: string): McpToolAnnotations {
  const destructiveHint = DESTRUCTIVE_TOOL_NAME_SET.has(name);
  const readOnlyHint =
    !destructiveHint &&
    (hasReadOnlyToolCapabilities(name) || READ_ONLY_OPERATION_TOOL_NAMES.has(name));

  return {
    readOnlyHint,
    destructiveHint,
    idempotentHint: readOnlyHint || IDEMPOTENT_EFFECT_TOOL_NAMES.has(name),
    openWorldHint: true,
  };
}

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

export { V2McpServer };
export type { McpRequestContext };
