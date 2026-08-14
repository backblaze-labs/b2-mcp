export function methodNotAllowed(
  request: Request,
  allowedMethods: readonly string[],
): Response | null {
  const normalized = request.method.toUpperCase();
  if (allowedMethods.includes(normalized)) return null;
  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: {
      "Content-Type": "application/json",
      Allow: allowedMethods.join(", "),
    },
  });
}
