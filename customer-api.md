# Cicadas customer API and local MCP — V1

Implementation date: 2026-10-13. Experimental standalone bridge release: authenticated production functionality has not yet been accepted with a real customer API key. The production API configuration flag was enabled on 2026-10-14, but that does not prove that authenticated queries, generation, delivery or refunds work. The workflow below documents implementation behavior; it is not a claim of completed production acceptance.

## Supported workflow

Create a customer key at `/settings/developers` after verifying the account email. A key is shown once, stored only as a SHA-256 digest, expires after 7/30/90 days and is read-only by default. At most five active keys may exist. Generation permission, a per-job ceiling and a lifetime ceiling are selected explicitly. Default ceilings are 150 credits/job and 1,000 credits/key. These limits do not purchase credits or change a subscription.

V1 generates **text-to-video only**, using the currently launch-admitted, verified, unpaused model pages returned by the live catalog. It does not accept images, reference photos, uploaded videos, arbitrary URLs, processing tools or free browser-tool jobs. Existing public image URLs cannot prove upload ownership, so those modes remain excluded. Prompts still pass the shared identity-replacement refusal and other existing generation validation. API access is not a face-swap service.

All business endpoints require `Authorization: Bearer <customer-key>`; a browser cookie does not substitute for a key. Read permission allows catalog, balance, quotes and owner-scoped status/files. Generation requires a key with spend permission. Key creation/list/revocation are separate browser-session management operations at `/api/v1/keys`, with owner checks and same-origin protection on writes; they are not MCP tools.

| Method | Path | Effect |
| --- | --- | --- |
| GET | `/api/v1/catalog` | Current usable text-to-video model options; no charge |
| GET | `/api/v1/balance` | Account balance and API-key budget; no charge |
| POST | `/api/v1/quote` | Shared request validation and current credit estimate; no charge |
| POST | `/api/v1/videos` | Explicitly confirmed creation through `createVideoJob` |
| GET | `/api/v1/videos?requestId={UUID}` | Recover an owned operation after its creation receipt/job ID was lost; no creation or charge |
| GET | `/api/v1/videos/{jobId}` | Owned job status; existing provider sync/refund maintenance may run |
| GET | `/api/v1/videos/{jobId}/file` | Authenticated, app-owned private MP4; no supplier redirect |

JSON success is `{ "code": 0, "data": {...} }`; errors contain `{ "code": -1, "error": "controlled_code", "message": "..." }`. Every response is private/no-store. Missing and foreign-owned videos both return 404. Job summaries omit prompt, email, provider IDs, provider errors, thumbnails and supplier URLs. Successful durable results expose only `/api/v1/videos/{jobId}/file`.

## Quote, approve, create, recover

Fetch the catalog first. Choose its current tool, model and supported settings. The following example is illustrative; a quote is authoritative for the accepted settings and current price:

```json
{
  "requestId": "22222222-2222-4222-8222-222222222222",
  "toolSlug": "minimax-h3",
  "mode": "text_to_video",
  "prompt": "A fictional orange cat paints a small landscape in a bright studio.",
  "duration": 5,
  "maxCredits": 70
}
```

Send this to `/api/v1/quote`. After the user approves the quoted cost, send the same fields to `/api/v1/videos` with `"confirmSpend": true`. The explicit `maxCredits` is required for both endpoints; a request above that cap or the key's per-job cap is refused. Creation returns 202 and a job summary, which may already be terminal. Read status until success, failure or cancellation; status checks do not submit another generation. Download a success only from the private API file endpoint using the same key.

Persist the exact request and its UUID locally before submitting. A UUID represents one operation within the account. If the creation response or job ID is lost, query `GET /api/v1/videos?requestId={originalUUID}` or call MCP `get_video_request`. This reads owner-bound stored state without resubmitting, including when the model is paused, its provider is missing or new generation is disabled. If a job ID is known, query that ID instead. An unknown or foreign-owned UUID gets the same 404; a 404 immediately after a timeout does not prove an in-flight submission was canceled. Wait and repeat the read before deciding on any manual recovery. Do not create a new UUID for an ambiguous paid operation. Identical manual POSTs remain idempotent when admission is available, but current catalog/live/storage admission may refuse them; GET lookup is the recovery path that bypasses those new-work gates. Reusing a UUID with changed generation fields is a conflict. No client, MCP bridge or server handler automatically retries a paid submission.

The key's lifetime budget is reserved inside the existing job + credit transaction, before credit consumption. A duplicate admitted request does not reserve or charge again. An error before the transaction commits rolls back job, key reservation and debit. Failed/canceled jobs use the existing once-only credit refund; their key budget stays reserved conservatively to limit supplier retry costs. Account refunds and API-key budget are different balances. Revocation, expiry, verification and current policy are rechecked during reservation.

