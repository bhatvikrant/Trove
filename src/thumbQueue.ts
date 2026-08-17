import { getFaceThumb, getThumb } from "./api";
import type { FaceBox } from "./types";

/**
 * A bounded, newest-first queue for thumbnail requests.
 *
 * Thumbnails are generated on demand by shelling out to sips/ffmpeg/qlmanage,
 * so each miss costs real time and a real process. Expanding a folder of a few
 * thousand items — or flicking the scrollbar through one — sweeps hundreds of
 * rows past the viewport in a second, and firing a request per row buried the
 * machine in work whose results nobody would ever look at.
 *
 * So: only a handful run at once, the most recently asked-for goes first (the
 * rows under the cursor now matter more than the ones that flew past), and a
 * row that scrolls away before its turn drops out of the queue entirely.
 */

/** How many generations may be in flight at once. */
const MAX_IN_FLIGHT = 4;

type Result = string | null;

interface Job {
  key: string;
  run: () => Promise<Result>;
  /** Live callers still interested. Empty + not started ⇒ drop the job. */
  waiters: Set<(v: Result) => void>;
  started: boolean;
}

/** Resolved results. A `null` value means "no thumbnail for this file". */
const cache = new Map<string, Result>();
/** Jobs queued or in flight, so N rows for one file share one generation. */
const jobs = new Map<string, Job>();
/** Pending jobs, oldest first — taken from the end so the newest runs first. */
const queue: Job[] = [];
let inFlight = 0;

function pump() {
  while (inFlight < MAX_IN_FLIGHT && queue.length > 0) {
    const job = queue.pop()!;
    job.started = true;
    inFlight++;
    job.run().then(
      (v) => settle(job, v),
      () => settle(job, null)
    );
  }
}

function settle(job: Job, value: Result) {
  inFlight--;
  cache.set(job.key, value);
  jobs.delete(job.key);
  for (const cb of job.waiters) cb(value);
  job.waiters.clear();
  pump();
}

/** A cached result, or `undefined` if this one hasn't been resolved yet. */
export function peekThumb(key: string): Result | undefined {
  return cache.get(key);
}

/**
 * Queue `run` under `key` and call `cb` with the result. Returns a release
 * function — call it when the caller no longer cares (a row unmounting, say);
 * a job nobody is waiting for that hasn't started yet is dropped.
 */
function request(
  key: string,
  run: () => Promise<Result>,
  cb: (v: Result) => void
): () => void {
  let job = jobs.get(key);
  if (!job) {
    job = { key, run, waiters: new Set(), started: false };
    jobs.set(key, job);
    queue.push(job);
    pump();
  }
  job.waiters.add(cb);
  return () => {
    job!.waiters.delete(cb);
    if (job!.waiters.size === 0 && !job!.started) {
      jobs.delete(job!.key);
      const i = queue.indexOf(job!);
      if (i >= 0) queue.splice(i, 1);
    }
  };
}

/** Cache key for an asset thumbnail. */
export function assetThumbKey(path: string, size: number): string {
  return `a|${size}|${path}`;
}

/** Queue an asset thumbnail. Returns a release function. */
export function requestAssetThumb(
  path: string,
  size: number,
  cb: (v: Result) => void
): () => void {
  return request(assetThumbKey(path, size), () => getThumb(path, size), cb);
}

/** Cache key for a face crop. */
export function faceThumbKey(path: string, box: FaceBox, size: number): string {
  const b = `${box.x.toFixed(3)},${box.y.toFixed(3)},${box.w.toFixed(3)},${box.h.toFixed(3)}`;
  return `f|${size}|${b}|${path}`;
}

/** Queue a face crop. Returns a release function. */
export function requestFaceThumb(
  path: string,
  box: FaceBox,
  size: number,
  cb: (v: Result) => void
): () => void {
  return request(
    faceThumbKey(path, box, size),
    () => getFaceThumb(path, box, size),
    cb
  );
}
