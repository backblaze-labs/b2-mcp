import { createVercelNodeHandler } from "../deploy/vercel/node-function.js";
import { DELETE, GET, POST } from "../deploy/vercel/routes.js";

const routeByMethod: Record<string, typeof GET> = {
  DELETE,
  GET,
  POST,
};

export default createVercelNodeHandler((request) => {
  const route = routeByMethod[request.method.toUpperCase()];
  if (!route) {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        Allow: "GET, POST, DELETE",
      },
    });
  }
  return route(request);
});
