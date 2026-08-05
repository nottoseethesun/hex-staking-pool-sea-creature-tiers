"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");
const holder = require("../src/secrets/holder");
const {
  handleCommand,
  startUnlockSocket,
  sendCommand,
  socketPath,
} = require("../src/secrets/unlock-socket");

const ITER = 1000;
function tmpVault() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "usock-")), "v.json");
}

test("handleCommand stores, unlocks, reports status, and rejects bad input", () => {
  const file = tmpVault();
  try {
    holder.lock();
    let r = handleCommand(
      {
        action: "store",
        name: "moralisEthUrl",
        value: "https://m/eth/K",
        passphrase: "pw",
      },
      { file, iterations: ITER },
    );
    assert.equal(r.ok, true);
    assert.equal(r.stored, "moralisEthUrl");
    const st = handleCommand({ action: "status" }, { file });
    assert.equal(st.hasVault, true); // the temp vault now exists
    assert.deepEqual(st.unlocked, []); // sealed but not yet unlocked
    r = handleCommand({ action: "unlock", passphrase: "pw" }, { file });
    assert.equal(r.ok, true);
    assert.deepEqual(r.unlocked, ["moralisEthUrl"]);
    assert.deepEqual(handleCommand({ action: "status" }).unlocked, [
      "moralisEthUrl",
    ]);
    assert.equal(
      handleCommand({ action: "unlock", passphrase: "bad" }, { file }).ok,
      false,
    );
    const batch = handleCommand(
      {
        action: "store",
        secrets: { ethRpc1: "https://x1", plsRpc1: "https://x2" },
        passphrase: "pw",
      },
      { file, iterations: ITER },
    );
    assert.deepEqual(batch.stored.sort(), ["ethRpc1", "plsRpc1"]);
    assert.equal(handleCommand({ action: "bogus" }).ok, false);
  } finally {
    holder.lock();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("startUnlockSocket + sendCommand round-trip a command over the local socket", async () => {
  const port = 65123;
  const server = startUnlockSocket(
    port,
    { info() {}, warn() {} },
    { handle: (cmd) => ({ ok: true, echo: cmd.action }) },
  );
  await new Promise((r) => server.once("listening", r));
  try {
    const reply = await sendCommand(port, { action: "status" });
    assert.equal(reply.ok, true);
    assert.equal(reply.echo, "status");
  } finally {
    server.close();
    fs.rmSync(socketPath(port), { force: true });
  }
});
