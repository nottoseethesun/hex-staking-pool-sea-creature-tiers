/**
 * @file public/dashboard-secrets.js
 * @description The Help -> "Secrets" dialog: a local, same-origin wizard for the
 * encrypted vault.
 *   - No vault yet -> SETUP: step 1 introduces + creates a passphrase (with
 *     confirm); step 2 collects generic, key-free RPC node URLs; step 3 collects
 *     up to 3 Moralis RPC URLs per chain, then seals + unlocks.
 *   - Vault exists -> UNLOCK: passphrase -> unlock (with an "add / replace URLs"
 *     option that reveals both node sections).
 * A successful unlock loads the endpoints into the running server, clears the
 * trace-preflight mask, and closes the dialog. Values are sent only to localhost
 * and never rendered back; DOM text is set with textContent (no interpolated
 * innerHTML) per the dashboard XSS rule.
 */

const GENERIC_FIELDS = [
  "ethGeneric1",
  "ethGeneric2",
  "ethGeneric3",
  "plsGeneric1",
  "plsGeneric2",
  "plsGeneric3",
];
const MORALIS_FIELDS = [
  "ethRpc1",
  "ethRpc2",
  "ethRpc3",
  "plsRpc1",
  "plsRpc2",
  "plsRpc3",
  "moralisGeneralKey",
];
const ALL_FIELDS = [...GENERIC_FIELDS, ...MORALIS_FIELDS];

let mode = "unlock"; // "setup" | "unlock" | "unlocked"
let step = 1; // setup step (1 = passphrase, 2 = generic nodes, 3 = Moralis nodes)
let heldPass = ""; // the new passphrase carried across the setup steps

/**
 * POST a vault command, returning the parsed reply (or an error-shaped object).
 * @param {object} cmd
 * @returns {Promise<object>}
 */
