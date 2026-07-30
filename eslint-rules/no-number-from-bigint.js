/**
 * @file eslint-rules/no-number-from-bigint.js
 * @description ESLint rule that flags Number(), parseFloat(), parseInt(), or
 * unary `+` applied to variables whose names indicate raw on-chain BigInt
 * quantities: names ending in "Shares" or "Hearts" (optionally "…Total").
 *
 * HEX stake shares and Hearts are held and compared as BigInt — a T-Share is
 * 10^12 raw contract "shares" and a Heart is 10^-8 HEX, so real values dwarf
 * JavaScript Number's 53-bit integer precision and coercion silently
 * truncates. Format for display with the BigInt->string helpers in
 * src/report/format.js instead of converting to Number.
 */

"use strict";

// Names ending in shares/hearts (optionally followed by "total") are raw
// BigInt contract quantities. Matches e.g. shares, stakeShares,
// totalActiveShares, stakeSharesTotal, hearts, stakedHearts.
const AMOUNT_NAMES = /(shares|hearts)(total)?$/i;
const CONVERT_FNS = new Set(["Number", "parseFloat", "parseInt"]);

/** Check if a node looks like a raw BigInt share/heart quantity. */
function isAmountName(node) {
  if (node.type === "Identifier") return AMOUNT_NAMES.test(node.name);
  if (node.type === "MemberExpression") return isAmountName(node.property);
  return false;
}

/** Resolve a readable name for the reported node. */
function nameOf(context, node) {
  return node.type === "Identifier"
    ? node.name
    : context.sourceCode.getText(node);
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Number/parseFloat/parseInt on raw BigInt share/heart quantities (precision loss)",
    },
    schema: [],
    messages: {
      precision:
        'Do not convert "{{name}}" to Number — shares/hearts exceed 53-bit precision. Use BigInt.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const c = node.callee;
        if (c.type !== "Identifier" || !CONVERT_FNS.has(c.name)) return;
        const arg = node.arguments[0];
        if (arg && isAmountName(arg)) {
          context.report({
            node,
            messageId: "precision",
            data: { name: nameOf(context, arg) },
          });
        }
      },
      UnaryExpression(node) {
        if (node.operator !== "+") return;
        if (isAmountName(node.argument)) {
          context.report({
            node,
            messageId: "precision",
            data: { name: nameOf(context, node.argument) },
          });
        }
      },
    };
  },
};
