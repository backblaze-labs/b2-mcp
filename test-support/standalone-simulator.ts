// Typed entry point for TypeScript tests. The implementation is plain ESM
// (standalone-simulator.mjs) so the protocol entrypoint shares it.
export {
  IN_PROCESS_COMPATIBLE_ARGS,
  SIMULATOR_DIR_ENV,
  originRewritingTransport,
  resolveSimulatorServeScript,
  startStandaloneSimulator,
} from "./standalone-simulator.mjs";
export type {
  SimulatorCheckout,
  SimulatorConfig,
  SimulatorFault,
  SimulatorFaultHandle,
  StandaloneSimulator,
  StartSimulatorOptions,
} from "./standalone-simulator.mjs";
