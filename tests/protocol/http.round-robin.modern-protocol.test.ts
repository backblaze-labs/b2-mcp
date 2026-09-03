import * as http from "http";
import type { AddressInfo } from "net";
import { spawn, type ChildProcess } from "child_process";
import { join } from "path";
import {
  HTTP_CREDS,
  SIMULATOR_ENTRYPOINT,
  modernBody,
  modernHeaders,
  protocolEnv,
  requireBuiltEntrypoints,
} from "./support/clients";
import { request } from "../support/http";

interface Replica {
  name: string;
  port: number;
  child: ChildProcess;
  stderr: string;
}

interface ProxyHandle {
  server: http.Server;
  port: number;
  seen: string[];
  setTargets(targets: Replica[]): void;
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await request(port, "GET", "/health");
      if (res.status === 200) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`replica on ${port} did not become healthy: ${String(lastError)}`);
}

async function startReplica(name: string): Promise<Replica> {
  requireBuiltEntrypoints();
  const port = await freePort();
  const child = spawn(process.execPath, [SIMULATOR_ENTRYPOINT, "http", "--port", String(port)], {
    cwd: join(__dirname, "../.."),
    env: protocolEnv({
      LOG_LEVEL: "silent",
      B2_ALLOWED_HOSTS: "127.0.0.1,localhost",
      B2_HTTP_CREDENTIAL_MODE: "headers",
      B2_REGISTER_ALL_TOOLS: "false",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const replica: Replica = { name, port, child, stderr: "" };
  child.stderr?.on("data", (chunk) => {
    replica.stderr += chunk.toString();
  });
  await waitForHealth(port);
  return replica;
}

async function stopReplica(replica: Replica): Promise<void> {
  if (replica.child.exitCode !== null || replica.child.signalCode !== null) return;
  replica.child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      replica.child.kill("SIGKILL");
      resolve();
    }, 2_000);
    timer.unref();
    replica.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function readNodeBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks as unknown as readonly Uint8Array[]);
}

async function startRoundRobinProxy(initialTargets: Replica[]): Promise<ProxyHandle> {
  let targets = [...initialTargets];
  let next = 0;
  const seen: string[] = [];
  const server = http.createServer(async (clientReq, clientRes) => {
    if (targets.length === 0) {
      clientRes.writeHead(503);
      clientRes.end();
      return;
    }
    const target = targets[next % targets.length];
    next++;
    seen.push(target.name);
    const body = await readNodeBody(clientReq);
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: target.port,
        method: clientReq.method,
        path: clientReq.url,
        headers: { ...clientReq.headers, host: `127.0.0.1:${target.port}` },
      },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode ?? 502, {
          ...upstreamRes.headers,
          "x-b2-mcp-replica": target.name,
        });
        upstreamRes.pipe(clientRes);
      },
    );
    upstream.on("error", () => {
      clientRes.writeHead(502, { "x-b2-mcp-replica": target.name });
      clientRes.end();
    });
    upstream.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    seen,
    setTargets(nextTargets: Replica[]) {
      targets = [...nextTargets];
      next = 0;
    },
  };
}

function parseBody(body: string): any {
  return JSON.parse(body);
}

describe("HTTP round-robin replica smoke (MCP 2026-07-28)", () => {
  const replicas: Replica[] = [];
  let proxy: ProxyHandle | null = null;

  afterEach(async () => {
    if (proxy) {
      await new Promise<void>((resolve) => proxy?.server.close(() => resolve()));
      proxy = null;
    }
    await Promise.all(replicas.splice(0).map(stopReplica));
  });

  it("routes idempotent modern requests across replicas without session affinity", async () => {
    replicas.push(await startReplica("replica-a"));
    replicas.push(await startReplica("replica-b"));
    proxy = await startRoundRobinProxy(replicas);

    const discover = await request(proxy.port, "POST", "/mcp", {
      headers: { ...HTTP_CREDS, ...modernHeaders("server/discover") },
      body: modernBody("server/discover", {}, 1),
    });
    const listAReplicaB = await request(proxy.port, "POST", "/mcp", {
      headers: { ...HTTP_CREDS, ...modernHeaders("tools/list") },
      body: modernBody("tools/list", {}, 2),
    });
    const listAReplicaA = await request(proxy.port, "POST", "/mcp", {
      headers: { ...HTTP_CREDS, ...modernHeaders("tools/list") },
      body: modernBody("tools/list", {}, 3),
    });
    const callA = await request(proxy.port, "POST", "/mcp", {
      headers: { ...HTTP_CREDS, ...modernHeaders("tools/call", "b2_list_buckets") },
      body: modernBody("tools/call", { name: "b2_list_buckets", arguments: {} }, 4),
    });
    const listBPrincipal = await request(proxy.port, "POST", "/mcp", {
      headers: {
        "x-b2-mcp-key-id": "protocol-other-key-id",
        "x-b2-mcp-key": "protocol-other-key-secret",
        ...modernHeaders("tools/list"),
      },
      body: modernBody("tools/list", {}, 5),
    });

    expect(discover.status).toBe(200);
    expect(listAReplicaB.status).toBe(200);
    expect(listAReplicaA.status).toBe(200);
    expect(callA.status).toBe(200);
    expect(listBPrincipal.status).toBe(200);
    expect(proxy.seen.slice(0, 5)).toEqual([
      "replica-a",
      "replica-b",
      "replica-a",
      "replica-b",
      "replica-a",
    ]);
    for (const res of [discover, listAReplicaB, listAReplicaA, callA, listBPrincipal]) {
      expect(res.headers["mcp-session-id"]).toBeUndefined();
    }

    const firstNames = parseBody(listAReplicaB.body).result.tools.map(
      (tool: { name: string }) => tool.name,
    );
    const secondNames = parseBody(listAReplicaA.body).result.tools.map(
      (tool: { name: string }) => tool.name,
    );
    const otherPrincipalNames = parseBody(listBPrincipal.body).result.tools.map(
      (tool: { name: string }) => tool.name,
    );
    expect(secondNames).toEqual(firstNames);
    expect(firstNames).toContain("b2_create_bucket");
    expect(otherPrincipalNames).toContain("b2_list_buckets");
    expect(otherPrincipalNames).toContain("s3_list_objects_v2");
    expect(otherPrincipalNames).not.toContain("b2_create_bucket");
    expect(otherPrincipalNames).not.toEqual(firstNames);
    expect(parseBody(callA.body).result.isError).not.toBe(true);

    await stopReplica(replicas[0]);
    proxy.setTargets([replicas[1]]);
    const survivor = await request(proxy.port, "POST", "/mcp", {
      headers: { ...HTTP_CREDS, ...modernHeaders("tools/call", "b2_list_buckets") },
      body: modernBody("tools/call", { name: "b2_list_buckets", arguments: {} }, 6),
    });
    expect(survivor.status).toBe(200);
    expect(survivor.headers["x-b2-mcp-replica"]).toBe("replica-b");
    expect(parseBody(survivor.body).result.isError).not.toBe(true);
  });
});
