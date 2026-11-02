import { join } from "path";
import { pathToFileURL } from "url";

type Author = { login: string; __typename: string };
type Review = { author: Author | null; state: string; submittedAt: string; comments: number };

async function load() {
  return (await import(
    pathToFileURL(join(__dirname, "../../ops/review-metrics/metrics.mjs")).href
  )) as {
    summarize: (
      prs: Array<{ title: string; author: Author | null; createdAt: string; reviews: Review[] }>,
    ) => Record<string, any>;
  };
}

const human = (login: string): Author => ({ login, __typename: "User" });
const copilot: Author = { login: "copilot-pull-request-reviewer", __typename: "Bot" };
const review = (author: Author, state: string, hour: number, comments = 0): Review => ({
  author,
  state,
  submittedAt: new Date(Date.UTC(2026, 9, 1, hour)).toISOString(),
  comments,
});
const created = new Date(Date.UTC(2026, 9, 1, 0)).toISOString();

describe("review metrics", () => {
  it("counts distinct human approvals, excluding the author and bots", async () => {
    const { summarize } = await load();
    const m = summarize([
      {
        title: "feat: one",
        author: human("alice"),
        createdAt: created,
        reviews: [
          review(human("alice"), "APPROVED", 1),
          review(copilot, "COMMENTED", 1, 3),
          review(human("bob"), "APPROVED", 2, 2),
          review(human("bob"), "APPROVED", 3),
        ],
      },
    ]);
    expect(m.humanApprovals).toEqual({ median: 1, p95: 1 });
    expect(m.humanComments).toEqual({ median: 2, p95: 2 });
    expect(m.hoursToFirstHumanReview.median).toBe(2);
    expect(m.automatedRounds.median).toBe(1);
  });

  it("reports rounds to pass and reverts, and skips bot-authored PRs", async () => {
    const { summarize } = await load();
    const rounds = (n: number) =>
      Array.from({ length: n }, (_, i) => review(copilot, "COMMENTED", i));
    const m = summarize([
      { title: "fix: a", author: human("alice"), createdAt: created, reviews: rounds(1) },
      { title: "fix: b", author: human("alice"), createdAt: created, reviews: rounds(6) },
      { title: 'Revert "fix: b"', author: human("alice"), createdAt: created, reviews: [] },
      {
        title: "build(deps): x",
        author: { login: "dependabot", __typename: "Bot" },
        createdAt: created,
        reviews: rounds(9),
      },
    ]);
    expect(m.mergedPrs).toBe(3);
    expect(m.automatedRounds).toMatchObject({ passAfterOneRound: 50, fiveOrMoreRounds: 50 });
    expect(m.reverts).toBe(1);
    expect(m.hoursToFirstHumanReview).toEqual({ median: "n/a", p95: "n/a" });
  });
});
