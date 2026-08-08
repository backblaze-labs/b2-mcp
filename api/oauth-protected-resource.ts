import { createVercelNodeHandler } from "../deploy/vercel/node-function.js";
import { OAUTH_PROTECTED_RESOURCE } from "../deploy/vercel/routes.js";

export default createVercelNodeHandler((request) => {
  if (request.method.toUpperCase() !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", Allow: "GET" },
    });
  }
  return OAUTH_PROTECTED_RESOURCE();
});
