# OMG! Plays — Pro Export (Server) Plan

This document defines a pragmatic, MVP‑first paid service that complements the free, browser‑only editor. The free app remains local, fast, and zero‑login; the Pro Export service runs on our servers to deliver high‑quality encodes and (later) advanced features.

Updated per decisions (omgplays.com + subdomain model):
- Domains: Free editor at https://omgplays.com (this repo). Pro app and API at https://pro.omgplays.com.
- Modal‑based signup/login (no redirect) to avoid losing in‑memory state.
- Usage billing (minutes) via Polar — no credits, no estimates in the free app.
- Free app does the minimum: ensure trimmed files exist and upload; everything else happens in the Pro app.
- Minimal handoff payload: project name + ordered list of trimmed clips (no detailed manifest); server returns Pro project URL immediately.
- After handoff, the free app marks the local project “completed” with a link to the Pro project and can optionally redirect.

---

## Positioning & Offering

- Free (browser):
  - Timeline editing, trims, reordering.
  - Local concatenation (optional), quick preview.
  - Saves per‑clip trims and writes prepared, trimmed files to `${project}/clips-trimmed/`.
- Pro Export (paid, server):
  - Users create an account (usage billed in minutes via Polar).
  - Upload trimmed files directly to our R2 bucket via signed URLs.
  - Submit a minimal handoff (static crop only in MVP; Pro handles presets + export UI).
  - Server encodes high‑quality outputs and returns signed download links.
  - First highlight up to 10 minutes is free via a trial minute grant on signup.

Initial output presets (MVP):
- 4K master (3840×2160 or 4096×2160 as applicable)
- 1080×1920 vertical (TikTok/Reels)
- 1080×1080 square (Instagram)

FFmpeg settings per preset (baseline):
- `-c:v libx264 -preset fast -crf 23 -c:a aac -async 1 -vsync cfr`
- Note: Final tune per preset (fps, scaling, color matrix) is configured server‑side.

---

## Integration Points (Browser ↔ Server)

1) Upsell in Highlights page
   - CTA: “Want polished crops for YouTube/TikTok? Try Pro Export — your first 10 minutes are free.”
   - Button opens an embedded modal (iframe) hosted by the Pro service. No full‑page redirect.

2) Modal‑based Auth (no redirect)
   - Free app opens an iframe to `https://pro.omgplays.com/embed/auth?nonce=…`.
   - The embed UI handles signup/login (Polar account + usage billing setup) and, on success, posts a short‑lived session token to the parent via `postMessage` (`auth:success`, `{ token, expiresAt }`).
   - Parent (free app) validates origin, stores the token in memory (not persisted), and closes the modal.
   - If third‑party cookies are blocked, token‑based Authorization headers are used; no cross‑site cookie reliance.

3) Handoff ticket (minimal metadata)
   - Free app calls `POST https://pro.omgplays.com/api/handoff/start` with `{ projectName }` using the cookie/session (credentials: 'include').
   - Server creates a `ticketId` and returns `{ ticketId, uploadPrefix, presigned: […] }` where `uploadPrefix = uploads/{userId}/{ticketId}/` and presigned URLs match the number of clips expected (or are requested per file).

4) Uploads (direct‑to‑R2 from free app)
   - Free app reads local `${project}/clips-trimmed/NN.mp4` files via File System Access and PUTs them to the provided URLs.
   - All objects are private in R2. The Pro service records sizes/hashes when uploads complete.

5) Complete handoff
   - Free app calls `POST https://pro.omgplays.com/api/handoff/complete` with `{ ticketId, files: [{ name, key, size }] }`.
   - Server verifies uploads, creates a Pro Project (`proProjectId`), and returns `{ proProjectUrl }`.
   - Free app marks local project as “completed” and stores the link (see Project Handoff below) and can optionally `window.open(proProjectUrl)`.

