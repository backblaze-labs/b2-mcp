import profiles from "./scripts/lib/mutation-profiles.cjs";
import base from "./stryker.config.mjs";

// Bounded JWKS/cache failure and recovery declarations.
export default profiles.mutationProfileConfig("jwks-cache", base);
