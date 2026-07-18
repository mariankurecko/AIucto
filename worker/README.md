# Mac worker (hybrid invoice pipeline)

Offloads the CPU-heavy part of the invoice pipeline — **PDF text extraction and
OCR** — from the Raspberry Pi to a Mac. Everything else (Gmail scan, download,
classification, period validation, Drive upload, Sheets) stays on the Pi and is
unchanged.

The two machines talk only through a shared, synced folder. No servers, no
queues, no cloud.

```
/AIUCTO/
  incoming/    Pi drops <id>.<ext> + <id>.json  (a job)
  processing/  worker moves the pair here while it runs (double-run guard)
  processed/   worker parks the inputs here when done
  results/     worker writes <id>.result.json; the Pi polls for it
```

`<id>` is the document's sha256, so the same attachment is never processed
twice and interrupted runs resume cleanly.

## How it works

1. On the Pi, with `processing.mode: hybrid`, the pipeline reaches the
   extraction step and — instead of running pdf-parse/tesseract locally —
   writes the attachment plus a small JSON job into `incoming/`, then blocks
   polling `results/`.
2. The Mac worker (this folder) watches `incoming/` with chokidar, claims the
   job by atomically moving it to `processing/`, runs the pipeline's own
   `extractDocumentText` (the *exact same* code the Pi runs in local mode), and
   writes the extracted text back to `results/`.
3. The Pi picks up the result, re-materializes the text locally, and continues
   classification → Drive → Sheets exactly as before.

If the worker is down, each document soft-fails after `timeout_ms` and is marked
`review_required` rather than sinking the whole monthly run.

## One-time setup on the Mac

1. Install OCR (only needed for scanned/image documents):
   ```sh
   brew install tesseract tesseract-lang
   ```
2. Check out this repo on the Mac and install deps:
   ```sh
   cd aiucto
   npm install
   ```
3. Make `/AIUCTO` a folder that is **synced with the Pi** — Syncthing, an SMB
   share, or iCloud Drive all work. Both machines must see the same four
   subfolders.

## Run the worker

From the repo root on the Mac:

```sh
npm run worker:mac -- --root /AIUCTO
# or
AIUCTO_ROOT=/AIUCTO npm run worker:mac
```

It logs one JSON line per step (`worker.started`, `worker.job.started`,
`worker.job.extracted`, `worker.job.completed`, …). Leave it running (e.g. under
`pm2`, `launchd`, or just a terminal).

## Enable hybrid mode on the Pi

In `config/<account>.yaml` set:

```yaml
processing:
  mode: hybrid
  incoming_path: /AIUCTO/incoming   # path as seen ON THE PI
  results_path: /AIUCTO/results     # path as seen ON THE PI
  poll_interval_ms: 2000
  timeout_ms: 300000
```

Paths are per-machine: the Pi config uses the Pi's mount point, the worker uses
the Mac's (`--root`). They just need to point at the same synced folder.

Then run the pipeline as usual (`npm run invoice:monthly -- --account <acct> …`).
With `mode: local` (the default) nothing changes and no worker is needed.

## Notes

- The worker processes jobs one at a time to avoid overloading the Mac.
- Result files are written atomically (temp + rename), so the Pi never reads a
  half-written result.
- Re-running a job whose result already exists is a no-op — safe to restart
  either side at any time.
