/**
 * Covers the error (catch) paths across B2-native tool handlers by making the
 * underlying client.call reject with a client (4xx) error — 4xx so the circuit
 * breaker isn't tripped mid-loop.
 */

import axios from "axios";
import { createServer } from "../../src/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { B2Config } from "../../src/utils/types";

jest.mock("axios");
const mockedAxios = axios as jest.MockedFunction<typeof axios> & {
  get: jest.MockedFunction<typeof axios.get>;
};

const mockAuthData = {
  accountId: "acct",
  authorizationToken: "tok",
  apiInfo: {
    storageApi: {
      apiUrl: "https://api.example",
      downloadUrl: "https://dl.example",
      s3ApiUrl: "https://s3.example",
      recommendedPartSize: 1e8,
      absoluteMinimumPartSize: 5e6,
    },
  },
};

const config: B2Config = {
  applicationKeyId: "k",
  applicationKey: "s",
  appKeyId: "k",
  appKey: "s",
  region: "us-west-004",
  largeFileThreshold: 1e8,
  partSize: 1e8,
  allowLocalFiles: true,
  fileRoot: null,
};

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  const tool = (server as any)._registeredTools?.[name];
  const handler = tool.handler ?? tool.callback ?? tool.execute;
  return handler(args, {} as any);
}

let server: McpServer;

beforeEach(() => {
  jest.clearAllMocks();
  mockedAxios.get = jest.fn().mockResolvedValue({ data: mockAuthData });
  // Every client.call (callable axios) rejects with a 4xx.
  mockedAxios.mockRejectedValue({
    response: { status: 400, data: { code: "bad_request", message: "bad" } },
  } as never);
  server = createServer(config);
});

describe("B2 tool error paths (catch blocks)", () => {
  const args = {
    keyName: "k",
    capabilities: ["listFiles"],
    applicationKeyId: "a",
    bucketId: "b",
    fileNamePrefix: "",
    validDurationInSeconds: 3600,
    fileId: "f",
    fileName: "n",
    bucketName: "bk",
    legalHold: "on",
    fileRetention: { mode: "governance", retainUntilTimestamp: 1 },
    adminAccountId: "a",
    groupId: "g",
    memberEmail: "x@example.com",
    memberAccountId: "m",
    email: "x@example.com",
    term: 7,
    storage: 1,
    accountId: "a",
    computerId: "c",
  };

  const tools = [
    "b2_list_keys",
    "b2_create_key",
    "b2_delete_key",
    "b2_get_download_authorization",
    "b2_update_file_legal_hold",
    "b2_update_file_retention",
    "b2_list_groups",
    "b2_create_group_member",
    "b2_eject_group_member",
    "b2_list_group_members",
    "b2_reserve_trial_create_account",
    "bz_list_computers",
    "bz_delete_computer",
  ];

  it.each(tools)("%s returns a structured error", async (tool) => {
    const result = await callTool(server, tool, args);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("400");
  });
});
