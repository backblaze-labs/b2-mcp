import { encodeToon } from "../../src/utils/toon-encoder";

type ToonValue = Parameters<typeof encodeToon>[0];
type ToonObject = { [key: string]: ToonValue };

describe("TOON encoder", () => {
  it.each([
    ["plain string", "plain", "plain"],
    ["empty string", "", '""'],
    ["leading whitespace", " leading", '" leading"'],
    ["trailing whitespace", "trailing ", '"trailing "'],
    ["boolean-like string", "true", '"true"'],
    ["null-like string", "null", '"null"'],
    ["numeric-like string", "1e3", '"1e3"'],
    ["colon delimiter", "name:value", '"name:value"'],
    ["comma delimiter", "alpha,beta", '"alpha,beta"'],
    ["brackets", "a[b]", '"a[b]"'],
    ["braces", "a{b}", '"a{b}"'],
    ["dash prefix", "-dash", '"-dash"'],
    ["comment prefix", "#hash", '"#hash"'],
    [
      "escaped characters",
      'quote " slash \\ tab\t cr\r newline\n ctrl\u0001',
      '"quote \\" slash \\\\ tab\\t cr\\r newline\\n ctrl\\u0001"',
    ],
    ["number", 42, "42"],
    ["true boolean", true, "true"],
    ["false boolean", false, "false"],
    ["null", null, "null"],
  ])("encodes primitive %s deterministically", (_name, value, expected) => {
    expect(encodeToon(value)).toBe(expected);
  });

  it("quotes unsafe object keys and rejects unpaired surrogates", () => {
    const pairedSurrogate = "\u{1f600}";

    expect(
      encodeToon({
        "safe.key_1": "v",
        "bad,key": "x",
        " spaced key": "y",
        "a{b}c": "z",
        pairedSurrogate,
      }),
    ).toBe(
      [
        "safe.key_1: v",
        '"bad,key": x',
        '" spaced key": y',
        '"a{b}c": z',
        `pairedSurrogate: ${pairedSurrogate}`,
      ].join("\n"),
    );
    expect(() => encodeToon({ bad: "\uD800" })).toThrow(/unpaired surrogate U\+D800/);
    expect(() => encodeToon({ low: "\uDC00" })).toThrow(/unpaired surrogate U\+DC00/);
    expect(() => encodeToon({ ["bad\uD800"]: "v" })).toThrow(
      /object key containing an unpaired surrogate U\+D800/,
    );
  });

  it("encodes empty containers and deeply nested mixed values with stable indentation", () => {
    expect(encodeToon({})).toBe("");
    expect(encodeToon([])).toBe("[]");
    expect(encodeToon({ emptyObject: {}, emptyArray: [] })).toBe(
      ["emptyObject:", "emptyArray: []"].join("\n"),
    );

    expect(
      encodeToon({
        outer: {
          deep: { level: { value: "done" } },
          empty: {},
          list: [1, { two: 2 }, [3, [4]], []],
        },
      }),
    ).toBe(
      [
        "outer:",
        "  deep:",
        "    level:",
        "      value: done",
        "  empty:",
        "  list[4]:",
        "    - 1",
        "    - two: 2",
        "    - [2]:",
        "      - 3",
        "      - [1]: 4",
        "    - [0]:",
      ].join("\n"),
    );
  });

  it("encodes arrays of primitive arrays as list items", () => {
    expect(
      encodeToon({
        matrix: [
          ["a", 1],
          ["b", 2],
        ],
      }),
    ).toBe(["matrix[2]:", "  - [2]: a,1", "  - [2]: b,2"].join("\n"));
    expect(
      encodeToon([
        ["a", 1],
        ["b", 2],
      ]),
    ).toBe(["[2]:", "  - [2]: a,1", "  - [2]: b,2"].join("\n"));
  });

  it("uses tabular encoding for compatible arrays and keyed objects", () => {
    expect(
      encodeToon({
        buckets: [
          { bucketName: "alpha", stats: { objects: 2, bytes: 10 }, isPublic: false },
          { bucketName: "beta", stats: { objects: 0, bytes: 0 }, isPublic: true },
        ],
      }),
    ).toBe(
      [
        "buckets[2]{bucketName,stats{objects,bytes},isPublic}:",
        "  alpha,2,10,false",
        "  beta,0,0,true",
      ].join("\n"),
    );

    expect(
      encodeToon({
        alpha: { fileCount: 1, bytes: 10 },
        beta: { fileCount: 2, bytes: 20 },
      }),
    ).toBe(["[2:]{fileCount,bytes}:", "  alpha: 1,10", "  beta: 2,20"].join("\n"));

    expect(
      encodeToon({
        accounts: {
          alpha: { enabled: true, quota: null },
          beta: { enabled: false, quota: 100 },
        },
      }),
    ).toBe(["accounts[2:]{enabled,quota}:", "  alpha: true,null", "  beta: false,100"].join("\n"));
  });

  it.each([
    [
      "primitive field",
      [{ id: 1 }, { other: "sentinel" }],
      ["items[2]:", "  - id: 1", "  - other: sentinel"],
    ],
    ["empty object item", [{}, { other: "sentinel" }], ["items[2]:", "  -", "  - other: sentinel"]],
    [
      "nested tabular array field",
      [
        {
          files: [
            { name: "a", size: 1 },
            { name: "b", size: 2 },
          ],
          note: "ok",
        },
      ],
      ["items[1]:", "  - files[2]{name,size}:", "      a,1", "      b,2", "    note: ok"],
    ],
    [
      "keyed object field",
      [{ lookup: { alpha: { size: 1 }, beta: { size: 2 } }, note: "map" }, { other: "sentinel" }],
      [
        "items[2]:",
        "  - lookup[2:]{size}:",
        "      alpha: 1",
        "      beta: 2",
        "    note: map",
        "  - other: sentinel",
      ],
    ],
    [
      "empty array field",
      [{ first: [], note: "empty" }],
      ["items[1]:", "  - first: []", "    note: empty"],
    ],
    [
      "inline primitive array field",
      [{ first: [1, 2], note: "inline" }],
      ["items[1]:", "  - first[2]: 1,2", "    note: inline"],
    ],
    [
      "nested primitive array field",
      [{ first: [[1], [2]], note: "nested" }],
      ["items[1]:", "  - first[2]:", "      - [1]: 1", "      - [1]: 2", "    note: nested"],
    ],
    [
      "empty object field",
      [{ first: {}, note: "empty-object" }],
      ["items[1]:", "  - first:", "    note: empty-object"],
    ],
    [
      "nested object field",
      [{ first: { nested: 1 }, note: "object" }, { other: "sentinel" }],
      ["items[2]:", "  - first:", "      nested: 1", "    note: object", "  - other: sentinel"],
    ],
  ])(
    "falls back to list items for non-tabular arrays of objects with %s",
    (_name, items, lines) => {
      expect(encodeToon({ items: items as ToonObject[] })).toBe(lines.join("\n"));
    },
  );

  it("encodes large primitive values directly when they are inside encoder limits", () => {
    const value = "x".repeat(4096);

    expect(encodeToon(value)).toBe(value);
  });
});
