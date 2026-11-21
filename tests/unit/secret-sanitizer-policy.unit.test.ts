import type * as http from "http";

// Reload inside each case so mutation coverage includes module-initialized
// policy sets and regular expressions as well as the exported functions.
let sanitizer: typeof import("../../src/utils/secret-sanitizer");
beforeEach(async () => {
  vi.resetModules();
  sanitizer = await import("../../src/utils/secret-sanitizer");
});

const hidden = "[redacted]";
const ordinaryValue = "ordinary-private-value";
const structuredFields = [
  "applicationKey",
  "appKey",
  "authorization",
  "authorizationToken",
  "authToken",
  "bearerToken",
  "customerKey",
  "customerKeyMd5",
  "downloadAuthorizationToken",
  "hmacSha256SigningSecret",
  "masterApplicationKey",
  "masterKey",
  "password",
  "privateKey",
  "secret",
  "secretAccessKey",
  "sessionToken",
  "uploadAuthToken",
  "uploadAuthorizationToken",
  "uploadToken",
  "uploadUrl",
];
const secretHeaders = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-b2-mcp-key",
  "x-b2-mcp-master-key",
  "x-b2-key",
  "x-b2-master-key",
  "x-b2-app-key",
  "x-b2-mcp-app-key",
];

describe("independent secret sanitizer policy", () => {
  it.each(["mcp", "log", "error"] as const)(
    "reuses one-shot configured secrets across every %s value",
    (mode) => {
      function* secrets() {
        yield ordinaryValue;
      }
      const options = { env: {}, secrets: secrets() };
      if (mode === "error") {
        const error = Object.assign(new Error(ordinaryValue), { detail: ordinaryValue });
        Object.defineProperty(error, "stack", {
          value: `failure ${ordinaryValue}`,
          configurable: true,
        });
        const safe = sanitizer.sanitizeError(error, options);
        expect(safe.message).toBe(hidden);
        expect(safe.stack).toBe(`failure ${hidden}`);
        expect(safe).toHaveProperty("detail", hidden);
        return;
      }
      const sanitize =
        mode === "mcp" ? sanitizer.sanitizeForMcpOutput : sanitizer.sanitizeStructuredLogValue;
      expect(sanitize({ first: ordinaryValue, nested: [ordinaryValue] }, options)).toEqual({
        first: hidden,
        nested: [hidden],
      });
    },
  );

  it("exports logger paths for secret fields and log-only credential handles", () => {
    const fields = [
      ...structuredFields,
      "accessKeyId",
      "appKeyId",
      "applicationKeyId",
      "masterKeyId",
    ];
    expect(sanitizer.LOGGER_SECRET_REDACTION_PATHS).toEqual([
      ...fields,
      ...fields.map((field) => `*.${field}`),
      ...fields.map((field) => `*.*.${field}`),
      ...fields.map((field) => `*.credentials.${field}`),
      ...fields.map((field) => `*.serverSideEncryption.${field}`),
    ]);
    expect(
      sanitizer.sanitizeStructuredLogValue({ APPLICATION_KEY_ID: ordinaryValue }, { env: {} }),
    ).toEqual({ APPLICATION_KEY_ID: hidden });
    expect(
      sanitizer.sanitizeForMcpOutput({ APPLICATION_KEY_ID: ordinaryValue }, { env: {} }),
    ).toEqual({ APPLICATION_KEY_ID: ordinaryValue });
  });

  it.each(structuredFields)("redacts the structured %s field without a canary", (field) => {
    const separated = field.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();
    for (const key of [field, separated, separated.replace(/_/g, "-")]) {
      for (const sanitize of [
        sanitizer.sanitizeForMcpOutput,
        sanitizer.sanitizeStructuredLogValue,
      ]) {
        expect(sanitize({ nested: { [key]: ordinaryValue } }, { env: {} })).toEqual({
          nested: { [key]: hidden },
        });
      }
    }
  });

  it.each(secretHeaders)("redacts the %s header independently of its value", (header) => {
    const key = header.toUpperCase();
    expect(sanitizer.sanitizeForMcpOutput({ [key]: ordinaryValue }, { env: {} })).toEqual({
      [key]: hidden,
    });
  });

  it("distinguishes suffix secrets from pagination tokens and secret names", () => {
    expect(
      sanitizer.sanitizeForMcpOutput(
        {
          clientSecret: ordinaryValue,
          renewalToken: ordinaryValue,
          secretName: "public-name",
          continuationToken: "page-one",
          nextContinuationToken: "page-two",
          nextToken: "page-three",
          tokenCount: 2,
        },
        { env: {} },
      ),
    ).toEqual({
      clientSecret: hidden,
      renewalToken: hidden,
      secretName: "public-name",
      continuationToken: "page-one",
      nextContinuationToken: "page-two",
      nextToken: "page-three",
      tokenCount: 2,
    });
  });

  it("redacts custom-header values only inside the custom-header path", () => {
    const input = {
      value: "public-root",
      other: { value: "public-nested" },
      CUSTOM_HEADERS: [{ name: "X-Private", value: ordinaryValue }],
      customHeaders: { nested: { value: ordinaryValue, label: "public-label" } },
    };
    const expected = {
      value: "public-root",
      other: { value: "public-nested" },
      CUSTOM_HEADERS: [{ name: "X-Private", value: hidden }],
      customHeaders: { nested: { value: hidden, label: "public-label" } },
    };
    expect(sanitizer.sanitizeForMcpOutput(input, { env: {} })).toEqual(expected);
    expect(sanitizer.sanitizeStructuredLogValue(input, { env: {} })).toEqual(expected);
    const array = Object.assign(["public-item"], { customHeaders: { value: ordinaryValue } });
    expect(sanitizer.sanitizeForMcpOutput(array, { env: {} })).toEqual(
      Object.assign(["public-item"], { customHeaders: { value: hidden } }),
    );
  });

  it.each([
    ...structuredFields,
    ...secretHeaders,
    "AWS_SECRET_ACCESS_KEY",
    "B2_APPLICATION_KEY",
    "B2_MASTER_KEY",
    "B2_APP_KEY",
  ])("redacts the literal text label %s with ordinary values", (label) => {
    expect(sanitizer.sanitizeText(`${label}=${ordinaryValue}`, { env: {} })).toBe(
      `${label}=${hidden}`,
    );
    expect(
      sanitizer.sanitizeText(`'${label.toUpperCase()}': '${ordinaryValue}', keep`, { env: {} }),
    ).toBe(`'${label.toUpperCase()}': '${hidden}', keep`);
  });

  it("redacts every standalone bearer/basic credential and preserves its prefix", () => {
    expect(
      sanitizer.sanitizeText("Bearer  abcD0123 Basic\t+/_.~=-9 Bearer tiny", { env: {} }),
    ).toBe(`Bearer  ${hidden} Basic\t${hidden} Bearer tiny`);
    const missingSeparator = `Bearer${"0123abcd"}`;
    expect(sanitizer.sanitizeText(missingSeparator, { env: {} })).toBe(missingSeparator);
  });

  it("keeps redaction markers, short candidates, blanks, and unrelated env values intact", () => {
    expect(
      sanitizer.configuredSecretValuesFromConfig({
        applicationKey: "        ",
        appKey: hidden,
        masterKey: "1234567",
        secretAccessKey: "12345678",
        authorizationToken: 123456789,
      }),
    ).toEqual(["12345678"]);
    expect(
      sanitizer.sanitizeText(`public text 1234567 ${hidden}         public-env-value`, {
        env: { PUBLIC_SETTING: "public-env-value", B2_APPLICATION_KEY: "        " },
        secrets: ["1234567", hidden, null],
      }),
    ).toBe(`public text 1234567 ${hidden}         public-env-value`);
    expect(
      sanitizer.redactExactTextSecrets(`left         ${hidden} right`, ["        ", hidden]),
    ).toBe(`left         ${hidden} right`);
    const alreadySafe = `appKey=${hidden} password=${hidden}`;
    expect(sanitizer.sanitizeText(alreadySafe, { env: {} })).toBe(alreadySafe);
    expect(sanitizer.redactExactTextSecrets(`${hidden}${hidden}`, [hidden])).toBe(
      `${hidden}${hidden}`,
    );
  });

  it.each([
    "AWS_SECRET_ACCESS_KEY",
    "B2_APPLICATION_KEY",
    "B2_MASTER_KEY",
    "B2_APP_KEY",
    "B2_CREDENTIAL_TENANT_APPLICATION_KEY",
    "B2_CREDENTIAL_TENANT_MASTER_KEY",
    "B2_CREDENTIAL_TENANT_APP_KEY",
  ])("redacts configured %s values case insensitively", (name) => {
    expect(
      sanitizer.sanitizeText(`before ${ordinaryValue} after`, {
        env: { [name.toLowerCase()]: ordinaryValue },
      }),
    ).toBe(`before ${hidden} after`);
  });

  it.each([
    "B2_APPLICATION_KEY_ID",
    "B2_MASTER_KEY_ID",
    "B2_APP_KEY_ID",
    "B2_CREDENTIAL_TENANT_APPLICATION_KEY_ID",
    "B2_CREDENTIAL_TENANT_MASTER_KEY_ID",
    "B2_CREDENTIAL_TENANT_APP_KEY_ID",
  ])("redacts %s only in log mode, retaining explicit secrets", (name) => {
    const options = { env: { [name.toLowerCase()]: "handle-12345678" }, secrets: [ordinaryValue] };
    expect(sanitizer.sanitizeStructuredLogValue(`handle-12345678 ${ordinaryValue}`, options)).toBe(
      `${hidden} ${hidden}`,
    );
    expect(sanitizer.sanitizeForMcpOutput(`handle-12345678 ${ordinaryValue}`, options)).toBe(
      `handle-12345678 ${hidden}`,
    );
  });

  it("ignores env names outside the complete credential naming contract", () => {
    const env = Object.fromEntries(
      [
        "PREFIX_B2_CREDENTIAL_TENANT_APP_KEY",
        "B2_CREDENTIAL_TENANT_MASTER_KEY_SUFFIX",
        "PREFIX_B2_CREDENTIAL_TENANT_APP_KEY_ID",
        "B2_CREDENTIAL_TENANT_MASTER_KEY_ID_SUFFIX",
        "B2_CREDENTIAL__APP_KEY",
        "B2_CREDENTIAL_bad-name_APP_KEY_ID",
        "PUBLIC_SETTING",
      ].map((name, index) => [name, `public-value-${index}`]),
    );
    const text = Object.values(env).join(" ");
    expect(sanitizer.sanitizeText(text, { env })).toBe(text);
    expect(sanitizer.sanitizeStructuredLogValue(text, { env })).toBe(text);
  });

  it("merges adjacent exact matches and preserves text around disjoint matches", () => {
    expect(sanitizer.redactExactTextSecrets("left abcdabcd right xy end", ["abcd", "xy"])).toBe(
      `left ${hidden} right ${hidden} end`,
    );
    expect(sanitizer.redactExactTextSecrets("unchanged", [])).toBe("unchanged");
  });

  it("omits non-enumerable properties and preserves sparse array length", () => {
    const value = Object.defineProperty({ visible: "public" }, "privateNote", {
      enumerable: false,
      value: ordinaryValue,
    });
    expect(sanitizer.sanitizeForMcpOutput(value, { env: {} })).toEqual({ visible: "public" });
    const array = new Array(4);
    array[1] = "public";
    const safe = sanitizer.sanitizeForMcpOutput(array, { env: {} }) as unknown[];
    expect(safe).toHaveLength(4);
    expect(Object.keys(safe)).toEqual(["1"]);
    expect(safe[1]).toBe("public");
  });

  it("uses literal inert sentinels without conflating MCP and log representations", () => {
    const value = {
      fn: () => ordinaryValue,
      date: new Date(Number.NaN),
      bytes: Buffer.from("ordinary data"),
    };
    expect(sanitizer.sanitizeStructuredLogValue(value, { env: {} })).toEqual({
      fn: "[function]",
      date: "[invalid_date]",
      bytes: { type: "Buffer", byteLength: 13 },
    });
    const callable = sanitizer.sanitizeForMcpOutput(value, { env: {} }) as typeof value;
    expect(callable.fn).toBe(value.fn);
    expect(callable.date).toBe(value.date);
    expect(callable.bytes).toBe(value.bytes);
    expect(sanitizer.safeErrorText(Object.create(null), [])).toBe("[log_sanitizer_failed]");
    expect(sanitizer.sanitizeText({ toString: () => "plain value" }, { env: {} })).toBe(
      "plain value",
    );
  });

  it("sanitizes error metadata paths and non-string core fields without coercing objects", () => {
    const error = new Error("public-message");
    Object.defineProperties(error, {
      name: { value: false, configurable: true },
      stack: { value: {}, configurable: true },
      privateKey: { value: ordinaryValue, enumerable: true },
      customHeaders: { value: [{ value: ordinaryValue }], enumerable: true },
    });
    const safe = sanitizer.sanitizeError(error, { env: {} });
    expect(safe.message).toBe("public-message");
    expect(safe.name).toBe("false");
    expect(safe.stack).toBe("[accessor]");
    expect(safe).toMatchObject({ privateKey: hidden, customHeaders: [{ value: hidden }] });
    const circular = Object.assign(new Error("public-message"), { self: error });
    Object.assign(circular, { self: circular });
    expect(sanitizer.sanitizeError(circular, { env: {} })).toMatchObject({ self: "[circular]" });
    expect(sanitizer.sanitizeError("ordinary failure", { env: {} }).message).toBe(
      "ordinary failure",
    );
  });

  it("keeps Error core fields out of MCP objects and credential handles out of logs", () => {
    const error = Object.assign(new Error("public-message"), {
      applicationKeyId: "public-key-handle",
      metadata: { applicationKeyId: "public-key-handle", callback: () => "public" },
    });
    expect(sanitizer.sanitizeForMcpOutput(error, { env: {} })).toEqual({
      applicationKeyId: "public-key-handle",
      metadata: error.metadata,
    });
    expect(sanitizer.sanitizeError(error, { env: {} })).toMatchObject({
      message: "public-message",
      applicationKeyId: hidden,
      metadata: { applicationKeyId: hidden, callback: "[function]" },
    });
  });

  it("reads inherited Error names from descriptors without invoking inherited accessors", () => {
    const error = new Error("public-message");
    const prototype = Object.create(Error.prototype, { name: { value: "ProviderFault" } });
    Object.setPrototypeOf(error, prototype);
    expect(sanitizer.sanitizeError(error, { env: {} }).name).toBe("ProviderFault");

    const accessor = vi.fn(() => "do not invoke");
    Object.setPrototypeOf(error, Object.create(Error.prototype, { name: { get: accessor } }));
    expect(sanitizer.sanitizeError(error, { env: {} }).name).toBe("[accessor]");
    expect(accessor).not.toHaveBeenCalled();
  });

  it.each(["a", "A0_.:/+=-z", `a${"x".repeat(255)}`])("preserves valid request ID %s", (id) => {
    expect(sanitizer.sanitizeProviderRequestId(id, { env: {} })).toBe(id);
  });
  it.each(["!abc", "abc!", "_abc", "abc\n", `a${"x".repeat(256)}`])(
    "rejects invalid request ID %s",
    (id) => {
      expect(sanitizer.sanitizeProviderRequestId(id, { env: {} })).toBe(hidden);
    },
  );

  it("extracts trimmed authorization credentials independently of their header scheme", () => {
    expect(
      sanitizer.nodeRequestSecrets({
        headers: {
          authorization: ["  Custom   short-credential  ", "NoScheme", "Scheme   "],
        },
      } as unknown as http.IncomingMessage),
    ).toEqual(["  Custom   short-credential  ", "short-credential", "NoScheme", "Scheme   "]);
  });

  it("extracts cookie pairs and quoted values while ignoring empty segments", () => {
    const cookie = ' a = "short" ; bare ; empty= ; ; token=unquoted ';
    expect(
      sanitizer.nodeRequestSecrets({
        headers: { cookie: [cookie] },
      } as unknown as http.IncomingMessage),
    ).toEqual([
      cookie,
      'a = "short"',
      '"short"',
      "short",
      "bare",
      "empty=",
      "token=unquoted",
      "unquoted",
    ]);
    const malformed = 'a=prefix"value"; b="value"suffix; empty=""';
    expect(sanitizer.webRequestSecrets(new Headers({ cookie: malformed }))).toEqual([
      malformed,
      'a=prefix"value"',
      'prefix"value"',
      'b="value"suffix',
      '"value"suffix',
      'empty=""',
      '""',
    ]);
  });

  it.each([
    "authorization",
    "cookie",
    "x-b2-mcp-key",
    "x-b2-mcp-key-id",
    "x-b2-mcp-master-key",
    "x-b2-mcp-master-key-id",
    "x-b2-key",
    "x-b2-key-id",
    "x-b2-master-key",
    "x-b2-master-key-id",
    "x-b2-app-key",
    "x-b2-app-key-id",
    "x-b2-mcp-app-key",
    "x-b2-mcp-app-key-id",
  ])("extracts and redacts the request %s header", (name) => {
    const secrets = sanitizer.webRequestSecrets(
      new Headers({ [name]: ordinaryValue, "x-public": "public-value" }),
    );
    expect(secrets).toEqual([ordinaryValue, ...(name === "cookie" ? [ordinaryValue] : [])]);
    expect(sanitizer.safeErrorText(`before ${ordinaryValue} after`, secrets)).toBe(
      `before ${hidden} after`,
    );
  });
});
