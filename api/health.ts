import { createVercelNodeHandler } from "../deploy/vercel/node-function.js";
import { methodNotAllowed } from "../deploy/vercel/method-guard.js";
import { healthRoute } from "../deploy/vercel/routes.js";

export default createVercelNodeHandler((request) => {
  const rejected = methodNotAllowed(request, ["GET"]);
  if (rejected) return rejected;
  return healthRoute(request);
});
