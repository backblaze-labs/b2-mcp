const {
  createVercelNodeHandler,
} = require("../.vercel/build-runtime/deploy/vercel/node-function.js");
const { methodNotAllowed } = require("../.vercel/build-runtime/deploy/vercel/method-guard.js");
const { mcpRoute } = require("../.vercel/build-runtime/deploy/vercel/routes.js");

const handler = createVercelNodeHandler((request, context) => {
  const rejected = methodNotAllowed(request, ["GET", "POST", "DELETE"]);
  if (rejected) return rejected;
  return mcpRoute(request, context);
});

module.exports = handler;
module.exports.default = handler;
