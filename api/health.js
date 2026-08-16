const {
  createVercelNodeHandler,
} = require("../.vercel/build-runtime/deploy/vercel/node-function.js");
const { methodNotAllowed } = require("../.vercel/build-runtime/deploy/vercel/method-guard.js");
const { healthRoute } = require("../.vercel/build-runtime/deploy/vercel/routes.js");

const handler = createVercelNodeHandler((request) => {
  const rejected = methodNotAllowed(request, ["GET"]);
  if (rejected) return rejected;
  return healthRoute(request);
});

module.exports = handler;
module.exports.default = handler;
