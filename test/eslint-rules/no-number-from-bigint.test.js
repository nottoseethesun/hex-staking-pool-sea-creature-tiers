"use strict";

const { describe, it } = require("node:test");
const { RuleTester } = require("eslint");
const rule = require("../../eslint-rules/no-number-from-bigint");

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "commonjs" },
});

describe("no-number-from-bigint", () => {
  it("passes RuleTester valid/invalid cases", () => {
    ruleTester.run("no-number-from-bigint", rule, {
      valid: ["Number(count);", "parseInt(index, 10);", "Number(x);", "+day;"],
      invalid: [
        {
          code: "Number(shares);",
          errors: [{ messageId: "precision" }],
        },
        {
          code: "parseFloat(stakedHearts);",
          errors: [{ messageId: "precision" }],
        },
        {
          code: "const n = +totalShares;",
          errors: [{ messageId: "precision" }],
        },
      ],
    });
  });
});