async function vaultPost(cmd) {
  try {
    const res = await fetch("/api/vault", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cmd),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Show or hide the preflight mask from a preflight state object. When the
 * preflight fails, the panel adapts to whether this is a first run: with NO vault
 * yet (`state.hasVault === false`) it's a friendly, azure "set up your RPCs" panel
 * — not an error; once a vault exists it's the red "configuration problem". Both
 * point at the same Secrets wizard, so nothing needs a restart.
 * @param {object} state /api/preflight, or an unlock reply's `preflight`
 */
function applyPreflight(state) {
  const overlay = document.getElementById("preflightOverlay");
  if (!state || state.ok) {
    overlay.hidden = true;
    return;
  }
  const per = state.perChain || {};
  const count = (c) =>
    per[c] ? `${c.toUpperCase()} ${per[c].capableCount}/${per[c].min}` : null;
  // Setup lists BOTH chains (you configure each); the problem mask lists only the
  // chains actually below the minimum.
  const both = ["eth", "pls"].map(count).filter(Boolean).join(", ");
  const short = ["eth", "pls"]
    .filter((c) => per[c] && per[c].capableCount < per[c].min)
    .map((c) => `${c.toUpperCase()} has ${per[c].capableCount}/${per[c].min}`)
    .join("; ");
  const setup = !state.hasVault; // no password yet => first run, not an error
  el("preflightBox").classList.toggle("setup", setup);
  el("preflightTitle").textContent = setup
    ? "Set up your RPC endpoints"
    : "⚠ RPC Configuration Problem";
  el("preflightDetail").textContent = setup
    ? `Add your trace-capable RPC endpoints for each chain to begin scanning (currently ${both}).`
    : `Scanning is disabled — too few trace-capable RPCs (${short}).`;
  el("preflightActionSetup").hidden = !setup;
  el("preflightActionProblem").hidden = setup;
  el("preflightSecretsBtn").textContent = setup
    ? "Set up RPC endpoints →"
    : "Open Secrets →";
  overlay.hidden = false;
}

/** Fetch the current preflight state and apply the mask. */
export async function checkPreflight() {
  try {
    applyPreflight(await (await fetch("/api/preflight")).json());
  } catch {
    // leave the UI usable on a transient error
  }
}

/** Set the modal's status line. @param {string} text @param {boolean} ok */
function setStatus(text, ok) {
  const node = document.getElementById("secretsStatus");
  node.textContent = text;
  node.className = ok ? "secrets-ok" : "secrets-err";
}

/** @param {string} id @returns {HTMLElement} */
function el(id) {
  return document.getElementById(id);
}

/** Collect the non-blank URL/key fields into a { name: value } object. */
function collectFields() {
  const secrets = {};
  for (const f of ALL_FIELDS) {
    const v = el(f).value.trim();
    if (v) secrets[f] = v;
  }
  return secrets;
}

/** True when at least one RPC URL (not just the general key) was provided. */
function hasRpcUrl(secrets) {
  return Object.keys(secrets).some((k) => k !== "moralisGeneralKey");
}

/** Clear the passphrase, confirm, and every URL/key field. */
function clearInputs() {
  el("secretsPass").value = "";
  el("secretsConfirm").value = "";
  for (const f of ALL_FIELDS) el(f).value = "";
}

/** Hide every optional section + control; each render branch shows what it needs. */
function resetSections() {
  el("secretsPassField").hidden = true;
  el("secretsConfirmField").hidden = true;
  el("secretsGenericFields").hidden = true;
  el("secretsFields").hidden = true;
  el("secretsBackBtn").hidden = true;
  el("secretsAddBtn").hidden = true;
  el("secretsPrimaryBtn").hidden = false;
}

/** Render the "already unlocked" state (nothing left to do). */
function renderUnlocked() {
  el("secretsIntro").textContent =
    "Vault unlocked — your RPC endpoints are loaded.";
  el("secretsPrimaryBtn").hidden = true;
}

/** Render the unlock-existing-vault state. */
function renderUnlock() {
  el("secretsIntro").textContent =
    "Unlock your vault to load your RPC endpoints.";
  el("secretsPassLabel").textContent = "Vault passphrase";
  el("secretsPassField").hidden = false;
  el("secretsPrimaryBtn").textContent = "Unlock";
  el("secretsAddBtn").hidden = false;
}

/** Render setup step 1: introduce + create the passphrase. */
function renderPass() {
  el("secretsIntro").textContent =
    "Your private RPC endpoints are stored encrypted on this machine. First, " +
    "create a passphrase to protect them — you'll enter it each session to " +
    "unlock the vault. It can't be recovered, so choose something memorable.";
  el("secretsPassLabel").textContent = "Create a passphrase";
  el("secretsPassField").hidden = false;
  el("secretsConfirmField").hidden = false;
  el("secretsPrimaryBtn").textContent = "Next →";
}

/** Render setup step 2: generic, key-free RPC nodes. */
function renderGeneric() {
  el("secretsIntro").textContent =
    "Add any generic public RPC nodes — plain endpoint URLs that need no API " +
    "key. They help spread the scan load. Up to 3 per chain; leave any blank " +
    "to skip. (Moralis nodes have their own screen next.)";
  el("secretsGenericFields").hidden = false;
  el("secretsPrimaryBtn").textContent = "Next →";
  el("secretsBackBtn").hidden = false;
}

/** Render setup step 3: Moralis (keyed) RPC nodes, then seal + unlock. */
function renderMoralis() {
  el("secretsIntro").textContent =
    "Now add your Moralis RPC nodes — paste the full node URLs (the key is " +
    "embedded). Up to 3 per chain; leave any blank to skip.";
  el("secretsFields").hidden = false;
  el("secretsPrimaryBtn").textContent = "Finish — seal & unlock";
  el("secretsBackBtn").hidden = false;
}

/** Render the dialog for the current mode/step. */
function render() {
  resetSections();
  if (mode === "unlocked") return renderUnlocked();
  if (mode === "unlock") return renderUnlock();
  if (step === 1) return renderPass();
  if (step === 2) return renderGeneric();
  return renderMoralis();
}

/** Fetch vault status and pick the mode. */
async function refreshMode() {
  const s = await vaultPost({ action: "status" });
  const state = s.ok ? s : { hasVault: false, unlocked: [] };
  if (state.unlocked && state.unlocked.length) mode = "unlocked";
  else if (state.hasVault) mode = "unlock";
  else {
    mode = "setup";
    step = 1;
  }
  render();
}

/** Open the Secrets dialog (fresh status + cleared inputs). */
function openSecrets() {
  setStatus("", true);
  clearInputs();
  heldPass = "";
  step = 1;
  void refreshMode();
  el("secretsModal").hidden = false;
}

/** Close the Secrets dialog. */
function closeSecrets() {
  el("secretsModal").hidden = true;
}

/** Unlock with `passphrase`; on success update the mask and close the dialog. */
async function finishUnlock(passphrase) {
  const r = await vaultPost({ action: "unlock", passphrase });
  heldPass = "";
  clearInputs();
  if (!r.ok) {
    setStatus(`Unlock failed: ${r.error}`, false);
    return;
  }
  if (r.preflight) applyPreflight(r.preflight);
  closeSecrets();
}

/** Advance the SETUP wizard: passphrase -> generic -> Moralis -> seal & unlock. */
async function doSetupStep() {
  if (step === 1) {
    const pass = el("secretsPass").value;
    if (!pass) return setStatus("Enter a passphrase.", false);
    if (pass !== el("secretsConfirm").value) {
      return setStatus("The passphrases don't match.", false);
    }
    heldPass = pass;
    step = 2;
    setStatus("", true);
    return render();
  }
  if (step === 2) {
    step = 3;
    setStatus("", true);
    return render();
  }
  const secrets = collectFields();
  if (!hasRpcUrl(secrets)) return setStatus("Add at least one RPC URL.", false);
  const s = await vaultPost({ action: "store", secrets, passphrase: heldPass });
  if (!s.ok) return setStatus(`Store failed: ${s.error}`, false);
  return finishUnlock(heldPass);
}

/**
 * Handle the primary button for an EXISTING vault: optionally seal any newly
 * entered URLs (the server rejects a wrong passphrase before writing anything),
 * then unlock.
 */
async function doUnlockPrimary() {
  const pass = el("secretsPass").value;
  if (!pass) return setStatus("Enter your passphrase.", false);
  const adding =
    !el("secretsGenericFields").hidden || !el("secretsFields").hidden;
  if (adding) {
    const secrets = collectFields();
    if (Object.keys(secrets).length) {
      const s = await vaultPost({ action: "store", secrets, passphrase: pass });
      if (!s.ok) {
        const msg = /does not match/.test(s.error || "")
          ? "That passphrase doesn't match this vault — nothing was changed."
          : `Store failed: ${s.error}`;
        return setStatus(msg, false);
      }
    }
  }
  return finishUnlock(pass);
}

/** The primary button — its meaning depends on the mode/step. */
async function doPrimary() {
  if (mode === "setup") return doSetupStep();
  return doUnlockPrimary();
}

/** Wire the Help -> Secrets menu item + the wizard controls. */
export function initSecrets() {
  const menu = el("helpMenu");
  const helpBtn = el("helpBtn");
  el("showSecretsBtn").addEventListener("click", () => {
    menu.hidden = true;
    helpBtn.setAttribute("aria-expanded", "false");
    openSecrets();
  });
  el("preflightSecretsBtn").addEventListener("click", openSecrets);
  el("secretsCloseBtn").addEventListener("click", closeSecrets);
  el("secretsPrimaryBtn").addEventListener("click", () => void doPrimary());
  el("secretsBackBtn").addEventListener("click", () => {
    if (step > 1) step -= 1;
    setStatus("", true);
    render();
  });
  el("secretsAddBtn").addEventListener("click", () => {
    el("secretsGenericFields").hidden = false;
    el("secretsFields").hidden = false;
    el("secretsAddBtn").hidden = true;
    el("secretsPrimaryBtn").textContent = "Save & Unlock";
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el("secretsModal").hidden) closeSecrets();
  });
}
