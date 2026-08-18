import path from "path";

// Keep the direct Miniflare devDependency pinned to Wrangler's transitive
// workerd release. The current 5.x package is alpha-only; review the pin on
// each Wrangler upgrade and move to stable Miniflare once it exposes this API.
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from "miniflare";

export const WORKER_SMOKE_PUBLIC_URL = "https://mcp.example.com/mcp";
export const WORKER_SMOKE_JWKS_URI = "https://issuer.example.com/.well-known/jwks.json";
export const WORKER_SMOKE_JWKS_SERVICE_BINDING = "B2_CLOUDFLARE_WORKER_SMOKE_JWKS_SERVICE";
export const WORKER_SMOKE_FLAG = "B2_CLOUDFLARE_WORKER_SMOKE";

const WORKER_SMOKE_RSA_PUBLIC_JWK = {
  kty: "RSA",
  n: "pFW3ni6ZrJmRFlXFVaSgTKa18nbzaUZ1O1McAgPosEdrxBKp_j5_l34oGXiA2h-zdr78a1aXhsmIk0mNW_N-D6wCC56yCYVsEjgLEhId-zmrpKd9tcSn5uDWLR5EYrkFbN9qSb2En7Sdvh2xziG2JsL8pu20UufHVGQF5VJ7__wsGl7fPuEalGmadbDobs7XeN7iu_YQjTuHp0FE5nSsTUJkWmSNEgJ4YgrdCa-yv0-S4szRdQNSTUtKFcY7SIHbzlkaEK3TEW-hHDXlc1eI9QEG7ZIjp9QBi7bKvTe5m3Yi4EAUiKHyC-Di9cXUPQl1vfBtPVSfCQLBgxBXqHvSDQ",
  e: "AQAB",
  kid: "worker-smoke-rsa-key",
  alg: "RS256",
  use: "sig",
  key_ops: ["verify"],
};

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function workerSmokeJwt() {
  const now = Math.floor(Date.now() / 1000);
  return [
    base64UrlJson({
      alg: "RS256",
      typ: "at+jwt",
      kid: WORKER_SMOKE_RSA_PUBLIC_JWK.kid,
    }),
    base64UrlJson({
      iss: "https://issuer.example.com/",
      sub: "worker-smoke-subject",
      aud: WORKER_SMOKE_PUBLIC_URL,
      resource: WORKER_SMOKE_PUBLIC_URL,
      scope: "b2:read",
      client_id: "worker-smoke-client",
      iat: now,
      exp: now + 300,
    }),
    Buffer.from("invalid worker smoke signature").toString("base64url"),
  ].join(".");
}

function workerSmokeMcpBody() {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: {
        name: "cloudflare-worker-jwks-smoke",
        version: "0.0.0",
      },
    },
  });
}

function jwksMockWorkerScript() {
  return `
let jwksHits = 0;
const jwk = ${JSON.stringify(WORKER_SMOKE_RSA_PUBLIC_JWK)};

export default {
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/jwks.json") {
      jwksHits += 1;
      return Response.json({ keys: [jwk] }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/__jwks-hits") {
      return Response.json({ jwksHits });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};
`;
}

async function withTimeout(label, timeoutMs, operation) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(), timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
}

function createDeadline(label, timeoutMs) {
  const expiresAt = Date.now() + timeoutMs;
  return {
    remaining(step) {
      const remainingMs = expiresAt - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`${label} timed out after ${timeoutMs}ms before ${step}`);
      }
      return remainingMs;
    },
  };
}

async function withDeadline(deadline, label, operation) {
  return withTimeout(label, deadline.remaining(label), operation);
}

export function workerJwksSmokeVars(baseVars) {
  return {
    ...baseVars,
    [WORKER_SMOKE_FLAG]: "true",
    B2_OAUTH_ALLOWED_ALGORITHMS: "RS256",
    B2_OAUTH_ALLOWED_TOKEN_TYPES: "bearer",
    B2_OAUTH_JWKS_CACHE_TTL_SECONDS: "300",
    B2_OAUTH_JWKS_RETRIES: "0",
    B2_OAUTH_JWKS_TIMEOUT_MS: "2000",
    B2_OAUTH_JWKS_URI: WORKER_SMOKE_JWKS_URI,
  };
}

export async function runMiniflareJwksSmoke(config, workerScript, bindings, timeoutMs) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      log: new Log(LogLevel.ERROR),
      logRequests: false,
      workers: [
        {
          name: "b2-mcp-worker-smoke",
          rootPath: path.dirname(workerScript),
          scriptPath: path.basename(workerScript),
          modules: true,
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags,
          bindings,
          serviceBindings: {
            [WORKER_SMOKE_JWKS_SERVICE_BINDING]: "jwks-mock",
          },
        },
        {
          name: "jwks-mock",
          script: jwksMockWorkerScript(),
          modules: true,
          compatibilityDate: config.compatibility_date,
        },
      ],
    }),
  );
  let failure;
  let result;
  const deadline = createDeadline("JWKS smoke", timeoutMs);

  try {
    const response = await withDeadline(deadline, "JWKS smoke /mcp dispatchFetch", () =>
      mf.dispatchFetch(WORKER_SMOKE_PUBLIC_URL, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${workerSmokeJwt()}`,
          "Content-Type": "application/json",
        },
        body: workerSmokeMcpBody(),
      }),
    );
    const responseBody = await withDeadline(deadline, "JWKS smoke /mcp response body", () =>
      response.text(),
    );
    const mockWorker = await withDeadline(deadline, "JWKS smoke mock worker lookup", () =>
      mf.getWorker("jwks-mock"),
    );
    const hitsResponse = await withDeadline(deadline, "JWKS smoke mock fetch inspection", () =>
      mockWorker.fetch("https://issuer.example.com/__jwks-hits"),
    );
    const hitsBody = await withDeadline(deadline, "JWKS smoke mock hit JSON", () =>
      hitsResponse.json(),
    );
    const jwksHits = hitsBody?.jwksHits;

    if (jwksHits !== 1) {
      failure = `JWKS smoke expected the mock to receive 1 request, got ${JSON.stringify(
        hitsBody,
      )}; /mcp returned ${response.status}: ${responseBody}`;
    } else if (response.status !== 401) {
      failure = `JWKS smoke expected /mcp to fail closed with 401 after JWKS, got ${response.status}: ${responseBody}`;
    } else if (!response.headers.get("www-authenticate")?.includes('error="invalid_token"')) {
      failure = `JWKS smoke expected an invalid_token challenge, got ${response.headers.get(
        "www-authenticate",
      )}`;
    } else {
      result = { mcpStatus: response.status, jwksHits };
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await withTimeout("JWKS smoke Miniflare dispose", timeoutMs, () => mf.dispose());
    } catch (error) {
      const disposeFailure = error instanceof Error ? error.message : String(error);
      failure = failure ? `${failure}; ${disposeFailure}` : disposeFailure;
    }
  }

  if (failure) throw new Error(failure);
  return result;
}
