import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const STATUS_MAP = {
  pass: "passed",
  fail: "failed",
  skip: "pending",
  todo: "pending",
  run: "pending",
  queued: "pending",
};

function collectTests(task, ancestorTitles = []) {
  if (task.type === "test") return [{ task, ancestorTitles }];

  const isFile = typeof task.filepath === "string";
  const nextAncestors = isFile ? ancestorTitles : [...ancestorTitles, task.name];
  return (task.tasks ?? []).flatMap((child) => collectTests(child, nextAncestors));
}

function statusFor(test) {
  return STATUS_MAP[test.result?.state ?? test.mode] ?? "pending";
}

function isFailed(test) {
  return test.result?.state === "fail";
}

function isPassed(test) {
  return test.result?.state === "pass";
}

function isPending(test) {
  return (
    test.result?.state === "run" ||
    test.result?.state === "queued" ||
    test.result?.state === "skip" ||
    test.mode === "skip" ||
    test.mode === "todo"
  );
}

export default class VitestLayerSummaryReporter {
  startTime = Date.now();

  onInit() {
    this.startTime = Date.now();
  }

  onTestRunEnd(testModules, errors) {
    const outputPath = process.env.VITEST_LAYER_SUMMARY_PATH;
    if (!outputPath) return;

    const files = testModules.map((testModule) => testModule.task);
    const allTests = files.flatMap((file) => collectTests(file));
    const fileSummaries = files.map((file) => {
      const tests = collectTests(file);
      const failed = file.result?.state === "fail" || tests.some(({ task }) => isFailed(task));

      return {
        testFilePath: file.filepath,
        status: failed ? "failed" : "passed",
        numFailingTests: tests.filter(({ task }) => isFailed(task)).length,
        numPassingTests: tests.filter(({ task }) => isPassed(task)).length,
        numPendingTests: tests.filter(({ task }) => isPending(task)).length,
        assertionResults: tests.map(({ task, ancestorTitles }) => ({
          ancestorTitles,
          duration: task.result?.duration,
          fullName: [...ancestorTitles, task.name].filter(Boolean).join(" "),
          status: statusFor(task),
          title: task.name,
        })),
      };
    });

    const numFailedTestSuites = fileSummaries.filter((suite) => suite.status === "failed").length;
    const numPendingTestSuites = fileSummaries.filter(
      (suite) => suite.numPassingTests === 0 && suite.numFailingTests === 0,
    ).length;
    const numTotalTests = allTests.length;
    const numPassedTests = allTests.filter(({ task }) => isPassed(task)).length;
    const numFailedTests = allTests.filter(({ task }) => isFailed(task)).length;
    const numPendingTests = allTests.filter(({ task }) => isPending(task)).length;

    const summary = {
      runId: process.env.VITEST_LAYER_RUN_ID ?? null,
      success:
        files.length > 0 &&
        errors.length === 0 &&
        numFailedTestSuites === 0 &&
        numFailedTests === 0,
      startTime: this.startTime,
      numTotalTestSuites: fileSummaries.length,
      numPassedTestSuites: fileSummaries.length - numFailedTestSuites - numPendingTestSuites,
      numFailedTestSuites,
      numPendingTestSuites,
      numRuntimeErrorTestSuites: errors.length,
      numTotalTests,
      numPassedTests,
      numFailedTests,
      numPendingTests,
      numTodoTests: allTests.filter(({ task }) => task.mode === "todo").length,
      testResults: fileSummaries,
    };

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  }
}