6) Pro app (server‑hosted) takes over
   - The Pro app loads the uploaded clips by `ticketId`/`proProjectId`, presents the dedicated crop UI (static crop MVP), and produces final outputs/presets.
   - Billing is usage‑based; minutes are computed from total output duration and recorded with Polar when the export completes.

---

## Data Model (Conceptual)

- User: { id, email, createdAt }
- UsageRecord: { id, userId, minutes, preset, jobId, createdAt, externalRef (Polar usage id) }
- Asset: { id, userId, bucketKey, size, sha256, status: uploaded|ready|expired, createdAt }
- Project (server‑side logical grouping): { id, userId, name?, createdAt }
- Job: { id, userId, projectId?, inputs: [assetId], manifest?, status, outputs, logs, createdAt, updatedAt }
  - status: created → pending → running → completed | failed | canceled | expired
- Output: { variant: '4k'|'vertical'|'square', bucketKey, size, signedUrl (on demand) }

Storage layout (Cloudflare R2, all private):
- `uploads/{userId}/{jobId}/{index}.mp4` input assets
- `outputs/{userId}/{jobId}/{variant}.mp4` encoded outputs
- Lifecycle policy: delete uploads/outputs after 30 days (configurable later)

---

## Handoff Payload (MVP)

Keep it minimal — no heavy manifest. The free app sends only what the Pro app needs to discover assets and initialize the project:

```jsonc
{
  "projectName": "My Game vs Rivals",
  "ticketId": "t_abc123",
  "clips": [
    { "name": "01.mp4", "key": "uploads/u_1/t_abc123/01.mp4", "order": 1 },
    { "name": "02.mp4", "key": "uploads/u_1/t_abc123/02.mp4", "order": 2 }
  ]
}
```

All timing is baked into the trimmed files; the Pro app focuses on cropping per clip and preset selection.

---

## API Surface (Public)

All endpoints are HTTPS JSON; authentication via Bearer token tied to user account. IDs are opaque.

- GET `https://pro.omgplays.com/embed/auth` → served as HTML for the modal iframe (signup/login + billing). On success, it posts a success event to the parent via `postMessage`; parent may also verify session via `/api/me` with credentials.

- GET `/v1/users/me` → { email, credits, createdAt }
- GET `/v1/users/me/wallet` → { credits, transactions: [...] }

- POST `/v1/uploads/presign`  
  Body: { files: [{ name, size, contentType, sha256? }, ...] }  
  Returns: [{ assetId, uploadUrl, expiresAt }...]

- POST `https://pro.omgplays.com/api/handoff/start`  
  Body: { projectName }  
  Returns: { ticketId, proProjectId, proProjectUrl, uploadPrefix, presigned: [{ name, uploadUrl, assetId }] }

- POST `https://pro.omgplays.com/api/handoff/complete`  
  Body: { ticketId, files: [{ name, key, size }] }  
  Returns: { proProjectId, proProjectUrl }

- GET `/v1/jobs/{jobId}`  
  Returns: { status, progress: 0..1, outputs?: [{ variant, size, downloadUrl }], errors?: [...] }

- POST `/v1/jobs/{jobId}/cancel`  
  Allowed while status in created|pending|running (best effort); credits handling per policy (see Billing).

- GET `/v1/presets`  
  Returns: supported variants and current encode parameters for transparency.

- Webhooks (server‑internal): `/webhooks/polar` (credit top‑ups, trial grants), signature‑validated.

---

## Billing (Usage Minutes via Polar)

- Model: usage minutes per exported output; billed via Polar usage‑based billing (no credits UI).
- Free trial: grant a usage allowance equal to 10 minutes on first signup; enforce server‑side.
- Metering: after export completes, server records usage events to Polar: `{ userId, units: minutes, category: preset }`.
- Price transparency: the Pro app displays “This job will bill N minutes” (derived from summed output durations). The free app does not estimate; it simply hands off.
- Failure handling: if export fails, no usage is recorded; if partial outputs succeed, record only the minutes produced.

---

## Job Lifecycle (Server)

