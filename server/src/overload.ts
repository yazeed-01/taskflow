import type { NextFunction, Request, Response } from 'express';

// Admission control: how a small server survives more traffic than it can serve.
//
// Without it, every extra request is accepted and waits for the CPU. The queue is invisible but real: each
// waiting request holds its parsed body, a promise chain and (soon) a DB result, so memory climbs while latency
// climbs with it — in the baseline load test the server went from 112 MB to its 512 MB cap and was killed,
// and every request that had been waiting died with it.
//
// With it: at most `maxConcurrent` operations run at once; up to `maxQueue` more wait, but no longer than
// `maxWaitMs`; everything beyond that is refused immediately with 503 + Retry-After. Memory is bounded by
// construction, requests that are admitted get good latency, and clients get a clear, retryable signal.
export interface AdmissionOptions {
  maxConcurrent: number;
  maxQueue: number;
  maxWaitMs: number;
}

export const admissionDefaults = (): AdmissionOptions => ({
  maxConcurrent: Number(process.env.MAX_CONCURRENT_REQUESTS ?? 16),
  maxQueue: Number(process.env.MAX_QUEUED_REQUESTS ?? 64),
  maxWaitMs: Number(process.env.QUEUE_TIMEOUT_MS ?? 3000),
});

export interface AdmissionStats {
  inFlight: number;
  queued: number;
  rejected: number;
}

export function admissionControl(opts: AdmissionOptions = admissionDefaults()) {
  let inFlight = 0;
  let rejected = 0;
  const queue: { run: () => void; timer: NodeJS.Timeout }[] = [];

  const busy = (res: Response) => {
    rejected++;
    res
      .status(503)
      .set('Retry-After', '1')
      .json({ errors: [{ message: 'Server is busy, retry shortly', extensions: { code: 'SERVER_BUSY' } }] });
  };

  const release = () => {
    inFlight--;
    const next = queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.run();
    }
  };

  const middleware = (req: Request, res: Response, next: NextFunction) => {
    const admit = () => {
      inFlight++;
      let released = false;
      const done = () => {
        if (!released) {
          released = true;
          release();
        }
      };
      res.once('finish', done);
      res.once('close', done); // client went away mid-request: free the slot too
      next();
    };

    if (inFlight < opts.maxConcurrent) return admit();
    if (queue.length >= opts.maxQueue) return busy(res);

    const entry = {
      run: admit,
      timer: setTimeout(() => {
        const i = queue.indexOf(entry);
        if (i >= 0) queue.splice(i, 1);
        busy(res);
      }, opts.maxWaitMs),
    };
    req.once('close', () => {
      // the client gave up while waiting: stop holding a place in line
      const i = queue.indexOf(entry);
      if (i >= 0) {
        queue.splice(i, 1);
        clearTimeout(entry.timer);
      }
    });
    queue.push(entry);
  };

  middleware.stats = (): AdmissionStats => ({ inFlight, queued: queue.length, rejected });
  return middleware;
}
