import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

it("compiles the multipart registration example without undeclared dependencies", () => {
  const root = resolve(__dirname, "../..");
  const source = readFileSync(join(root, "src/s3/multipart.ts"), "utf8");
  const match = source.match(/@example\s*\n \* ```ts\n([\s\S]*?) \* ```/);
  expect(match).not.toBeNull();
  const example = match![1].replace(/^ \* ?/gm, "");
  const virtualPath = join(root, "src/s3/multipart-example.ts");
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  expect(config.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const options = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    resolve(fileName) === virtualPath
      ? ts.createSourceFile(fileName, example, languageVersion, true)
      : originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([virtualPath], options, host);
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  expect(diagnostics).toEqual([]);
  const calls: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) calls.push(node.expression.getText());
    ts.forEachChild(node, visit);
  }
  visit(program.getSourceFile(virtualPath)!);
  expect(calls.some((name) => name === "createServer" || name === "registerS3MultipartTools")).toBe(
    true,
  );
});