1) Validate manifest, ensure all assets uploaded and owned by user.
2) Generate ffmpeg plan per preset:
   - Concat inputs to an intermediate mezzanine or stream through concat demuxer.
   - Apply `crop` (static for MVP), then scale to preset. 
   - Use `-c:v libx264 -preset fast -crf 23 -c:a aac -async 1 -vsync cfr`.
   - Ensure non‑negative timestamps (`-fflags +genpts -reset_timestamps 1 -avoid_negative_ts make_non_negative`).
3) Execute in a stateless worker. Emit progress (0..1) periodically.
4) Upload outputs to R2 as private objects.
5) Mark job completed; store sizes and checksums.
6) Return signed download URLs on status query; links expire (e.g., 1 hour).
7) Record usage minutes to Polar for billing.
7) Cleanup: delete inputs/outputs after 30 days by lifecycle policy.

Failure states & recovery:
- `failed_validation` (bad manifest, unsupported dimensions, duration mismatch)
- `failed_processing` (ffmpeg error) → include stderr tail in logs; auto‑refund
- `expired` (uploads not completed within 24h)
- `canceled` (user action)

---

## Security, Privacy, Compliance

- Storage: all R2 objects private; access via short‑lived signed URLs.
- CORS: Pro API allows origin `https://omgplays.com` and `Access-Control-Allow-Credentials: true`; free app uses `credentials: 'include'` for all calls.
- Cookies: Pro session cookie scoped to host `pro.omgplays.com`, `HttpOnly`, `Secure`, `SameSite=Lax`.
- Validation: enforce max total input duration, per‑file size caps, and acceptable MIME sniffing.
- Abuse: rate limit upload presign; per‑IP limits on account creation; device fingerprinting later if needed.
- Content policy: ToS clarifies we process user‑provided content only; you retain ownership; we acquire a limited license to process and deliver exports. No public distribution by us.
- Retention: Inputs and outputs deleted after 30 days (initial target). Metadata (jobs, billing) retained for accounting.

---

## CORS & Cookie Settings (Exact Values)

Same‑site subdomain model (omgplays.com → pro.omgplays.com) with credentialed CORS.

Free app fetch options:
- Always call Pro APIs with `credentials: 'include'`.
- Include `X-CSRF-Token` on POST/PUT/DELETE.

Pro API responses (Workers/Pages Functions):
- `Access-Control-Allow-Origin: https://omgplays.com` (exact origin, not `*`).
- `Access-Control-Allow-Credentials: true`.
- `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`.
- `Access-Control-Allow-Headers: Content-Type, X-CSRF-Token, X-Requested-With` (plus any custom headers you add).
- `Access-Control-Max-Age: 86400` and `Vary: Origin`.
- OPTIONS preflight: return 204 with the same headers.

Session cookie (set by Pro app on successful auth):
- `Set-Cookie: pro_session=<JWT or opaque>; HttpOnly; Secure; SameSite=Lax; Path=/` (no `Domain` → hostOnly `pro.omgplays.com`).
- Lax ensures the cookie is sent in the auth iframe (same‑site) and on top‑level Pro navigation; it’s also sent on credentialed fetches from the free app.

CSRF (double‑submit token):
- On GET `/embed/auth`, set a non‑HttpOnly cookie `pro_csrf=<rand>` and expose the same value in the page (or via `/api/csrf`).
- Free app includes `X-CSRF-Token: <pro_csrf>` on all mutating Pro API requests.
- Server validates header matches cookie and `Origin`/`Referer` are `https://omgplays.com`.

R2 CORS (bucket level) for presigned URLs:
- AllowedOrigin: `https://omgplays.com`
- AllowedMethods: `PUT, GET, HEAD, OPTIONS`
- AllowedHeaders: `content-type, authorization, x-amz-acl, x-amz-content-sha256, x-amz-date`
- ExposeHeaders: `etag, x-amz-request-id` (optional)
- MaxAgeSeconds: `86400`

