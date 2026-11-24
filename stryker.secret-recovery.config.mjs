import base from "./stryker.config.mjs";
import profiles from "./scripts/lib/mutation-profiles.cjs";

// Named durable-secret recovery declarations; see demand-side-ai #2006.
export default profiles.mutationProfileConfig("secret-recovery", base);
