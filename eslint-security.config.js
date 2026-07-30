/**
 * @file eslint-security.config.js
 * @description Security-only ESLint flat config, run via
 *   `npm run audit:security` (and inside `npm run check`). Layers
 *   eslint-plugin-security + eslint-plugin-no-secrets + the custom
 *   `hexleague` security rules over the Node source. Warnings are treated as
 *   errors (`--max-warnings 0`), so each finding must be fixed or suppressed
 *   with a documented per-line `-- Safe: <reason>` directive.
 *
 * Two eslint-plugin-security rules are disabled with rationale:
 *   - detect-non-literal-fs-filename: every fs path is a __dirname-relative
 *     constant (data/<chain>/…, out/…), never user input.
 *   - detect-object-injection: bracket access uses program-owned keys
 *     (chain names, league ids), never untrusted input.
 */

"use strict";

const security = require("eslint-plugin-security");
const noSecrets = require("eslint-plugin-no-secrets");
const noSecretLogging = require("./eslint-rules/no-secret-logging");
const noNumberFromBigint = require("./eslint-rules/no-number-from-bigint");

module.exports = [
  {
    files: ["bin/**/*.js", "src/**/*.js", "scripts/**/*.js", "server.js"],
    plugins: {
      security,
      "no-secrets": noSecrets,
      hexleague: {
        rules: {
          "no-secret-logging": noSecretLogging,
          "no-number-from-bigint": noNumberFromBigint,
        },
      },
    },
    languageOptions: { ecmaVersion: 2022, sourceType: "commonjs" },
    rules: {
      "security/detect-unsafe-regex": "warn",
      "security/detect-non-literal-regexp": "warn",
      "security/detect-non-literal-fs-filename": "off",
      "security/detect-eval-with-expression": "warn",
      "security/detect-no-csrf-before-method-override": "warn",
      "security/detect-possible-timing-attacks": "warn",
      "security/detect-pseudoRandomBytes": "warn",
      "security/detect-child-process": "warn",
      "security/detect-new-buffer": "warn",
      "security/detect-disable-mustache-escape": "warn",
      "security/detect-non-literal-require": "warn",
      "security/detect-object-injection": "off",
      "no-secrets/no-secrets": [
        "warn",
        { tolerance: 4.5, additionalDelimiters: ["0x"] },
      ],
      "hexleague/no-secret-logging": "warn",
      "hexleague/no-number-from-bigint": "warn",
    },
  },
];
