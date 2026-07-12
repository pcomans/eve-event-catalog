# Known Issues

Sharp edges discovered while building on eve 0.22.5 (beta). Read this before touching channel
code or running a demo.

## 1. Channel event handlers can silently stop firing after a hot reload

eve re-resolves channel `events` handlers from a registry keyed by channel "kind" on every
workflow step — handler functions are not carried by reference across steps. After a hot reload,
a session started *before* the edit can look its handlers up against the rebuilt registry and
miss: eve's internal `callAdapterEventHandler` is a **silent no-op** on a missing/mismatched
entry. No error, no log line. For us this means arm-on-turn-complete (`turn.completed` →
`pending → armed`) simply doesn't happen for pre-edit sessions.

- **For development**: after touching channel code, restart the dev server and use a fresh
  conversation id. Never trust behavior of a session that predates your latest edit.
- **For the demo**: not a risk, as long as nothing is edited and `.env.local` isn't touched
  mid-demo — both reload triggers are things you control.
- **Worth knowing**: it's arguably an eve bug (a silent no-op on handler resolution failure is
  hostile to debugging), and it's beta software. If you ever talk to the eve team, this plus the
  broken `getEventStream` docs example (issue 3) are two concrete pieces of feedback from this
  project.

## 2. Any `.env.local` write triggers a hot reload that wipes in-process state

`eve dev` watches env files (documented in eve's CLI reference). A reload drops all in-process
module state — live websocket connections, timers, anything not in Redis — and orphans sessions
mid-turn ("Unhandled queue" log spam). Corollaries:

- Never run `vercel env pull` while the dev server is up.
- `vercel env pull` **overwrites** `.env.local` wholesale — it only writes what's stored in
  Vercel's project env store. All secrets are stored there now (as of 2026-07-11), so pulls are
  safe, but any var added only to the local file will be lost on the next pull.
- `VERCEL_OIDC_TOKEN` expires after ~12h; refresh with `vercel env pull` (server down) **before**
  a demo or test session, never during one.

## 3. eve's custom-channel docs example for streaming is broken

`session.getEventStream()` returns a `ReadableStream` of JS objects, not bytes. Passing it
directly to `new Response(...)` — exactly what eve's `docs/channels/custom.mdx` shows — kills the
connection with an opaque ECONNRESET. The fix (copied from eve's own built-in channel source) is
bridging through a TransformStream that does `JSON.stringify(event) + "\n"` via `TextEncoder`.
See `agent/channels/catalog.ts`.

## 4. `channel.continuationToken` arrives prefixed

In channel event handlers, `channel.continuationToken` is the fully-qualified token
(`"catalog:demo-1"`), not the raw conversation id passed to `send()` — the framework prepends the
channel name. Strip the prefix before registry lookups. The docs mention token namespacing but
never show it landing on this field.

## 5. `vercel integration add` installs agent skills as a side effect

Provisioning the Upstash Marketplace integration auto-installed Upstash reference-doc skills into
`agent/skills/` + `skills-lock.json`, silently expanding the agent's own context surface. Removed
(2026-07-11, user-approved). If another integration is ever added, check `git status` for
unrequested `agent/` changes afterwards.

## 6. LangSmith exporter is a silent no-op without `LANGSMITH_TRACING=true`

`LangSmithOTLPTraceExporter` checks `isEnvTracingEnabled()` per export batch; if
`LANGSMITH_TRACING` (or `LANGSMITH_TRACING_V2`) isn't `"true"`, it drops all spans while
reporting success to the OTel pipeline — no error, no log. The var is provisioned in Vercel's
env store (development) as of 2026-07-11, so `vercel env pull` includes it; if traces ever stop
appearing, check this var first.

## 7. A wake POSTed from inside `turn.completed` races session parking — and eve handles it correctly

`emitTurnEpilogue` (eve's compiled `harness/emission.js`) awaits the `turn.completed` emit — which
drives our channel event handler to completion — *before* emitting `session.waiting`. So a
`provider.arm()` that calls `deliverWake()` synchronously sends its loopback `POST /catalog/wake`
(→ `send()` on the same continuation token) while the session hasn't technically parked yet.

Verified experimentally (`catalog/wake.ts`'s `armPendingForConversation` doc comment has the
detail): a throwaway provider whose `arm()` called `deliverWake()` with zero delay — worse than any
real provider, which needs at least a network round trip to detect a tick — still landed the wake
as the correctly-ordered next turn on the *same* session. eve's local dev (`world-local`) backend
buffers the reentrant `send()` rather than falling back to a new session. No extra defer/scheduling
machinery was added; the existing session-id-mismatch check in the wake route stays as an automatic
backstop in case this behaves differently against a different workflow backend (e.g. in production).

## 8. Assorted

- The dev server listens on port **2000**, not 3000 as eve's own docs curl examples suggest.
- Local durable workflow state lives in `.workflow-data/` (gitignored). If sessions look stuck
  after crashes/reload incidents, stopping the server and deleting it gives a clean slate —
  active subscriptions in Redis survive, but their parked sessions do not; re-subscribe.
- Live IEX market data only flows during US market hours (9:30–16:00 ET, Mon–Fri). Off-hours,
  price subscriptions arm but never fire, and notional market orders won't fill.
