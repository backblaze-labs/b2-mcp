import { createVercelNodeHandler, type FetchRouteContext } from "../deploy/vercel/node-function.js";
import { methodNotAllowed } from "../deploy/vercel/method-guard.js";
import { mcpDeleteRoute, mcpGetRoute, mcpPostRoute } from "../deploy/vercel/routes.js";

const routeByMethod: Record<string, typeof mcpGetRoute> = {
  DELETE: mcpDeleteRoute,
  GET: mcpGetRoute,
  POST: mcpPostRoute,
};

export default createVercelNodeHandler((request, context: FetchRouteContext) => {
  const rejected = methodNotAllowed(request, ["GET", "POST", "DELETE"]);
  if (rejected) return rejected;
  const route = routeByMethod[request.method.toUpperCase()];
  return route(request, context);
});
