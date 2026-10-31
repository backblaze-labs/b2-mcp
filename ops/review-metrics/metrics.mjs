#!/usr/bin/env node

/* global console, fetch, process */

// Review metrics from "How the Claude Code team does code review": human time
// per change (approvals, comments, wait for the first human review), automated
// review rounds to pass, and reverts as the guardrail. Prints Markdown.
// Needs GITHUB_TOKEN and GITHUB_REPOSITORY; DAYS defaults to 30.

import { pathToFileURL } from "node:url";

function isBot(author) {
  return !author || author.__typename === "Bot" || /\[bot\]$|^copilot/i.test(author.login);
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/**
 * Summarizes merged PRs into review metrics.
 * @param {Array<{title: string, author: {login: string, __typename: string} | null, createdAt: string,
 *   reviews: Array<{author: {login: string, __typename: string} | null, state: string, submittedAt: string, comments: number}>}>} prs
 */
export function summarize(prs) {
  const humanPrs = prs.filter((pr) => !isBot(pr.author));
  const approvals = [];
  const comments = [];
  const waits = [];
  const rounds = [];
  for (const pr of humanPrs) {
    const others = pr.reviews.filter((r) => !isBot(r.author) && r.author.login !== pr.author.login);
    approvals.push(
      new Set(others.filter((r) => r.state === "APPROVED").map((r) => r.author.login)).size,
    );
    comments.push(others.reduce((sum, r) => sum + r.comments, 0));
    const first = others.map((r) => Date.parse(r.submittedAt)).sort((a, b) => a - b)[0];
    if (first !== undefined) waits.push((first - Date.parse(pr.createdAt)) / 3_600_000);
    rounds.push(
      pr.reviews.filter((r) => isBot(r.author) && r.author?.login.toLowerCase().includes("copilot"))
        .length,
    );
  }
  const reviewed = rounds.filter((n) => n > 0);
  const round = (n) => (n === null ? "n/a" : Math.round(n * 10) / 10);
  return {
    mergedPrs: humanPrs.length,
    humanApprovals: { median: percentile(approvals, 50), p95: percentile(approvals, 95) },
    humanComments: { median: percentile(comments, 50), p95: percentile(comments, 95) },
    hoursToFirstHumanReview: {
      median: round(percentile(waits, 50)),
      p95: round(percentile(waits, 95)),
    },
    automatedRounds: {
      median: percentile(reviewed, 50),
      passAfterOneRound: reviewed.length
        ? round((100 * reviewed.filter((n) => n <= 1).length) / reviewed.length)
        : "n/a",
      fiveOrMoreRounds: reviewed.length
        ? round((100 * reviewed.filter((n) => n >= 5).length) / reviewed.length)
        : "n/a",
    },
    reverts: humanPrs.filter((pr) => /^revert\b/i.test(pr.title)).length,
  };
}

const query = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title createdAt author { login __typename }
      reviews(first: 100) { pageInfo { hasNextPage }
        nodes { author { login __typename } state submittedAt comments { totalCount } } }
    } }
  }
}`;

async function fetchPrs({ repository, token, days }) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const prs = [];
  let after = null;
  do {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { q: `repo:${repository} is:pr is:merged merged:>=${since}`, after },
      }),
    });
    const body = await response.json();
    if (!response.ok || body.errors)
      throw new Error(`GitHub GraphQL: ${JSON.stringify(body.errors ?? response.status)}`);
    for (const pr of body.data.search.nodes) {
      if (pr.reviews.pageInfo.hasNextPage)
        throw new Error(`PR #${pr.number} has more than 100 reviews`);
      prs.push({
        ...pr,
        reviews: pr.reviews.nodes.map((r) => ({ ...r, comments: r.comments.totalCount })),
      });
    }
    after = body.data.search.pageInfo.hasNextPage ? body.data.search.pageInfo.endCursor : null;
  } while (after);
  return prs;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository } = process.env;
  const days = Number.parseInt(process.env.DAYS ?? "30", 10);
  if (!token || !repository || !Number.isSafeInteger(days) || days <= 0) {
    console.error("GITHUB_TOKEN, GITHUB_REPOSITORY and a positive integer DAYS are required");
    process.exit(1);
  }
  fetchPrs({ repository, token, days })
    .then((prs) => {
      const m = summarize(prs);
      console.log(`### Review metrics, last ${days} days (${m.mergedPrs} merged PRs)\n`);
      console.log("| Metric | Median | p95 / share |\n| --- | --- | --- |");
      console.log(
        `| Human approvals per PR | ${m.humanApprovals.median} | ${m.humanApprovals.p95} |`,
      );
      console.log(
        `| Human review comments per PR | ${m.humanComments.median} | ${m.humanComments.p95} |`,
      );
      console.log(
        `| Hours to first human review | ${m.hoursToFirstHumanReview.median} | ${m.hoursToFirstHumanReview.p95} |`,
      );
      console.log(
        `| Automated review rounds | ${m.automatedRounds.median} | ${m.automatedRounds.passAfterOneRound}% pass after 1, ${m.automatedRounds.fiveOrMoreRounds}% need 5+ |`,
      );
      console.log(`| Reverts (guardrail) | ${m.reverts} | |`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
