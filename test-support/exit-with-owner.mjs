// Preloaded (`node --import`) into each standalone simulator the harness starts.
// The harness holds the write end of the simulator's stdin; when the owning
// process exits for any reason, SIGKILL included, that pipe closes and the
// simulator exits too, so no server outlives its test file or entrypoint.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
process.stdin.resume();
