# Cancel analysis and report PDF

## Cancel a running analysis

**UI:** "Cancel analysis" appears on a job while it is `QUEUED` or `PROCESSING` (job list and detail page). The uploaded video is kept; the job becomes `FAILED` with the message "Analysis cancelled by user" and can be started again.

**API:** `POST /api/jobs/:id/cancel` (session cookie or Bearer token, same-origin rule as other POSTs).

| Response | Meaning |
|---|---|
| `200 { job, runner_stopped, runs_cancelled }` | Job is cancelled. `runner_stopped=false` means GitHub could not be reached or refused; the job is cancelled anyway |
| `409` | Job is not `QUEUED`/`PROCESSING` (or its state changed meanwhile) |
| `404` | Unknown job, or owned by someone else |
| `429` / `503` | Rate limit (30/hour) / `GITHUB_TOKEN`, `GITHUB_REPO` not configured |

How it works (`worker/src/index.js`, `cancelAnalysis` + `stopRunner`):

1. The job is moved to `FAILED` **first**. Any late callback from the runner (`started`, `completed`, `failed`) is then rejected with 409, so a cancelled job can never turn `COMPLETED`.
2. The GitHub Actions run is cancelled (`POST /actions/runs/:id/cancel`):
   - `PROCESSING`: the run id is already stored (`workflow_run_id`).
   - `QUEUED`: the run id is not known yet, so the Worker lists recent `workflow_dispatch` runs and matches `display_title`. That is why `analyze-r2.yml` now has `run-name: Analyze ${{ inputs.job_id }}`. If the run has not appeared yet, nothing is cancelled; the runner stops itself when its `started` callback gets a 409.
3. Retrying within 30 s of a cancel returns 409 ("cancellation in progress"). This stops the old runner's late callbacks from hitting the new run (`CANCEL_RETRY_GRACE_MS`).

Needs a `GITHUB_TOKEN` that may write Actions (already required for dispatch). Cancelled runs still execute the workflow's `failed` step, which gets a harmless 409.

## Report PDF

- `scripts/run_analysis.py` (`write_report_pdf`) runs `rea-video pdf <out>` after the analysis. It prints `report.html` with headless Chrome (preinstalled on `ubuntu-latest`) with every fold opened, producing `report.pdf` next to the other outputs.
- It is **best effort**: any failure (no Chrome, timeout) never fails the analysis and no partial PDF is uploaded. If the first attempt fails it retries once with `--no-sandbox` through a wrapper script kept outside the uploaded folder.
- `report.pdf` is uploaded like every other output (so it is also in "Download all (ZIP)") and registered as kind `report`.
- **UI:** a "Download PDF" button next to the Report heading. It fetches fresh presigned links and downloads `report.pdf`. Analyses made before this change have no PDF, and a completed job cannot be re-analysed; upload the video again to get one.
- Note: images in the PDF come from the local output folder (`frames/`), same as the HTML.

## Tests

- `worker/test/cancel.test.js`: cancel by run id and by run-name, other jobs' runs untouched, late callbacks rejected, retry grace, GitHub failure, ownership.
- `tests/test_report_pdf.py`: PDF success and cleanup, `--no-sandbox` retry, non-fatal failure and timeout.
