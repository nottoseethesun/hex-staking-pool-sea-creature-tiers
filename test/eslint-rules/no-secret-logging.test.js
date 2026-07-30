"use strict";

const { describe, it } = require("node:test");
const { RuleTester } = require("eslint");
const rule = require("../../eslint-rules/no-secret-logging");

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "commonjs" },
});

describe("no-secret-logging", () => {
  it("passes RuleTester valid/invalid cases", () => {
    ruleTester.run("no-secret-logging", rule, {
      valid: [
        'console.log("loading private key...");',
        "console.log(publicData);",
        "console.info(count);",
      ],
      invalid: [
        {
          code: "console.log(privateKey);",
          errors: [{ messageId: "secret" }],
        },
        {
          code: "console.error(`${mnemonic}`);",
          errors: [{ messageId: "secret" }],
        },
        {
          code: "console.warn(user.password);",
          errors: [{ messageId: "secret" }],
        },
      ],
    });
  });
});
