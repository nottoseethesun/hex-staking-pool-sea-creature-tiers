"use strict";

const { describe, it } = require("node:test");
const { RuleTester } = require("eslint");
const rule = require("../../eslint-rules/no-interpolated-innerhtml");

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

describe("no-interpolated-innerhtml", () => {
  it("passes RuleTester valid/invalid cases", () => {
    ruleTester.run("no-interpolated-innerhtml", rule, {
      valid: [
        'el.innerHTML = "";',
        'el.innerHTML = "<b>static</b>";',
        "el.textContent = `${x}`;",
        "el.innerHTML = trusted;",
      ],
      invalid: [
        {
          code: "el.innerHTML = `<b>${x}</b>`;",
          errors: [{ messageId: "interpolated" }],
        },
        {
          code: 'el.innerHTML = "<b>" + x;',
          errors: [{ messageId: "interpolated" }],
        },
        {
          code: 'el.insertAdjacentHTML("beforeend", `<li>${x}</li>`);',
          errors: [{ messageId: "interpolated" }],
        },
      ],
    });
  });
});
