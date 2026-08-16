export function introspectionClaims(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    active: true,
    iss: "https://issuer.example.com/",
    sub: "subject",
    aud: ["https://mcp.example.com/mcp"],
    resource: ["https://mcp.example.com/mcp"],
    exp: Math.floor(Date.now() / 1000) + 600,
    token_type: "bearer",
    alg: "RS256",
    scope: "b2:read",
    client_id: "client",
    ...overrides,
  };
}

export function introspectionResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify(introspectionClaims(overrides)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