Content Security Policy (recommended):
- On omgplays.com: `frame-src https://pro.omgplays.com;` to permit the auth iframe.
- On pro.omgplays.com: `frame-ancestors 'self' https://omgplays.com;` to prevent clickjacking.

Example Worker helper (pseudo‑code):
```
const ORIGIN = 'https://omgplays.com';
function cors(origin) {
  return origin === ORIGIN
    ? {
        'Access-Control-Allow-Origin': ORIGIN,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token, X-Requested-With',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      }
    : {};
}
```

---

## Browser App Changes (This Repo)

- Highlights page
  - CTA upsell block; “first 10 minutes free.”
  - Button: “Pro Export”.
  - Flow (minimal in the free app): 
    1) Ensure `clips-trimmed/` exists (free app already writes trims to disk).
    2) Open auth modal (iframe) to `https://pro.omgplays.com/embed/auth`. On success, receive event via `postMessage` (or verify via `/api/me`).
    3) Call `https://pro.omgplays.com/api/handoff/start` with project name → receive `{ ticketId, proProjectUrl, presigned URLs }`.
    4) Upload each `clips-trimmed/NN.mp4` to the presigned URLs.
    5) Call `https://pro.omgplays.com/api/handoff/complete` → receive `{ proProjectUrl }`.
    6) Mark the local project `completed` with `proExport` link (see below) and redirect/open the Pro app.

- No estimator UI in the free app (keep it simple). The Pro app shows the exact minutes that will be billed.

- Copy suggestions:
  - “Want pro‑quality crops for YouTube, TikTok & Instagram? Try Pro Export — your first 10 minutes are free.”

---

## Server & Cloudflare (MVP)

- API at `https://pro.omgplays.com/api/*` (Workers/Pages Functions/Hono): stateless, JWT sessions, rate‑limited.
- R2 Buckets: `uploads` and `outputs` (private) in Cloudflare R2. Lifecycle rules to purge after 30 days.
- Queue: simple SQS/Redis queue for jobs.
- Workers: containerized ffmpeg runners pulling jobs; scale horizontally.
- Billing: Polar usage‑based billing + webhooks to credit wallets.
- Observability: structured logs per job, error traces, basic metrics (jobs pending/running, duration, failures).

DNS & Routing (Cloudflare):
- `omgplays.com` → Free app (Pages/site). `pro.omgplays.com` → Pro app + API (Pages/Workers). Configure path routing so `/embed/*` and `/api/*` hit functions.
- CORS: allow `https://omgplays.com` on Pro API responses; include credentials.
- R2 presigned URLs: include `Access-Control-Allow-Origin: https://omgplays.com` for PUTs.

Scalability levers:
- Concurrency per worker; per‑preset concurrency caps.
- Max job duration guardrail; auto‑retry once on transient failures.
- Multipart uploads for large files; resumable if needed later.

---

## Pricing Examples (Usage Minutes)

- Billing unit: minute of output produced (rounded up to nearest 0.1 minute). Different presets can be priced differently if desired (per‑category usage in Polar), but MVP can start with a single rate.
- Free trial: first 10 minutes free on signup.

---

## Edge Cases & Guardrails

- Upload incomplete: job creation refused until all assets are `ready`.
- Mismatched durations: server recomputes total duration from streams; if > declared by threshold, reject with details.
- Bad timestamps: use `+genpts`/`reset_timestamps`/`avoid_negative_ts` in pipelines.
- Variable FPS inputs: normalize with `-vsync cfr` at preset fps.
- Audio track missing: still succeed; warn user.
- Zero‑length timeline/presets: reject with friendly error.
- Very long jobs: split into internal chunks; report progress periodically.
- Egress limits: outputs downloadable via signed URLs only; links expire and can be reissued.
- Auth modal closed early: leave handoff ticket in `created` until timeout; free app shows “Continue Pro Export” to reopen modal.
- Partial uploads: server keeps ticket open; client can resume with fresh presigns.
- Duplicate handoff: if a ticket is already completed, `/complete` returns the existing `proProjectUrl`.