HTTP 400 denotes unsupported/invalid input, 401 invalid/expired/revoked key, 403 missing verification/spend permission or account hold, 402 insufficient account/key credits, 409 cap/conflicting UUID, 413 body over 16 KiB, 415 non-JSON, 429 rate/concurrency limit and 503 unavailable live provider/private storage. HTTP/transport errors do not alone prove that no debit happened: recover the same operation and inspect its job/refund status.

## Runtime constraints

- Explicit live generation is required for new quotes/creates; mock mode fails closed for new work. Catalog items require provider and durable private-storage readiness, and unavailable catalog entries disappear. Balance, lookup, status and private files remain readable with an active owner key during provider outages. Status sync is best-effort; a stored status returned during an outage can be stale. Mock jobs are never recoverable as real customer results. The file endpoint still checks its own private-storage readiness.
- Production requires the shared database rate limiter. Failures do not silently fall back to per-process buckets for this API.
- Per-key and per-account limits use canonical action paths, stripped cookies and fixed identities; client cookies, IP headers and job IDs cannot rotate a budget bucket.
- Browser key management has separate fixed account buckets for creation (3 seconds) and revocation (250 ms). List reads use a 250 ms bucket keyed by the account plus an authoritative count of key IDs/statuses, including soft-deleted history. A committed create/revoke permits its immediate UI refresh; repeated reads of unchanged state remain throttled. No client headers, key prefixes or plaintext secrets form that revision. This is request pacing, not an account-wide supplier spending budget; generation credit limits remain separate.
- Request streams are capped at 16 KiB even without a truthful `Content-Length`. Arbitrary authority fields are rejected by strict schemas.
- Shared generation limits, request hashes, provider submission, credit consumption, private persistence and refund handling remain authoritative. The API does not introduce a second credit ledger or new automatic provider retries.

## Local MCP bridge

The separate package at `integrations/cicadas-mcp` pins the official MCP SDK server/client 2.3.1, a package-local lockfile and dependencies. It is private and has not been published to npm. Install only inside that directory:

```sh
cd integrations/cicadas-mcp
npm ci --ignore-scripts
npm test
```

Configure a trusted local MCP client to run `node /absolute/path/to/integrations/cicadas-mcp/src/server.mjs`. Put the customer key in its private environment, `CICADAS_API_KEY`, rather than a prompt or tool argument. The default API base is `https://cicadas.ai/api/v1/`. A custom HTTPS origin requires `CICADAS_ALLOW_CUSTOM_ORIGIN=1`. Loopback HTTP/HTTPS requires `CICADAS_ALLOW_HTTP_LOOPBACK=1` for development only. Redirects are never followed, and credentials/cookies cannot be sent to model-selected hosts.

Five tools are available by default: `list_video_models`, `get_credit_balance`, `quote_video`, `get_video_job`, `get_video_request`. `CICADAS_ENABLE_GENERATION=1` adds the paid `create_video` tool, whose strict input requires `confirmSpend: true`, a UUID and `maxCredits`. The server-side key must also allow generation. Tool annotations mark creation as spending and the instructions ask for user approval; annotations alone are not a spending boundary—the key policy and transaction cap are.

Optionally set `CICADAS_DOWNLOAD_DIRECTORY` to an existing absolute directory the user chooses. This adds `download_video(jobId)`, which requests only the fixed authenticated file endpoint, writes `{jobId}.mp4` with mode 0600 and exclusive creation, and returns local path/bytes/SHA-256. It refuses symlinks, existing files, redirects, non-MP4 responses and files over 100 MiB. It never accepts a path or URL from model arguments, never overwrites a user file, and removes its own partial file on error. Downloads can take at most two minutes; normal JSON calls have a 30-second timeout. A transport timeout is not provider cancellation.

This is a **local stdio bridge**, not a public remote MCP service, OAuth integration, ChatGPT app or hosted Claude connector. Remote OAuth remains separate work.

## Evidence and historical contracts

Local handler tests cover cookie refusal, mode/URL/authority rejection, quote-no-charge, admission caps, transaction recheck, readiness refusal, private summaries, owner-scoped calls, redirect refusal and streamed-body limits. The package's actual SDK stdio test initializes a subprocess, lists tools, calls a mock HTTP service, verifies one explicit paid submission, copies a binary contract fixture by hash and refuses duplicate/symlink/path-injection downloads. All tests are fixtures, not supplier-quality, real paid delivery, production migration or hosted-client acceptance.

The September 23 isolated contract/adapter worktrees were read, kept untouched and not wholesale merged. They contain draft `0.1.0-draft.1` project/OAuth/upload/quote-ID/spend-authorization contracts and fixture-only adapters. This V1 deliberately uses bounded account Bearer keys, the existing request UUID and `createVideoJob`, has no image-upload contract, and uses the actual current model catalog. The draft project/OAuth contracts remain future assets; their historical receipts do not prove this API or a remote MCP deployment.
