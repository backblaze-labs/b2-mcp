// The simulator's fault-control plane, as a resilience check uses it: arm one documented fault, move
// the clock, read the journal of what the simulator saw. The harness starts the simulator with the
// control listener and hands its address in SDKHARNESS_SIMULATOR_CONTROL_URL. A check chooses WHEN to
// arm a fault (after its own setup), never what the fault is: each scenario names the one fault of
// the harness's scenario list. See ../../README.md.

const URL_SHAPE = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/?$/;

export function controlUrl() {
  const url = process.env.SDKHARNESS_SIMULATOR_CONTROL_URL ?? "";
  if (!URL_SHAPE.test(url)) {
    throw new Error("SDKHARNESS_SIMULATOR_CONTROL_URL must be an IPv4 loopback http origin");
  }
  return url.replace(/\/$/, "");
}

async function control(method, path, body) {
  const response = await fetch(`${controlUrl()}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`control ${method} ${path}: ${response.status} ${text.slice(0, 120)}`);
  return text ? JSON.parse(text) : {};
}

/** Arm one fault on one endpoint, once: the next call to `on` answers `status`/`code`. */
export function armFault({ on, status, code, retryAfter }) {
  return control("POST", "/faults", {
    on,
    status,
    code,
    ...(retryAfter === undefined ? {} : { retryAfter }),
    count: 1,
  });
}

/** Advance the simulator's clock; it never rewinds. Tokens issued before it age by that much. */
export function advanceClock(advanceMs) {
  return control("POST", "/clock", { advanceMs });
}

/** What the simulator saw, in order: {seq, method, endpoint, status, fault, ...}. No header or body. */
export async function journal() {
  return (await control("GET", "/journal")).entries;
}
