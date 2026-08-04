const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");

class JestLayerSummaryReporter {
  onRunComplete(_contexts, results) {
    const outputPath = process.env.JEST_LAYER_SUMMARY_PATH;
    if (!outputPath) return;

    const summary = {
      success: results.success,
      startTime: results.startTime,
      numTotalTestSuites: results.numTotalTestSuites,
      numPassedTestSuites: results.numPassedTestSuites,
      numFailedTestSuites: results.numFailedTestSuites,
      numPendingTestSuites: results.numPendingTestSuites,
      numRuntimeErrorTestSuites: results.numRuntimeErrorTestSuites,
      numTotalTests: results.numTotalTests,
      numPassedTests: results.numPassedTests,
      numFailedTests: results.numFailedTests,
      numPendingTests: results.numPendingTests,
      numTodoTests: results.numTodoTests,
      testResults: results.testResults.map((suite) => ({
        testFilePath: suite.testFilePath,
        status: suite.numFailingTests > 0 ? "failed" : "passed",
        numFailingTests: suite.numFailingTests,
        numPassingTests: suite.numPassingTests,
        numPendingTests: suite.numPendingTests,
        // Intentionally omit failureMessages so credential-bearing failures
        // cannot be serialized into machine-readable layer summaries.
        assertionResults: suite.testResults.map((test) => ({
          ancestorTitles: test.ancestorTitles,
          duration: test.duration,
          fullName: test.fullName,
          status: test.status,
          title: test.title,
        })),
      })),
    };

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  }
}

module.exports = JestLayerSummaryReporter;
