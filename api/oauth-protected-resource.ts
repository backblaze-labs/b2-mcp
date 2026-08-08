import { createVercelNodeHandler } from "../deploy/vercel/node-function.js";
import { methodNotAllowed } from "../deploy/vercel/method-guard.js";
import { protectedResourceMetadataRoute } from "../deploy/vercel/routes.js";

export default createVercelNodeHandler((request) => {
  const rejected = methodNotAllowed(request, ["GET"]);
  if (rejected) return rejected;
  return protectedResourceMetadataRoute();
});
