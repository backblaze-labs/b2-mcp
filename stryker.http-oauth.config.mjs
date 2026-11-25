import base from "./stryker.config.mjs";
import profiles from "./scripts/lib/mutation-profiles.cjs";

// Named HTTP and OAuth trust-boundary declarations.
export default profiles.mutationProfileConfig("http-oauth", base);
