'use strict';
/* Mathis — reading one model turn off the wire, and writing one turn back out.
 *
 * Two halves that have nothing to do with each other except that both are about
 * framing, and both are the kind of code that is much easier to test when it is
 * not tangled into a request handler.
 *
 *   collectTurn() consumes the raw event stream and rebuilds the assistant
 *   message. It deliberately does NOT use the SDK's own stream accumulator.
 *   The pinned SDK is 0.39, which predates thinking blocks entirely, and an
 *   accumulator that meets a block type it has never heard of is exactly the
 *   sort of thing that fails in production and nowhere else. Handling the
 *   events here means an unknown block type is echoed back untouched instead
 *   of throwing, which is also the correct behaviour for whatever gets added
 *   next.
 *
 *   The sinks let the handler run one pipeline and decide at the end whether
 *   it was an event stream or a JSON body. Without them the tool loop would
 *   exist twice, and the second copy would be the one with the bug.
 */

/**
 * Rebuild one assistant turn from the raw event stream.
 *
 * `onText` is called with each text delta as it arrives — that is the whole
 * reason for streaming, so it happens during the loop rather than after it.
 *
 * Returns { text, blocks, toolUses, stopReason }. `blocks` is the assistant
 * message content to append to the conversation verbatim: thinking blocks are
 * carried through with their signatures, because a turn that drops them and
 * then sends a tool result is a turn the API can reject.
 */
async function collectTurn(stream, onText) {
  const started = new Map();   // index -> the content_block from content_block_start
  const textBy  = new Map();   // index -> accumulated text
  const jsonBy  = new Map();   // index -> accumulated partial_json
  const thinkBy = new Map();   // index -> accumulated thinking
  const sigBy   = new Map();   // index -> signature
  let stopReason = null;
  let text = '';

  for await (const ev of stream) {
    if (!ev || !ev.type) continue;

    if (ev.type === 'content_block_start') {
      started.set(ev.index, ev.content_block || {});
      continue;
    }

    if (ev.type === 'content_block_delta') {
      const d = ev.delta || {};
      if (d.type === 'text_delta' && d.text) {
        text += d.text;
        textBy.set(ev.index, (textBy.get(ev.index) || '') + d.text);
        if (onText) onText(d.text);
      } else if (d.type === 'input_json_delta') {
        jsonBy.set(ev.index, (jsonBy.get(ev.index) || '') + (d.partial_json || ''));
      } else if (d.type === 'thinking_delta') {
        thinkBy.set(ev.index, (thinkBy.get(ev.index) || '') + (d.thinking || ''));
      } else if (d.type === 'signature_delta') {
        sigBy.set(ev.index, (sigBy.get(ev.index) || '') + (d.signature || ''));
      }
      // Anything else is a delta for a block type this code does not model.
      // Ignored rather than guessed at; the start block is still echoed below.
      continue;
    }

    if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) {
      stopReason = ev.delta.stop_reason;
      continue;
    }

    if (ev.type === 'message_start' && ev.message && ev.message.stop_reason) {
      stopReason = ev.message.stop_reason;
    }
  }

  const blocks = [];
  const toolUses = [];
  for (const index of [...started.keys()].sort((a, b) => a - b)) {
    const b = started.get(index) || {};
    if (b.type === 'text') {
      blocks.push({ type: 'text', text: textBy.get(index) || b.text || '' });
    } else if (b.type === 'tool_use') {
      const raw = jsonBy.get(index);
      let input = b.input && typeof b.input === 'object' ? b.input : {};
      if (raw) {
        // A truncated turn can leave the JSON half-written. An unparseable
        // input is an empty one, and the handler refuses it — better than
        // guessing at what the model meant to ask for.
        try { input = JSON.parse(raw); } catch { input = {}; }
      }
      const block = { type: 'tool_use', id: b.id, name: b.name, input };
      blocks.push(block);
      toolUses.push(block);
    } else if (b.type === 'thinking') {
      blocks.push({
        type: 'thinking',
        thinking: thinkBy.get(index) || b.thinking || '',
        ...(sigBy.get(index) || b.signature ? { signature: sigBy.get(index) || b.signature } : {}),
      });
    } else if (b.type) {
      // redacted_thinking, and whatever comes next. Echoed unchanged.
      blocks.push(b);
    }
  }

  return { text, blocks, toolUses, stopReason };
}

/**
 * Server-sent events. Opened only once the request is committed to calling the
 * model: once these headers are out there is no status code left to send, so
 * every guard has to have run and answered normally before this is created.
 */
function sseSink(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    // Proxies that buffer would hold every event until the response ended,
    // which is the same as not streaming while costing the complexity of it.
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  let open = true;
  const send = (event, data) => {
    if (!open) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
    catch { open = false; }
  };
  return {
    sse: true,
    step:    label  => send('step', { label }),
    text:    chunk  => send('text', { text: chunk }),
    figures: digest => send('figures', digest),
    error:   msg    => { send('error', { error: msg }); open = false; try { res.end(); } catch {} },
    done:    payload => { send('done', payload); open = false; try { res.end(); } catch {} },
  };
}

/** The same pipeline, buffered into one JSON body. */
function jsonSink(res) {
  const steps = [], digests = [];
  let text = '';
  return {
    sse: false,
    step:    label  => { steps.push(label); },
    text:    chunk  => { text += chunk; },
    figures: digest => { digests.push(digest); },
    error:   (msg, status) => res.status(status || 502).json({ error: msg }),
    done:    payload => res.status(200).json({
      ok: true,
      answer: text,
      steps,
      digests,
      // The first digest under its old name, so a client written against the
      // single-digest response keeps working.
      digest: digests[0] || null,
      ...payload,
    }),
  };
}

module.exports = { collectTurn, sseSink, jsonSink };
