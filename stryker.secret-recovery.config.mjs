import base from "./stryker.config.mjs";
import profiles from "./scripts/lib/mutation-profiles.cjs";

// Named durable-secret recovery declarations.
export default profiles.mutationProfileConfig("secret-recovery", base);
