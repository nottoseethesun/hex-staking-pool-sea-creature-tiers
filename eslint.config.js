/**
 * @file eslint.config.js
 * @description ESLint v10 flat configuration for
 *   hex-staking-pool-sea-creature-tiers.
 *
 * Quality rules beyond ESLint's "recommended" preset:
 *   - complexity <= 17   (cyclomatic complexity per function)
 *   - max-lines <= 500   (non-comment, non-blank lines per file)
 *   - max-len <= 80
 *   - eqeqeq / no-var / prefer-const / strict global
 *   - no window.* property assignments; no Math.random() (use crypto)
 *
 * Custom project rules (under the "hexleague" plugin namespace):
 *   - no-interpolated-innerhtml  (dashboard XSS hardening)
 *   - no-secret-logging          (enforced by the security lint only)
 *   - no-number-from-bigint      (enforced by the security lint only)
 *
 * Node source is CommonJS; the browser dashboard modules
 * (public/dashboard-*.js) are ES modules.
 *
 * @see {@link https://eslint.org/docs/latest/use/configure/configuration-files}
 */

"use strict";

const js = require("@eslint/js");
const globals = require("globals");
const prettierConfig = require("eslint-config-prettier");
const securityPlugin = require("eslint-plugin-security");
const nPlugin = require("eslint-plugin-n");

const noInterpolatedInnerhtml = require("./eslint-rules/no-interpolated-innerhtml");
const noSecretLogging = require("./eslint-rules/no-secret-logging");
const noNumberFromBigint = require("./eslint-rules/no-number-from-bigint");

/** Shared quality rules applied to all linted files. */
const SHARED_RULES = {
  ...js.configs.recommended.rules,

  complexity: ["error", { max: 17 }],
  "max-len": [
    "error",
    {
      code: 80,
      ignoreUrls: true,
      ignoreStrings: true,
      ignoreTemplateLiterals: true,
      ignoreRegExpLiterals: true,
      ignoreComments: true,
    },
  ],
  "max-lines": [
    "error",
    { max: 500, skipBlankLines: true, skipComments: true },
  ],
  "no-var": "error",
  "prefer-const": ["error", { destructuring: "all" }],
  eqeqeq: ["error", "always"],
  strict: ["error", "global"],
  "no-extend-native": "error",

  "no-unused-vars": [
    "error",
    {
      vars: "all",
      args: "after-used",
      argsIgnorePattern: "^_",
      caughtErrors: "all",
      caughtErrorsIgnorePattern: "^_",
    },
  ],

  "no-warning-comments": [
    "error",
    { terms: ["prettier-ignore"], location: "anywhere" },
  ],

  "no-restricted-syntax": [
    "error",
    {
      selector:
        'AssignmentExpression > MemberExpression.left[object.name="window"]',
      message:
        "Do not assign to window — use module.exports or top-level declarations.",
    },
    {
      selector:
        'CallExpression[callee.object.name="Math"][callee.property.name="random"]',
      message:
        "Use crypto.randomInt()/crypto.randomBytes() instead of Math.random() — not cryptographically secure.",
    },
  ],
};

module.exports = [
  // ── 1. Files to lint ──────────────────────────────────────────────────────
  {
    files: [
      "bin/**/*.js",
      "src/**/*.js",
      "test/**/*.js",
      "scripts/**/*.js",
      "server.js",
      "public/dashboard-*.js",
      "eslint-rules/**/*.js",
    ],
  },

  // ── 2. Files to ignore entirely ───────────────────────────────────────────
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "data/**",
      "out/**",
      "tmp/**",
      "public/build-info.js",
      "test/report-artifacts/**",
    ],
  },

  // ── 3. Node.js source files — CommonJS ────────────────────────────────────
  {
    files: [
      "bin/**/*.js",
      "src/**/*.js",
      "scripts/**/*.js",
      "server.js",
      "eslint-rules/**/*.js",
    ],
    plugins: {
      hexleague: {
        rules: {
          "no-interpolated-innerhtml": noInterpolatedInnerhtml,
          "no-secret-logging": noSecretLogging,
          "no-number-from-bigint": noNumberFromBigint,
        },
      },
      security: securityPlugin,
      n: nPlugin,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        module: "writable",
        require: "readonly",
        process: "readonly",
      },
    },
    linterOptions: {
      // Security rules are enforced by eslint-security.config.js. They are
      // registered "off" here so per-line `-- Safe:` disable directives in
      // source are recognized (not flagged as unused) by the main lint.
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      ...SHARED_RULES,
      "no-console": ["warn", { allow: ["log", "warn", "error", "info"] }],
      "hexleague/no-interpolated-innerhtml": "error",
      // Forbid lazy require() inside functions/blocks — top-of-file only.
      "n/global-require": "error",
      // Catch typos / stale paths in require() calls at lint time.
      "n/no-missing-require": "error",
      // Registered off — enforced by the security lint only. Present here so
      // per-line disable directives for them are recognized.
      "hexleague/no-secret-logging": "off",
      "hexleague/no-number-from-bigint": "off",
      "security/detect-unsafe-regex": "off",
      "security/detect-possible-timing-attacks": "off",
    },
  },

  // ── 4. Dashboard files — browser ES modules ───────────────────────────────
  {
    files: ["public/dashboard-*.js"],
    plugins: {
      hexleague: {
        rules: { "no-interpolated-innerhtml": noInterpolatedInnerhtml },
      },
      n: nPlugin,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: {
      ...SHARED_RULES,
      strict: "off",
      "no-console": [
        "warn",
        { allow: ["log", "warn", "error", "info", "debug"] },
      ],
      "hexleague/no-interpolated-innerhtml": "error",
      // Catch typos / stale paths in dashboard import statements.
      "n/no-missing-import": "error",
    },
  },

  // ── 5. Test files — relax a few rules that do not apply in tests ──────────
  {
    files: ["test/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.browser,
        module: "writable",
        require: "readonly",
        process: "readonly",
      },
    },
    rules: {
      ...SHARED_RULES,
      "no-unused-vars": [
        "error",
        {
          vars: "all",
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      "no-console": "off",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            'AssignmentExpression > MemberExpression.left[object.name="window"]',
          message:
            "Do not assign to window — use module.exports or top-level declarations.",
        },
      ],
    },
  },

  // ── 6. Prettier — disable conflicting formatting rules ────────────────────
  prettierConfig,
];
