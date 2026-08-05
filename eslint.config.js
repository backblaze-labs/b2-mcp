const jsdoc = require("eslint-plugin-jsdoc");
const tsdoc = require("eslint-plugin-tsdoc");
const tseslint = require("typescript-eslint");

const disabledTypeScriptRules = Object.fromEntries(
  Object.keys(tseslint.plugin.rules).map((ruleName) => [`@typescript-eslint/${ruleName}`, "off"]),
);

module.exports = [
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      jsdoc,
      tsdoc: { rules: tsdoc.rules },
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    settings: {
      jsdoc: {
        mode: "typescript",
        tagNamePreference: {
          template: "typeParam",
        },
      },
    },
    rules: {
      ...disabledTypeScriptRules,
      "tsdoc/syntax": "error",
      "jsdoc/no-bad-blocks": "error",
      "jsdoc/no-blank-blocks": "error",
      "jsdoc/multiline-blocks": "error",
      "jsdoc/empty-tags": "error",
      "jsdoc/check-tag-names": [
        "error",
        {
          definedTags: ["internal", "inheritDoc", "typeParam", "packageDocumentation"],
        },
      ],
      "jsdoc/require-param-description": "error",
      "jsdoc/require-hyphen-before-param-description": ["error", "always"],
      "jsdoc/require-returns": ["error", { publicOnly: true }],
      "jsdoc/require-returns-check": "error",
      "jsdoc/require-throws": "error",
      "jsdoc/no-types": "error",
      "jsdoc/sort-tags": [
        "error",
        {
          tagSequence: [
            { tags: ["module", "packageDocumentation"] },
            { tags: ["typeParam", "template"] },
            { tags: ["param"] },
            { tags: ["returns"] },
            { tags: ["throws"] },
            { tags: ["example"] },
            { tags: ["see"] },
            { tags: ["deprecated"] },
            { tags: ["internal"] },
          ],
        },
      ],
    },
  },
];
