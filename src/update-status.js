/**
 * @file src/update-status.js
 * @description Cross-process update-progress signal. The update pipeline writes
 * data/update-status.json as it runs so the dashboard server can show the
 * "Syncing" badge + progress bar (and an ETA) even when the scan was launched
 * from the CLI rather than the dashboard's Update button. Liveness is verified
 * by the writer's pid: a status file left behind by a killed run is reported as
 * "not updating", so the badge never sticks on forever.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./cache/store");

/** Default location of the shared status file. */
const STATUS_PATH = path.join(DATA_DIR, "update-status.json");

/** The idle status returned when no live update is running. */
const IDLE = { updating: false, progress: 0, phase: "", startedAt: null };

/**
 * Whether a process id is currently alive on this machine. A signal of 0 does
 * no work but still performs the existence/permission check.
 * @param {number|null|undefined} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = the process exists but is owned by another user (still alive).
    return err.code === "EPERM";
  }
}

/**
 * The start time to stamp on this write: reuse the value already on disk while
 * THIS process is mid-run (so elapsed time is measured from the true start),
 * otherwise begin a fresh run now.
 * @param {string} file
 * @returns {string} ISO timestamp
 */
function runStartedAt(file) {
  try {
    const prev = JSON.parse(fs.readFileSync(file, "utf8"));
    if (prev && prev.pid === process.pid && prev.startedAt) {
      return prev.startedAt;
    }
  } catch {
    // no prior run for this process
  }
  return new Date().toISOString();
}

/**
 * Record in-progress status (called on every progress tick of the pipeline).
 * Best-effort: a failure here must never break the update itself.
 * @param {number} progress 0..1
 * @param {string} phase human-readable current phase
 * @param {string} [file] status-file path (overridable for tests)
 */
function writeUpdateStatus(progress, phase, file = STATUS_PATH) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        updating: true,
        progress,
        phase,
        pid: process.pid,
        startedAt: runStartedAt(file),
        updatedAt: new Date().toISOString(),
      }),
    );
  } catch {
    // ignore — progress signalling is advisory only
  }
}

/**
 * Mark the update finished (called when the pipeline completes or fails).
 * @param {string} [file] status-file path (overridable for tests)
 */
function clearUpdateStatus(file = STATUS_PATH) {
  try {
    fs.writeFileSync(file, JSON.stringify({ ...IDLE, pid: null }));
  } catch {
    // ignore
  }
}

/**
 * Read the current update status, treating a file left by a dead writer as
 * idle so the badge never sticks after a crash or kill.
 * @param {string} [file] status-file path (overridable for tests)
 * @returns {{ updating: boolean, progress: number, phase: string,
 *   startedAt: string|null }}
 */
function readUpdateStatus(file = STATUS_PATH) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ...IDLE };
  }
  if (!raw || !raw.updating || !isAlive(raw.pid)) return { ...IDLE };
  return {
    updating: true,
    progress: Number(raw.progress) || 0,
    phase: String(raw.phase || ""),
    startedAt: raw.startedAt || null,
  };
}

/**
 * Linear-extrapolation estimate of the seconds remaining in the run, or null
 * when it is too early to be meaningful (no start time, or under ~1% done).
 * Assumes the progress bar advances at roughly real-time speed — which the
 * duration-weighted pipeline is designed to do.
 * @param {number} progress 0..1
 * @param {number|null} startedAtMs epoch ms when the run began
 * @param {number} nowMs epoch ms now
 * @returns {number|null}
 */
function etaSeconds(progress, startedAtMs, nowMs) {
  if (!startedAtMs || !(progress > 0.01)) return null;
  const elapsed = (nowMs - startedAtMs) / 1000;
  if (elapsed <= 0) return null;
  return (elapsed * (1 - progress)) / progress;
}

module.exports = {
  writeUpdateStatus,
  clearUpdateStatus,
  readUpdateStatus,
  etaSeconds,
  isAlive,
  STATUS_PATH,
};
