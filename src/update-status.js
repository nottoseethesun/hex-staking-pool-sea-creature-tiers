/**
 * @file src/update-status.js
 * @description Cross-process update-progress signal. The update pipeline writes
 * data/update-status.json as it runs so the dashboard server can show the
 * "Syncing" badge + progress bar (and an ETA) even when the scan was launched
 * from the CLI rather than the dashboard's Update button. Liveness is verified
 * by the writer's pid: a status file left behind by a killed run is reported as
 * "not updating", so the badge never sticks on forever. Each tick also appends a
 * small trailing window of progress samples so the ETA can be based on the
 * recent rate of progress rather than the average since the run began.
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
 * Trailing window (ms) used both to warm up the ETA — no estimate until a full
 * window of data has been collected (2 min) — and to measure the recent progress
 * rate. A duration-weighted pipeline changes speed between stages (fast
 * `eth_getLogs` scans vs slow `trace_filter` OA scans), so a since-start average
 * would mislead; the recent-window rate tracks the current stage.
 */
const RATE_WINDOW_MS = 120000;

/** Minimum spacing (ms) between retained progress samples (downsampling). */
const SAMPLE_GAP_MS = 3000;

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
 * This process's prior status (start time + samples), so elapsed time is
 * measured from the true start and the sample window carries across ticks.
 * @param {string} file
 * @returns {{ startedAt: string|null, samples: object[] }}
 */
function readPriorForPid(file) {
  try {
    const prev = JSON.parse(fs.readFileSync(file, "utf8"));
    if (prev && prev.pid === process.pid) {
      return {
        startedAt: prev.startedAt || null,
        samples: Array.isArray(prev.samples) ? prev.samples : [],
      };
    }
  } catch {
    // no prior run for this process
  }
  return { startedAt: null, samples: [] };
}

/**
 * Append a `{ t, p }` progress sample, downsampled to at least `SAMPLE_GAP_MS`
 * spacing and pruned to the trailing `RATE_WINDOW_MS` (always keeping >= 2 so a
 * rate stays computable).
 * @param {object[]} samples prior samples
 * @param {number} nowMs epoch ms
 * @param {number} progress 0..1
 * @returns {object[]}
 */
function pushSample(samples, nowMs, progress) {
  const list = Array.isArray(samples) ? samples.slice() : [];
  const last = list[list.length - 1];
  if (last && nowMs - last.t < SAMPLE_GAP_MS) {
    list[list.length - 1] = { t: nowMs, p: progress };
  } else {
    list.push({ t: nowMs, p: progress });
  }
  const cutoff = nowMs - RATE_WINDOW_MS;
  const pruned = list.filter((s) => s.t >= cutoff);
  return pruned.length >= 2 ? pruned : list.slice(-2);
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
    const nowMs = Date.now();
    const prior = readPriorForPid(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        updating: true,
        progress,
        phase,
        pid: process.pid,
        startedAt: prior.startedAt || new Date(nowMs).toISOString(),
        updatedAt: new Date(nowMs).toISOString(),
        samples: pushSample(prior.samples, nowMs, progress),
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
 *   startedAt: string|null, samples?: object[] }}
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
    samples: Array.isArray(raw.samples) ? raw.samples : [],
  };
}

/**
 * Estimated seconds remaining, from the **recent** rate of progress over the
 * trailing window — deliberately not the average since the run began. Returns
 * null until a full window of data has been collected (~2 min), and when
 * progress has not advanced within the window (can't estimate a stalled run).
 * @param {number|null} startedAtMs epoch ms the run began
 * @param {object[]} samples recent `{ t (ms), p }` progress samples
 * @param {number} nowMs epoch ms now
 * @returns {number|null}
 */
function etaSeconds(startedAtMs, samples, nowMs) {
  if (!startedAtMs || nowMs - startedAtMs < RATE_WINDOW_MS) return null;
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = (last.t - first.t) / 1000;
  const dp = last.p - first.p;
  if (dt <= 0 || dp <= 0) return null;
  return Math.max(0, 1 - last.p) / (dp / dt);
}

module.exports = {
  writeUpdateStatus,
  clearUpdateStatus,
  readUpdateStatus,
  etaSeconds,
  pushSample,
  isAlive,
  STATUS_PATH,
};