---

## Limits & Guardrails (Initial Defaults)

Set conservative caps for MVP; revisit after real usage.

- Inputs per handoff: max 200 files.
- Allowed types: `.mp4` only (H.264 video, AAC audio). Reject others.
- Max input resolution: up to 7680×4320 (8K) accepted; outputs capped by preset.
- Max individual file size: 4 GB.
- Max total upload size per ticket: 20 GB.
- Max total input duration per ticket: 60 minutes.
- Ticket TTL: 24 hours (auto‑expire and purge orphaned uploads under the prefix).
- Presigned URL expiry: 30 minutes (re‑presign endpoint available).
- Concurrent uploads from client: recommend 3–4 at a time; backoff on 429/5xx.
- Job runtime guardrail: `max( 2×outputMinutes, outputMinutes + 10min )` hard cap; auto‑fail and refund on exceed.
- Minimum billable increment (Pro): 0.1 minute; minimum job charge: 1.0 minute (or $1.50) — finalize after benchmarking.
- Rate limits (per user): `/embed/auth` 10/min/IP, `/api/handoff/start` 3/min, `/api/uploads/presign` 20/min, `/api/handoff/complete` 10/min.
- R2 retention: inputs/outputs deleted after 30 days (lifecycle policy); metadata retained.

Validation at `/api/handoff/complete`:
- All expected filenames present (by order); no extra/unexpected keys.
- Each file has a recorded size; optionally verify sha256 if provided.
- Reject zero‑length or > caps; return actionable errors to client.

Operational guardrails:
- Idempotency: `/handoff/start` and `/handoff/complete` are idempotent by `ticketId`.
- Safe defaults for timeouts and retries (single retry on transient network or 5xx).

---

## Project Handoff (Local → Pro)

Extend the free app’s project.json to record the handoff:

```jsonc
{
  "proExport": {
    "ticketId": "t_abc123",
    "url": "https://pro.omgplays.com/p/p_456",
    "createdAt": "2025-10-07T12:34:56Z"
  },
  "status": "completed"
}
```

UI behavior in the free app:
- If `proExport.url` exists, show a banner: “This project was handed off to Pro Export.” with a button “Open in Pro”.
- Prevent further edits that would invalidate the handoff; allow “Duplicate project” to create a new local copy if needed.

---

## Roadmap After MVP

- Linear crop keyframes (client captures points; server interpolates).
- Auto‑follow (person/ball) with server‑side tracking and confidence gating (paid add‑on).
- Templates/overlays: score bug, watermark, intro/outro bumpers.
- Team/Org accounts; shared projects; branded presets.
- Webhooks for completion; email notifications.
- Regional storage (EU/US) + data residency settings.

---

## Legal & Policy (Starter)

- Terms: we only process content you provide; you retain ownership; you grant us a limited license to process and deliver exports. No public distribution by us.
- Privacy: we store inputs/outputs for 30 days by default; you can request early deletion in the app.
- Content restrictions: disallow illegal content; honor takedown requests; block repeat infringers.

---

## Success Criteria (MVP)

- User signs up, gets free trial credits, uploads `clips-trimmed/`, submits a static‑crop Pro Export, and downloads outputs.
- End‑to‑end takes < 10 minutes for typical 5–10 minute highlights.
- Clear, accurate credit estimates before confirmation; no surprise charges.
- Robust error messages and self‑serve retries/refunds on failures.

---

## Open Questions (Non‑blocking)

- Exact trial size (credits or minutes) and messaging.
- Whether to let the browser submit jobs without returning to the hosted page (post‑signup token handoff).
- Preset fps/bitrates defaults by platform; future HEVC/AV1 add‑on.

---

## Benchmark Plan & Worksheet (Pricing Input)

Purpose: measure encode speed and compute cost to set per‑minute pricing.

1) Choose container SKU
- Example: 2 vCPU / 4 GiB RAM (note $/vCPU‑hr and $/GiB‑hr from Cloudflare Containers pricing).

