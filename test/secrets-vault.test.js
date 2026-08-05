"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { encrypt, decrypt } = require("../src/secrets/vault");
const {
  setSecret,
  getSecret,
  decryptAll,
  hasVault,
  listSecrets,
} = require("../src/secrets/store");
const holder = require("../src/secrets/holder");

const ITER = 1000; // low work factor keeps the tests fast

function tmpVault() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vault-")), "v.json");
}

test("encrypt/decrypt round-trips a secret", () => {
  const env = encrypt("https://moralis/eth/KEY123", "hunter2", ITER);
  assert.equal(env.kdf, "pbkdf2-sha512");
  assert.equal(decrypt(env, "hunter2"), "https://moralis/eth/KEY123");
});

test("decrypt throws on the wrong passphrase", () => {
  const env = encrypt("secret", "right", ITER);
  assert.throws(() => decrypt(env, "wrong"));
});

test("decrypt throws when the ciphertext is tampered (GCM auth)", () => {
  const env = encrypt("secret", "pw", ITER);
  const bad = { ...env, ct: Buffer.from("deadbeef", "hex").toString("base64") };
  assert.throws(() => decrypt(bad, "pw"));
});

test("store setSecret/getSecret round-trips and never writes plaintext", () => {
  const file = tmpVault();
  try {
    setSecret("moralisEthUrl", "https://x/eth/SECRETKEY", "pw", {
      file,
      iterations: ITER,
    });
    assert.equal(hasVault(file), true);
    assert.deepEqual(listSecrets(file), ["moralisEthUrl"]);
    assert.equal(
      getSecret("moralisEthUrl", "pw", { file }),
      "https://x/eth/SECRETKEY",
    );
    assert.throws(() => getSecret("moralisEthUrl", "bad", { file }));
    assert.throws(() => getSecret("missing", "pw", { file }));
    // The on-disk file holds only the envelope — never the plaintext URL/key.
    const raw = fs.readFileSync(file, "utf8");
    assert.equal(raw.includes("https://x/eth"), false);
    assert.equal(raw.includes("SECRETKEY"), false);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("decryptAll decrypts every vault entry under one passphrase", () => {
  const file = tmpVault();
  try {
    setSecret("a", "AAA", "pw", { file, iterations: ITER });
    setSecret("b", "BBB", "pw", { file, iterations: ITER });
    assert.deepEqual(decryptAll("pw", { file }), { a: "AAA", b: "BBB" });
    assert.throws(() => decryptAll("wrong", { file }));
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("holder unlocks, reads, and clears in-memory secrets", () => {
  holder.lock();
  assert.equal(holder.has("k"), false);
  holder.unlock("k", "v");
  assert.equal(holder.get("k"), "v");
  assert.equal(holder.has("k"), true);
  holder.unlockAll({ a: "1", b: "2" });
  assert.deepEqual(holder.names().sort(), ["a", "b", "k"]);
  holder.lock();
  assert.equal(holder.get("k"), null);
  assert.deepEqual(holder.names(), []);
});

test("effectiveRpcUrls prepends unlocked Moralis then generic URLs per chain (deduped)", () => {
  const { effectiveRpcUrls } = require("../src/config");
  const cfg = { ethRpcUrls: ["https://a"], plsRpcUrls: ["https://p"] };
  holder.lock();
  assert.deepEqual(effectiveRpcUrls(cfg, "eth"), ["https://a"]);
  holder.unlock("ethRpc1", "https://m1");
  holder.unlock("ethRpc2", "https://m2");
  holder.unlock("ethGeneric1", "https://g1"); // generic slots also feed the pool
  holder.unlock("plsRpc1", "https://pm1");
  assert.deepEqual(effectiveRpcUrls(cfg, "eth"), [
    "https://m1", // Moralis (trace-capable) first, in slot order
    "https://m2",
    "https://g1", // then the generic, key-free node
    "https://a", // then the configured list
  ]);
  assert.deepEqual(effectiveRpcUrls(cfg, "pls"), ["https://pm1", "https://p"]);
  holder.lock();
});

test("unlockVault loads sealed secrets into the holder", () => {
  const { storeSecret, unlockVault } = require("../src/secrets/service");
  const file = tmpVault();
  try {
    holder.lock();
    storeSecret("moralisEthUrl", "https://m/eth/K", "pw", {
      file,
      iterations: ITER,
    });
    assert.equal(holder.has("moralisEthUrl"), false); // sealed, not yet unlocked
    assert.deepEqual(unlockVault("pw", { file }), ["moralisEthUrl"]);
    assert.equal(holder.get("moralisEthUrl"), "https://m/eth/K");
    assert.throws(() => unlockVault("wrong", { file }));
    holder.lock();
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("storeSecrets seals many entries under one passphrase", () => {
  const { storeSecrets } = require("../src/secrets/service");
  const file = tmpVault();
  try {
    const names = storeSecrets(
      { ethRpc1: "https://m1", ethRpc2: "https://m2" },
      "pw",
      { file, iterations: ITER },
    );
    assert.deepEqual(names.sort(), ["ethRpc1", "ethRpc2"]);
    assert.equal(getSecret("ethRpc1", "pw", { file }), "https://m1");
    assert.equal(getSecret("ethRpc2", "pw", { file }), "https://m2");
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("clearVault removes the vault and reports whether one existed", () => {
  const { clearVault } = require("../src/secrets/store");
  const file = tmpVault();
  try {
    assert.equal(clearVault({ file }), false); // nothing to clear yet
    setSecret("ethRpc1", "https://a", "pw", { file, iterations: ITER });
    assert.equal(hasVault(file), true);
    assert.equal(clearVault({ file }), true); // existed -> removed
    assert.equal(hasVault(file), false);
    assert.equal(clearVault({ file }), false); // idempotent — already gone
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("assertPassphrase guards a store against a wrong passphrase (no half-write)", () => {
  const { assertPassphrase } = require("../src/secrets/store");
  const { storeSecrets } = require("../src/secrets/service");
  const file = tmpVault();
  try {
    // An empty/absent vault has nothing to protect — any passphrase passes.
    assert.doesNotThrow(() => assertPassphrase("anything", { file }));
    storeSecrets({ ethRpc1: "https://a" }, "right", { file, iterations: ITER });
    // A wrong passphrase is rejected outright...
    assert.throws(
      () => assertPassphrase("wrong", { file }),
      /does not match the existing vault/,
    );
    // ...so adding under a wrong passphrase writes nothing (vault untouched).
    assert.throws(() =>
      storeSecrets({ ethRpc2: "https://b" }, "wrong", {
        file,
        iterations: ITER,
      }),
    );
    assert.deepEqual(listSecrets(file), ["ethRpc1"]); // ethRpc2 never landed
    // The right passphrase adds without disturbing the existing entry.
    storeSecrets({ ethRpc2: "https://b" }, "right", { file, iterations: ITER });
    assert.deepEqual(listSecrets(file).sort(), ["ethRpc1", "ethRpc2"]);
    assert.equal(getSecret("ethRpc1", "right", { file }), "https://a");
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
