import base from "./stryker.config.mjs";
import profiles from "./scripts/lib/mutation-profiles.cjs";

// Named trust-boundary declarations; see demand-side-ai #2006.
export default profiles.mutationProfileConfig("http-oauth", base);
