import profiles from "./scripts/lib/mutation-profiles.cjs";
import base from "./stryker.config.mjs";

// Bounded durable ledger and lock recovery declarations.
export default profiles.mutationProfileConfig("ledger-lock", base);
