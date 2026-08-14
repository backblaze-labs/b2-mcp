import { createVercelNodeHandler, type FetchRouteContext } from "../deploy/vercel/node-function.js";
import { methodNotAllowed } from "../deploy/vercel/method-guard.js";
import { mcpRoute } from "../deploy/vercel/routes.js";

export default createVercelNodeHandler((request, context: FetchRouteContext) => {
  const rejected = methodNotAllowed(request, ["GET", "POST", "DELETE"]);
  if (rejected) return rejected;
  return mcpRoute(request, context);
});
