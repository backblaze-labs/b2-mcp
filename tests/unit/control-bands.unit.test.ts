import { join } from "path";
import { pathToFileURL } from "url";

const root = join(__dirname, "../..");

type Tier = { tier: string; rule?: string; reading: number; mean: number; sigma: number };

async function load() {
  const detect = (await import(pathToFileURL(join(root, "ops/control-bands/detect.mjs")).href)) as {
    tier: (readings: number[]) => Tier;
    MIN_BASELINE: number;
  };
  const readings = (await import(
    pathToFileURL(join(root, "ops/control-bands/readings.mjs")).href
  )) as {
    dailyFailureRates: (
      runs: Array<{ created_at: string; conclusion: string | null }>,
      now?: Date,
    ) => number[];
  };
  return { ...detect, ...readings };
}

// A noisy but stable baseline: mean 0.1, sample stdev well above MIN_SIGMA.
const baseline = [0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2];

describe("control-band detector", () => {
  it("reports no breach for a reading at the mean", async () => {
    const { tier } = await load();
    expect(tier([...baseline, 0.1]).tier).toBe("none");
  });

  it.each([
    [0.25, "1sigma", "reading above 1 sigma"],
    [0.35, "2sigma", "reading above 2 sigma"],
    [0.5, "3sigma", "reading above 3 sigma"],
  ])("classifies %s as %s", async (reading, expected, rule) => {
    const { tier } = await load();
    expect(tier([...baseline, reading])).toMatchObject({ tier: expected, rule });
  });

  it("flags slow drift that never crosses 2 sigma", async () => {
    const { tier } = await load();
    const drift = [...baseline, 0.26, 0.27, 0.26, 0.05, 0.27];
    expect(tier(drift)).toMatchObject({
      tier: "2sigma",
      rule: "drift: 4 of 5 readings above 1 sigma",
    });
  });

  it("uses MIN_SIGMA so a flat baseline does not turn a blip into a breach", async () => {
    const { tier, MIN_BASELINE } = await load();
    const flat = Array(MIN_BASELINE).fill(0);
    expect(tier([...flat, 0.04]).tier).toBe("none");
    expect(tier([...flat, 0.2]).tier).toBe("3sigma");
  });

  it("rejects too short a baseline and non-numeric readings", async () => {
    const { tier, MIN_BASELINE } = await load();
    expect(() => tier(Array(MIN_BASELINE).fill(0))).toThrow(/need at least/);
    expect(() => tier([...baseline, Number.NaN])).toThrow(/finite numbers/);
  });
});

describe("daily CI failure rates", () => {
  it("groups by UTC day, oldest first, ignoring cancelled, skipped and running runs", async () => {
    const { dailyFailureRates } = await load();
    const rates = dailyFailureRates(
      [
        { created_at: "2026-10-02T10:00:00Z", conclusion: "failure" },
        { created_at: "2026-10-01T23:59:00Z", conclusion: "success" },
        { created_at: "2026-10-02T11:00:00Z", conclusion: "success" },
        { created_at: "2026-10-02T12:00:00Z", conclusion: "cancelled" },
        { created_at: "2026-10-02T13:00:00Z", conclusion: "skipped" },
        { created_at: "2026-10-02T14:00:00Z", conclusion: null },
        { created_at: "2026-10-03T09:00:00Z", conclusion: "timed_out" },
      ],
      new Date("2026-10-04T06:41:00Z"),
    );
    expect(rates).toEqual([0, 0.5, 1]);
  });

  it("drops the unfinished current UTC day", async () => {
    const { dailyFailureRates } = await load();
    const runs = [
      { created_at: "2026-10-03T12:00:00Z", conclusion: "success" },
      { created_at: "2026-10-04T00:30:00Z", conclusion: "failure" },
    ];
    expect(dailyFailureRates(runs, new Date("2026-10-04T06:41:00Z"))).toEqual([0]);
    expect(dailyFailureRates(runs, new Date("2026-10-05T00:00:00Z"))).toEqual([0, 1]);
  });
});
