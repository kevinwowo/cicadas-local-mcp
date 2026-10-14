# Cicadas local MCP

Experimental local stdio bridge for the [Cicadas.ai](https://cicadas.ai) customer API.

> **Authenticated functionality has not yet been verified against production.** This release passed local contract tests and a packaged MCP handshake/tool-list check. No real customer API key was used for acceptance. Live account-bound catalog, balance, quote, job lookup, key revocation, generation, download and refund flows remain unverified for this release. No paid generation tests were performed.

## What it exposes

| Default tool | Intended customer API operation |
| --- | --- |
| `list_video_models` | Read the available text-to-video model catalog |
| `get_credit_balance` | Read the account balance and key budget |
| `quote_video` | Validate a request and estimate its credit cost without creating a job |
| `get_video_job` | Retrieve an owned job's status |
| `get_video_request` | Recover an owned request by its original UUID without resubmitting generation |

All tools require a valid Cicadas customer API key. A browser session, provider key or administrator key is not a substitute. Account access is not included in this package. Existing-job status reads may perform provider status/refund maintenance; see [customer API details](customer-api.md).

## Install the MCPB bundle

Download `cicadas-local-mcp-0.1.0.mcpb` from this repository's [v0.1.0 release](https://github.com/kevinwowo/cicadas-local-mcp/releases/tag/v0.1.0). Use an MCP host that supports MCPB Node bundles and Node.js 22 or newer. Import the bundle and enter a privately stored, preferably read-only, customer API key in its sensitive configuration field.

The supplied MCPB configuration sets `CICADAS_ENABLE_GENERATION=0`; it exposes only the five tools above. Never put keys in prompts, issue reports, logs, screenshots or committed configuration.

## Run from source

Requires Node.js 22 or newer.

```sh
npm ci --ignore-scripts
npm test
npm start
```

Configure the MCP host to run `node /absolute/path/to/src/server.mjs` and provide `CICADAS_API_KEY` using the host's private environment configuration. The API base defaults to `https://cicadas.ai/api/v1/`. This is a local stdio program, not a hosted remote MCP endpoint or OAuth connector.

## Optional source configuration

The underlying bridge supports `CICADAS_ENABLE_GENERATION=1` to expose `create_video`. This is disabled in the supplied bundle. Generation additionally requires a generation-enabled customer key, explicit `confirmSpend: true`, a UUID request ID and a credit cap. Paid generation and delivery have not been tested for this release.

`CICADAS_DOWNLOAD_DIRECTORY` optionally exposes `download_video` for an existing local directory. Downloads use UUID filenames, refuse overwrites and report a local path plus SHA-256. Download delivery has not been verified against production for this release.

Custom HTTPS bases require `CICADAS_ALLOW_CUSTOM_ORIGIN=1`; loopback HTTP additionally requires `CICADAS_ALLOW_HTTP_LOOPBACK=1`. These are local operator settings, never tool inputs. Redirects and cookie authentication are refused. The bridge does not automatically retry paid generation after uncertainty. Recover with the original request UUID instead.

## Validation and scope

- Existing bridge contract tests: 6 passed on Node.js 22.23.2.
- Extracted MCPB: SDK handshake and listing of five default tools passed; generation was not exposed.
- The two bridge source files are unchanged from the existing Cicadas downloadable bridge.
- Local tests use fixture servers. They do not establish authenticated production usability, provider output, storage delivery, payment/refund behavior or visual quality.
- This repository contains only the standalone bridge and its documentation, not the Cicadas website application.

[Website](https://cicadas.ai) · [Customer API details](customer-api.md) · [Privacy policy](https://cicadas.ai/privacy-policy)