2) Test presets and commands
- Base ffmpeg (per preset): `-c:v libx264 -preset fast -crf 23 -c:a aac -async 1 -vsync cfr` + scale/crop.
- Presets to test: 1080×1920 vertical, 1080×1080 square, 4K master.

3) Measure realtime factor and overhead
- For each preset p, compute `F_p = minutes_of_compute / minutes_of_output` over 3–5 real clips (5–10 min each). Average.
- Measure container startup overhead `T_init` (seconds) per job.

4) Compute raw infra cost per output minute (formula)
- Let `P_v` be $/vCPU‑hr, `P_m` $/GiB‑hr; container has `C_v` vCPUs and `C_m` GiB RAM.
- Per‑minute compute cost (USD) for preset p:
  `compute_p = (C_v·P_v + C_m·P_m) · (F_p / 60)`
- Amortized startup overhead per output minute for a typical job of `M` minutes:
  `overhead_p = ((C_v·P_v + C_m·P_m) · (T_init / 3600)) / max(M, 1)`
- Optional R2 and ops adders (pennies):
  `storage_p ≈ (outputSizeGB · retentionDays/30 · R2_price_per_GB_month) / M`
  `ops_p ≈ (requests · price_per_request) / M`

5) Add payment processor fees
- `fees_p ≈ 0.03 · price + $0.30/job` — consider amortizing $0.30 for small jobs via a minimum charge.

6) Set list price with margin
- Target 60–75% gross margin: `price_p ≈ (compute_p + overhead_p + storage_p + ops_p) / (1 - margin)`.
- Round to a clean value; keep distinct price for 4K if `F_4k` ≫ `F_1080`.

Worksheet (fill values):
- Container: C_v=__, C_m=__, P_v=__, P_m=__
- T_init=__ sec
- For each preset p in {vertical, square, 4k}: F_p=__, typical job minutes M=__
- Output size (avg): vertical __ GB/min, square __ GB/min, 4k __ GB/min (optional)
- Derived compute_p, overhead_p, storage_p, ops_p → candidate price_p

Benchmark logging:
- ffmpeg command line + version, input properties, wall time, CPU%, memory, exit code.
- Derived `F_p`, `T_init`. Keep CSV for 10+ runs; recompute quarterly.

---

## Engineering Runbook (MVP)

SLOs
- Pro API availability ≥ 99.9% monthly; job success rate ≥ 99% (excluding user validation failures).
- P95 job queue wait ≤ 2 min under normal load.

Dashboards
- Job counts by status (created/pending/running/completed/failed), queued age percentiles.
- Job duration by preset (P50/P95), worker concurrency, error rates by step.
- Upload success rate, average retry count, presign 4xx/5xx.
- Billing: minutes recorded/day, trial minutes consumed, processor failures.

Alerts
- Queue backlog > N jobs for > 5 min.
- P95 job duration exceeds guardrail (`> 2×outputMinutes + 10min`).
- Worker error rate > 5% over 10 min.
- API 5xx > 2% over 5 min; CORS/preflight 4xx spikes.
- R2 errors or object PUT failure rate > 1% over 10 min.

Ops playbooks
- Ticket stuck at `awaiting_assets` > 24h: expire ticket, purge prefix, notify user.
- Re‑presign storm: slow down presign TTL, enforce client backoff, raise rate limits gradually.
- FFmpeg failures cluster (same exit code): pin version rollback or change preset parameters; rerun failed jobs.
- Pause ingestion: temporary 503 on `/api/handoff/start` with Retry‑After; drain queue, scale workers.

Secrets & config
- Store CF credentials, R2 keys, Polar keys in Workers Secrets/Bindings. Rotate quarterly.
- Pin ffmpeg versions; keep a canary worker pool for upgrades.

Data retention
- Job logs retained 30 days (same as artifacts). Consider redacting file names if needed.

Testing & staging
- Staging environment with fake R2 and Polar sandbox; run weekly “game day” to simulate spikes and failures.
