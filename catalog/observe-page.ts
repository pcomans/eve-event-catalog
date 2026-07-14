// The demo observatory page (GET /catalog/observe): one self-contained,
// read-only HTML page — inline CSS/JS, zero new dependencies, no build step.
// Split out of catalog.ts purely to keep that channel file readable; this
// module has no side effects, no imports, just a string.
export const OBSERVE_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Event Catalog — Live Observatory</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #0b0d12;
    color: #e6e8ee;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  header {
    padding: 12px 20px;
    border-bottom: 1px solid #1e222b;
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-shrink: 0;
  }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; letter-spacing: 0.2px; }
  header .sub { font-size: 12px; color: #7d8595; }
  main {
    flex: 1;
    display: grid;
    grid-template-columns: 420px 1fr;
    gap: 1px;
    background: #1e222b;
    overflow: hidden;
  }
  .col { background: #0b0d12; display: flex; flex-direction: column; overflow: hidden; }
  .left { display: flex; flex-direction: column; gap: 1px; background: #1e222b; overflow: hidden; }
  .panel { background: #0b0d12; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
  .panel-head {
    padding: 8px 14px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #7d8595;
    border-bottom: 1px solid #1e222b;
    flex-shrink: 0;
  }
  .panel-body { overflow-y: auto; flex: 1; min-height: 0; }
  #subsPanel { flex: 1; }
  #eventsPanel { flex: 1; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #161920; vertical-align: top; }
  th { color: #7d8595; font-weight: 500; font-size: 10px; text-transform: uppercase; position: sticky; top: 0; background: #0b0d12; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .dim { color: #7d8595; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .badge-pending { background: #2a2f3a; color: #9aa3b5; }
  .badge-armed { background: #103322; color: #4ade80; }
  .badge-delivering { background: #3a2b0e; color: #f5b942; }
  .badge-fired { background: #0f2a44; color: #5db3ff; }
  .badge-expired { background: #23262e; color: #8a919e; }
  .badge-failed { background: #3a1414; color: #ff6b6b; }
  .empty { padding: 16px; color: #565d6b; font-size: 12px; font-style: italic; }
  .transcript-controls {
    padding: 10px 14px;
    display: flex;
    gap: 8px;
    border-bottom: 1px solid #1e222b;
    flex-shrink: 0;
  }
  .transcript-controls input {
    flex: 1;
    background: #12151c;
    border: 1px solid #262b36;
    color: #e6e8ee;
    padding: 7px 10px;
    border-radius: 6px;
    font-size: 13px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .transcript-controls button {
    background: #1c2130;
    border: 1px solid #2c3444;
    color: #e6e8ee;
    padding: 7px 14px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
  }
  .transcript-controls button:hover { background: #262d40; }
  .transcript-status { padding: 4px 14px; font-size: 11px; color: #565d6b; flex-shrink: 0; }
  #transcript { padding: 16px 20px; overflow-y: auto; flex: 1; min-height: 0; }
  .block { margin-bottom: 14px; max-width: 82%; }
  .block .meta { font-size: 10px; color: #565d6b; margin-bottom: 3px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .block .bubble { padding: 10px 14px; border-radius: 10px; font-size: 13px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  .block.user { margin-left: auto; }
  .block.user .bubble { background: #1c3a5e; color: #d9ecff; border-bottom-right-radius: 2px; }
  .block.assistant .bubble { background: #171b26; color: #e6e8ee; border-bottom-left-radius: 2px; border: 1px solid #232838; }
  .block.reasoning .bubble { background: #14171f; color: #8a91a3; font-style: italic; border: 1px dashed #2a2f3d; }
  .block.tool .bubble { background: #1a1f14; color: #cde3a0; border: 1px solid #2a3320; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
  .block.tool-result .bubble { background: #14201f; color: #a0e3cf; border: 1px solid #203a33; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
  .block.system .bubble { background: transparent; color: #565d6b; font-size: 11px; padding: 2px 0; text-align: center; border: none; }
  .block.error .bubble { background: #2a1414; color: #ff8a8a; border: 1px solid #4a1f1f; }
</style>
</head>
<body>
<header>
  <h1>Event Catalog — Live Observatory</h1>
  <span class="sub">read-only, auto-refreshing every 2s</span>
</header>
<main>
  <div class="left">
    <div class="panel" id="subsPanel">
      <div class="panel-head">Subscriptions</div>
      <div class="panel-body">
        <table>
          <thead><tr><th>Conversation</th><th>Provider / Event</th><th>Resource</th><th>Status</th><th>Times</th></tr></thead>
          <tbody id="subsBody"></tbody>
        </table>
      </div>
    </div>
    <div class="panel" id="eventsPanel">
      <div class="panel-head">Event Feed</div>
      <div class="panel-body">
        <table>
          <thead><tr><th>Time</th><th>Action</th><th>Provider / Event</th><th>Status</th></tr></thead>
          <tbody id="eventsBody"></tbody>
        </table>
      </div>
    </div>
  </div>
  <div class="col">
    <div class="panel">
      <div class="panel-head">Live Transcript — watch it think</div>
      <div class="transcript-controls">
        <input id="convInput" type="text" placeholder="conversationId (or a raw sessionId)" />
        <button id="watchBtn">Watch</button>
      </div>
      <div class="transcript-status" id="transcriptStatus">Enter a conversationId to begin.</div>
      <div class="panel-body" id="transcript"></div>
    </div>
  </div>
</main>
<script>
(function () {
  var POLL_MS = 2000;

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function badgeClass(status) {
    return "badge badge-" + status;
  }

  // --- Subscriptions panel ---
  function renderSubs(subs) {
    var body = document.getElementById("subsBody");
    if (!subs.length) {
      body.innerHTML = '<tr><td colspan="5"><div class="empty">No subscriptions.</div></td></tr>';
      return;
    }
    // Stable order: the registry returns Redis-set order, which shuffles
    // every poll — sort oldest-first by createdAt (id as tiebreaker).
    subs = subs.slice().sort(function (a, b) {
      return (a.createdAt || "").localeCompare(b.createdAt || "") || (a.id || "").localeCompare(b.id || "");
    });
    var rows = subs.map(function (s) {
      var times = (s.armedAt ? "armed " + s.armedAt.slice(11, 19) : "") +
        (s.firedAt ? " / fired " + s.firedAt.slice(11, 19) : "");
      return "<tr>" +
        "<td class=\\"mono dim\\">" + esc(s.conversationId) + "</td>" +
        "<td>" + esc(s.provider) + " / " + esc(s.event) + "</td>" +
        "<td class=\\"mono\\">" + esc(s.resource) + " " + esc(JSON.stringify(s.params || {})) + "</td>" +
        "<td><span class=\\"" + badgeClass(s.status) + "\\">" + esc(s.status) + "</span></td>" +
        "<td class=\\"mono dim\\">" + esc(times) + "</td>" +
        "</tr>";
    });
    body.innerHTML = rows.join("");
  }

  function pollSubs() {
    fetch("/catalog/subscriptions")
      .then(function (r) { return r.json(); })
      .then(renderSubs)
      .catch(function () {});
  }

  // --- Event feed panel ---
  function renderEvents(events) {
    var body = document.getElementById("eventsBody");
    var top = events.slice(0, 20);
    if (!top.length) {
      body.innerHTML = '<tr><td colspan="4"><div class="empty">No events yet.</div></td></tr>';
      return;
    }
    var rows = top.map(function (e) {
      return "<tr>" +
        "<td class=\\"mono dim\\">" + esc((e.timestamp || "").slice(11, 19)) + "</td>" +
        "<td>" + esc(e.action) + "</td>" +
        "<td class=\\"dim\\">" + esc(e.provider) + " / " + esc(e.event) + "</td>" +
        "<td><span class=\\"" + badgeClass(e.status) + "\\">" + esc(e.status) + "</span></td>" +
        "</tr>";
    });
    body.innerHTML = rows.join("");
  }

  function pollEvents() {
    fetch("/catalog/events")
      .then(function (r) { return r.json(); })
      .then(renderEvents)
      .catch(function () {});
  }

  // --- Live transcript panel ---
  var currentSessionId = null;
  // Bumped on every watch() call. Every in-flight pump/retry checks its own
  // generation before touching the DOM or scheduling more work, so calling
  // watch() again (even with the same id) always retires the previous
  // stream instead of running two pump loops side by side.
  var watchGeneration = 0;
  var activeAbortController = null;
  var retryTimer = null;

  function setStatus(text) {
    document.getElementById("transcriptStatus").textContent = text;
  }

  // Returns {div, bubble, meta} (or null for events with nothing to show)
  // so callers can update an in-progress block's bubble in place instead of
  // creating a new one — needed for reasoning.appended, whose reasoningSoFar
  // is the full-so-far text, not a delta to append.
  function blockFor(type, data, at) {
    var div = document.createElement("div");
    var meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = (at ? at.slice(11, 19) + " — " : "") + type;
    var bubble = document.createElement("div");
    bubble.className = "bubble";

    if (type === "message.received") {
      div.className = "block user";
      bubble.textContent = data.message || "";
    } else if (type === "message.completed") {
      if (!data.message) return null;
      div.className = "block assistant";
      bubble.textContent = data.message;
    } else if (type === "message.appended") {
      div.className = "block assistant";
      bubble.textContent = data.messageSoFar || "";
    } else if (type === "reasoning.appended") {
      div.className = "block reasoning";
      bubble.textContent = data.reasoningSoFar || "";
    } else if (type === "reasoning.completed") {
      div.className = "block reasoning";
      bubble.textContent = data.reasoning || "";
    } else if (type === "actions.requested") {
      div.className = "block tool";
      var names = (data.actions || []).map(function (a) {
        return (a.toolName || a.name || "action") + "(" + JSON.stringify(a.input || a.args || {}) + ")";
      });
      bubble.textContent = "\\u2192 " + names.join("\\n\\u2192 ");
    } else if (type === "action.result") {
      div.className = "block tool-result";
      var out = data.error ? ("error: " + data.error.message) : JSON.stringify(data.result);
      bubble.textContent = "\\u2190 [" + data.status + "] " + out;
    } else if (type === "turn.started" || type === "turn.completed" || type === "session.started" || type === "session.completed" || type === "session.waiting") {
      div.className = "block system";
      bubble.textContent = "\\u2014 " + type + " \\u2014";
    } else if (type === "turn.failed" || type === "session.failed" || type === "step.failed") {
      div.className = "block error";
      bubble.textContent = type + ": " + (data.message || "");
    } else {
      div.className = "block system";
      bubble.textContent = type;
    }

    div.appendChild(meta);
    div.appendChild(bubble);
    return { div: div, bubble: bubble, meta: meta };
  }

  // Stops whatever stream attempt is currently running (aborts its fetch,
  // cancels its pending retry) and returns the new generation for the
  // caller to start fresh with. Always bumps, even if the id is unchanged —
  // that's what keeps a re-Watch from running two pump loops concurrently.
  function stopCurrentStream() {
    watchGeneration++;
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    return watchGeneration;
  }

  function scheduleRetry(generation, sessionId) {
    if (generation !== watchGeneration) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      streamTranscript(generation, sessionId);
    }, 2000);
  }

  // The session stream never closes (it's live) — await r.text() would hang
  // forever and the panel would stay empty. Read incrementally instead: one
  // persistent connection, process each complete NDJSON line exactly once
  // as it arrives, auto-reconnect if it drops or the watched session
  // changes. The durable stream replays full history from index 0 on every
  // (re)connect, so each connection attempt starts with a cleared panel.
  function streamTranscript(generation, sessionId) {
    if (generation !== watchGeneration) return;
    var controller = new AbortController();
    activeAbortController = controller;
    var buf = "";
    var currentReasoningBlock = null;
    var currentMessageBlock = null;
    var container = document.getElementById("transcript");
    container.innerHTML = "";

    // Closes currentMessageBlock, discarding its bubble entirely if its
    // content is empty/whitespace-only instead of leaving a phantom blank
    // assistant div. Two eve harness behaviors (node_modules/eve/dist/src/harness/emission.js)
    // make that case reachable: (1) message.completed can carry
    // message: null — eve's finish-of-stream branch
    // (hasEmptyDeliverySentinel(d) ? ...message:null... : d.trim().length>0 && ...)
    // emits a null-message completion after a conditional no-delivery
    // response; (2) message.completed is skipped entirely for a
    // whitespace-only accumulated message — every flush site gates on
    // d.trim().length>0 before flushing (e.g. emitActionRequest:
    // d.trim().length>0&&await flushCurrentMessage()), so a whitespace-only
    // block never gets a completed event to finalize it.
    function closeMessageBlock() {
      if (!currentMessageBlock) return;
      if (!currentMessageBlock.bubble.textContent.trim()) {
        container.removeChild(currentMessageBlock.div);
      }
      currentMessageBlock = null;
    }

    function appendEvent(evt) {
      var data = evt.data || {};
      var metaText = ((evt.meta && evt.meta.at) ? evt.meta.at.slice(11, 19) + " — " : "") + evt.type;
      var atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 40;

      // Consecutive reasoning.appended events update the same bubble in
      // place (reasoningSoFar is cumulative, not a delta); reasoning.completed
      // finalizes it with the full text.
      if (currentReasoningBlock && (evt.type === "reasoning.appended" || evt.type === "reasoning.completed")) {
        currentReasoningBlock.bubble.textContent = evt.type === "reasoning.appended" ? (data.reasoningSoFar || "") : (data.reasoning || "");
        currentReasoningBlock.meta.textContent = metaText;
        if (evt.type === "reasoning.completed") currentReasoningBlock = null;
        if (atBottom) container.scrollTop = container.scrollHeight;
        return;
      }

      // Same coalescing as reasoning above: message.appended's messageSoFar
      // is cumulative, so dozens/hundreds of deltas update one bubble in
      // place instead of each rendering as its own empty system block.
      if (currentMessageBlock && (evt.type === "message.appended" || evt.type === "message.completed")) {
        currentMessageBlock.bubble.textContent = evt.type === "message.appended" ? (data.messageSoFar || "") : (data.message || "");
        currentMessageBlock.meta.textContent = metaText;
        if (evt.type === "message.completed") closeMessageBlock();
        if (atBottom) container.scrollTop = container.scrollHeight;
        return;
      }

      // A tool call/result closes the MESSAGE tracker only (never the
      // reasoning one — see the boundary comment below). eve only flushes
      // message.completed before a tool event for non-whitespace
      // accumulated text (harness's d.trim().length>0&&await
      // flushCurrentMessage() gate at every emitActionRequest/tool-result
      // site) — for whitespace-only text it does neither, so without this
      // the block stays open across the tool call and the step's next real
      // text reuses it in place, rendering out of order *before* the tool
      // block it actually followed. Closing here means that next text opens
      // its own fresh block via the message.appended branch below instead.
      if (evt.type === "actions.requested" || evt.type === "action.result") {
        closeMessageBlock();
      }

      var block = blockFor(evt.type, data, evt.meta && evt.meta.at);
      if (evt.type === "reasoning.appended") {
        currentReasoningBlock = block;
      } else if (evt.type === "message.appended") {
        currentMessageBlock = block;
      } else if (isStepOrTurnBoundary(evt.type)) {
        // eve emits reasoning.completed to close out each reasoning block —
        // a tool call (actions.requested/action.result) can legitimately
        // interleave BETWEEN a reasoning block's appended chunks and its
        // completed event within the same step, so only step/turn/session
        // boundaries reset the reasoning tracker. Clearing it on every
        // non-matching event (the original bug) meant reasoning.completed
        // could never find the block a preceding tool call had orphaned, so
        // it created a second, out-of-order bubble instead of finalizing
        // the first one in place. The message tracker doesn't need that
        // same tolerance (tool events already close it above), but still
        // gets swept here for the one case tool events don't cover: a
        // whitespace-only trailing message with no tool call after it at
        // all, which eve also never sends a message.completed for.
        currentReasoningBlock = null;
        closeMessageBlock();
      }
      if (!block) return;
      container.appendChild(block.div);
      if (atBottom) container.scrollTop = container.scrollHeight;
    }

    function isStepOrTurnBoundary(type) {
      return type.indexOf("step.") === 0 || type.indexOf("turn.") === 0 || type.indexOf("session.") === 0;
    }

    fetch("/catalog/sessions/" + encodeURIComponent(sessionId) + "/stream", { signal: controller.signal })
      .then(function (r) {
        if (generation !== watchGeneration) return;
        if (!r.ok || !r.body) throw new Error("stream " + r.status);
        var reader = r.body.getReader();
        var decoder = new TextDecoder();
        function pump() {
          return reader.read().then(function (res) {
            if (generation !== watchGeneration) return;
            if (res.done) { scheduleRetry(generation, sessionId); return; }
            buf += decoder.decode(res.value, { stream: true });
            var lines = buf.split("\\n");
            buf = lines.pop(); // partial tail — kept for the next chunk
            lines.forEach(function (line) {
              if (!line.trim()) return;
              var evt;
              try { evt = JSON.parse(line); } catch (e) { return; }
              appendEvent(evt);
            });
            return pump();
          });
        }
        return pump();
      })
      .catch(function (err) {
        if (generation !== watchGeneration) return;
        if (err && err.name === "AbortError") return;
        setStatus("stream error for session " + sessionId + " — retrying");
        scheduleRetry(generation, sessionId);
      });
  }

  function watch(idOrSession) {
    idOrSession = (idOrSession || "").trim();
    if (!idOrSession) return;
    var generation = stopCurrentStream();
    fetch("/catalog/conversations/" + encodeURIComponent(idOrSession))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (record) {
        if (generation !== watchGeneration) return; // superseded by a newer watch() while resolving
        currentSessionId = record ? record.sessionId : idOrSession;
        setStatus("watching session " + currentSessionId + (record ? " (resolved from conversationId)" : " (raw sessionId)"));
        streamTranscript(generation, currentSessionId);
      });
  }

  document.getElementById("watchBtn").addEventListener("click", function () {
    watch(document.getElementById("convInput").value);
  });
  document.getElementById("convInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") watch(document.getElementById("convInput").value);
  });

  var params = new URLSearchParams(window.location.search);
  var initial = params.get("conversation") || params.get("session");
  if (initial) {
    document.getElementById("convInput").value = initial;
    watch(initial);
  }

  pollSubs();
  pollEvents();
  setInterval(pollSubs, POLL_MS);
  setInterval(pollEvents, POLL_MS);
})();
</script>
</body>
</html>
`;
