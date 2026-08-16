const {
  createVercelNodeHandler,
} = require("../.vercel/build-runtime/deploy/vercel/node-function.js");
const { methodNotAllowed } = require("../.vercel/build-runtime/deploy/vercel/method-guard.js");
const {
  protectedResourceMetadataRoute,
} = require("../.vercel/build-runtime/deploy/vercel/routes.js");

const handler = createVercelNodeHandler((request) => {
  const rejected = methodNotAllowed(request, ["GET"]);
  if (rejected) return rejected;
  return protectedResourceMetadataRoute();
});

module.exports = handler;
module.exports.default = handler;
