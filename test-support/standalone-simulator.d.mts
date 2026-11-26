import type { HttpTransport } from "@backblaze-labs/b2-sdk";

/**
 * Environment variable naming a local checkout of the standalone simulator
 * (`backblaze-labs/b2-simulator`). Simulator-backed tests start their own
 * server from it; when it is missing they fail, they never skip.
 */
export declare const SIMULATOR_DIR_ENV: "B2_SIMULATOR_DIR";

/**
 * Start settings that reproduce the SDK's former in-process simulator defaults:
 * its behaviour profile, any credential accepted (`strictAuth: false`), and v3
 * authorize not routed to the Partner authorizer unless a reset asks for it.
 */
export declare const IN_PROCESS_COMPATIBLE_ARGS: readonly string[];

/** Files of a b2-simulator checkout that the harness uses. */
export interface SimulatorCheckout {
  /** `bin/simulator/serve.mjs`, the server entry point. */
  readonly serveScript: string;
  /** `bin/simulator/loopback-cert.pem`, the certificate its HTTPS listener presents. */
  readonly caCertPath: string;
}

/**
 * Engine settings a reset may select (the simulator's `--config` keys; see its
 * docs/CONTRACT.md, "Reset"). Only the ones these tests use are typed.
 */
export interface SimulatorConfig {
  minimumPartSize?: number;
  recommendedPartSize?: number;
  partnerAuthorize?: boolean;
  authTokenTtlMs?: number;
  strictAuth?: boolean;
}

/** A fault for the control plane's `POST /faults` (the old in-process `injectFailure` spec). */
export interface SimulatorFault {
  readonly on: string;
  readonly status: number;
  readonly code: string;
  readonly message?: string;
  readonly count?: number;
  readonly skip?: number;
  readonly retryAfter?: number;
}

/** Handle for one injected fault. */
export interface SimulatorFaultHandle {
  readonly id: number;
  /** Clear this fault (`DELETE /faults/<id>`). */
  clear(): Promise<void>;
}

/** A running standalone simulator owned by one test file (or one entrypoint process). */
export interface StandaloneSimulator {
  /** Process id of the server, for lifecycle checks. */
  readonly pid: number;
  /** `http://127.0.0.1:<port>`: native B2 API, S3 and downloads. */
  readonly httpOrigin: string;
  /** `https://127.0.0.1:<port>`: the same store over TLS, with {@link caCertPath}. */
  readonly httpsOrigin: string;
  /** `http://127.0.0.1:<port>`: the control plane (reset, faults, clock). */
  readonly controlOrigin: string;
  /** The certificate the HTTPS listener presents. */
  readonly caCertPath: string;
  /**
   * An SDK transport that sends every request to {@link httpOrigin}, whatever
   * origin the client used (the default production realm included), and
   * answers JSON with that origin in place of the loopback one, as the SDK's
   * in-process simulator transport did.
   */
  transport(): HttpTransport;
  /** Empty the store, faults and clock; `config` selects engine settings until the next reset. */
  reset(config?: SimulatorConfig): Promise<void>;
  /** Inject an API fault. */
  injectFailure(fault: SimulatorFault): Promise<SimulatorFaultHandle>;
  /** Move the simulator clock forward. */
  advanceTime(ms: number): Promise<void>;
  /** Stop the server and wait for it to exit. */
  stop(): Promise<void>;
}

/** Options for {@link startStandaloneSimulator}. */
export interface StartSimulatorOptions {
  /** Environment used to find the checkout (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Extra `serve.mjs` arguments. */
  extraArgs?: string[];
  /** How long to wait for the listening lines (default 15 s). */
  startTimeoutMs?: number;
}

/**
 * Find the simulator checkout named by {@link SIMULATOR_DIR_ENV}.
 *
 * @param env - Environment to read (defaults to `process.env`).
 *
 * @returns Paths of the serve script and loopback certificate.
 *
 * @throws Error naming the variable when it is unset, relative, or does not
 * point at a b2-simulator checkout.
 */
export declare function resolveSimulatorServeScript(env?: NodeJS.ProcessEnv): SimulatorCheckout;

/**
 * A transport to the simulator at `origin` that answers at the requested origin.
 *
 * @param origin - The simulator's HTTP origin.
 *
 * @returns The SDK transport.
 */
export declare function originRewritingTransport(origin: string): HttpTransport;

/**
 * Start a standalone simulator from the checkout named by
 * {@link SIMULATOR_DIR_ENV}, with {@link IN_PROCESS_COMPATIBLE_ARGS}.
 *
 * @remarks
 * One server per test file: Vitest runs files in separate workers, so files
 * never share a store; tests inside a file call `reset()` in `beforeEach`.
 *
 * @param options - Discovery environment, extra arguments and start timeout.
 *
 * @returns The running simulator.
 *
 * @throws Error when the checkout is missing or the server does not start.
 */
export declare function startStandaloneSimulator(
  options?: StartSimulatorOptions,
): Promise<StandaloneSimulator>;
