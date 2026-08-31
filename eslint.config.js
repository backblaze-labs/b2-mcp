const jsdoc = require("eslint-plugin-jsdoc");
const tsdoc = require("eslint-plugin-tsdoc");
const tseslint = require("typescript-eslint");

const tsdocRules = {
  "tsdoc/syntax": "error",
};
const jsdocRules = {
  "jsdoc/no-bad-blocks": "error",
  "jsdoc/no-blank-blocks": "error",
  "jsdoc/multiline-blocks": "error",
  "jsdoc/empty-tags": "error",
  "jsdoc/check-tag-names": [
    "error",
    {
      definedTags: ["internal", "inheritDoc", "typeParam", "packageDocumentation", "remarks"],
    },
  ],
  "jsdoc/require-param-description": "error",
  "jsdoc/require-hyphen-before-param-description": ["error", "always"],
  // Keep public return docs intentional even when small wrappers need a
  // short @returns line; the docs gate covers exported API surfaces.
  "jsdoc/require-returns": ["error", { publicOnly: true }],
  "jsdoc/require-returns-check": "error",
  "jsdoc/require-throws": "error",
  "jsdoc/no-types": "error",
  "jsdoc/sort-tags": [
    "error",
    {
      tagSequence: [
        { tags: ["module", "packageDocumentation"] },
        { tags: ["remarks"] },
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
};
const docCommentRules =
  process.env.DOC_LINT_TSDOC_ONLY === "1" ? tsdocRules : { ...tsdocRules, ...jsdocRules };

// ESLint is parser-only for TypeScript here; Biome owns code linting.
// Do not register @typescript-eslint as a plugin unless doc lint starts using
// one of its rules explicitly.
module.exports = [
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    plugins: {
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
    rules: docCommentRules,
  },
];
