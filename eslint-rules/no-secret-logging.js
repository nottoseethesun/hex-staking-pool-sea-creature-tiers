/**
 * @file eslint-rules/no-secret-logging.js
 * @description ESLint rule that flags console.log/warn/error/info calls that
 * reference variables or properties with sensitive names (privateKey,
 * mnemonic, seedPhrase, password, secret, signingKey).
 *
 * This tool is read-only and holds no keys, so this rule is defence-in-depth:
 * it guarantees a future change can never start logging a secret. String
 * literals are allowed (e.g. console.log('Loading key...')) because they
 * cannot leak an actual secret value.
 */

"use strict";

const SENSITIVE =
  /private.?key|mnemonic|seed.?phrase|password|secret|signing.?key/i;

/** Check if a node references a sensitive name. */
function isSensitive(node) {
  if (node.type === "Identifier") return SENSITIVE.test(node.name);
  if (node.type === "MemberExpression") return isSensitive(node.property);
  if (node.type === "TemplateLiteral")
    return node.expressions.some(isSensitive);
  if (node.type === "BinaryExpression")
    return isSensitive(node.left) || isSensitive(node.right);
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow logging variables that may contain secrets",
    },
    schema: [],
    messages: {
      secret:
        'Do not log "{{name}}" — it may contain a private key, password, or mnemonic.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const c = node.callee;
        if (
          c.type !== "MemberExpression" ||
          c.object.type !== "Identifier" ||
          c.object.name !== "console"
        )
          return;
        for (const arg of node.arguments) {
          if (arg.type === "Literal") continue;
          if (isSensitive(arg)) {
            const name =
              arg.type === "Identifier"
                ? arg.name
                : context.sourceCode.getText(arg);
            context.report({
              node: arg,
              messageId: "secret",
              data: { name },
            });
          }
        }
      },
    };
  },
};
