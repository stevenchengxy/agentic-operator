'use strict';

// Trusted bootstrap baked into the digest-pinned candidate image. Candidate
// source and input arrive only over stdin. Every host capability crosses the
// JSON-lines stdio protocol; this image has no network, mounts, or secrets.
const readline = require('node:readline');
const vm = require('node:vm');

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const pending = new Map();
let rpcSequence = 0;
let started = false;

function send(message, callback) {
  let encoded;
  try {
    encoded = JSON.stringify(message) + '\n';
  } catch (error) {
    encoded = JSON.stringify({
      kind: 'result',
      ok: false,
      failure: 'protocol_serialize_failed',
      error: String(error && error.message || error).slice(0, 500),
    }) + '\n';
  }
  process.stdout.write(encoded, callback);
}

function finish(message, exitCode) {
  send({ kind: 'result', ...message }, () => process.exit(exitCode));
}

function jsonClone(value, label) {
  const encoded = JSON.stringify(value === undefined ? null : value);
  if (encoded === undefined) throw new TypeError(label + ' has no JSON representation');
  if (Buffer.byteLength(encoded, 'utf8') > MAX_LINE_BYTES) {
    throw new TypeError(label + ' exceeds the protocol size limit');
  }
  return JSON.parse(encoded);
}

function rpc(method, args) {
  const id = ++rpcSequence;
  const wireArgs = jsonClone(args, 'RPC arguments');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ kind: 'rpc', id, method, args: wireArgs });
  });
}

async function execute(command) {
  try {
    if (!command || command.kind !== 'execute') throw new Error('first protocol message must be execute');
    if (typeof command.javascript !== 'string' || !command.javascript.trim()) throw new Error('compiled candidate code is missing');
    if (!command.identity || typeof command.identity !== 'object') throw new Error('candidate identity is missing');

    let captured = null;
    const defineAgent = (definition) => {
      if (!definition || typeof definition !== 'object') throw new TypeError('defineAgent requires an object');
      captured = definition;
      return definition;
    };
    const runtimeFacade = Object.freeze({ defineAgent });
    const allowed = new Set(Array.isArray(command.allowlist) ? command.allowlist : []);
    const requireGenerated = (id) => {
      if (id === '@agentic/runtime') return runtimeFacade;
      if (allowed.has(id)) return require(id);
      throw new Error("CodeAct import '" + id + "' is not allowed");
    };
    const moduleObject = { exports: {} };
    const context = vm.createContext({
      TextEncoder: globalThis.TextEncoder,
      TextDecoder: globalThis.TextDecoder,
      URL: globalThis.URL,
      URLSearchParams: globalThis.URLSearchParams,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    }, { codeGeneration: { strings: false, wasm: false } });
    const load = vm.compileFunction(
      command.javascript,
      ['require', 'exports', 'module', 'defineAgent'],
      { filename: '__generated_agent__.js', parsingContext: context },
    );
    load(requireGenerated, moduleObject.exports, moduleObject, defineAgent);
    const exported = moduleObject.exports && typeof moduleObject.exports === 'object'
      ? Object.values(moduleObject.exports)
      : [];
    const definition = captured || exported.find((value) =>
      value && typeof value === 'object' && typeof value.handler === 'function');
    if (!definition || typeof definition.handler !== 'function') {
      throw new Error('generated module exposes no defineAgent handler');
    }

    const emitted = [];
    const identity = command.identity;
    const ctx = {
      agentName: String(identity.agentName || 'codeact'),
      tenantSlug: String(identity.tenantSlug || ''),
      correlationId: String(identity.correlationId || ''),
      subject: typeof identity.subject === 'string' ? identity.subject : undefined,
      reason: (systemPrompt, input) => rpc('reason', [systemPrompt, input]),
      tool: (name, args) => rpc('tool', [name, args]),
      tools: { run: (name, args) => rpc('tool', [name, args]) },
      emit(event, payload = {}) {
        if (typeof event !== 'string' || !event.trim()) throw new TypeError('emit event must be a non-empty string');
        emitted.push(jsonClone({ event, payload }, 'emit payload'));
      },
      memory: {
        get: (key, scope) => rpc('memory.get', [key, scope]),
        put: (key, value, scope) => rpc('memory.put', [key, value, scope]),
        delete: (key, scope) => rpc('memory.delete', [key, scope]),
        search: (query, k) => rpc('memory.search', [query, k]),
      },
      invoke: (agentRef, input, options) => rpc('invoke', [agentRef, input, options]),
      spawn: (task, input, options) => rpc('spawn', [task, input, options]),
      log(level, message, data) {
        send({
          kind: 'log',
          level: level === 'warn' || level === 'error' ? level : 'info',
          message: String(message || '').slice(0, 2_000),
          data: jsonClone(data, 'log data'),
        });
      },
    };

    const value = await definition.handler(jsonClone(command.input || {}, 'input'), ctx);
    const normalized = value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : { result: value };
    finish({
      ok: true,
      result: jsonClone(normalized, 'handler result'),
      emitted,
      rpcCount: rpcSequence,
    }, 0);
  } catch (error) {
    finish({
      ok: false,
      failure: 'candidate_failed',
      error: String(error && error.message || error).slice(0, 1_000),
      rpcCount: rpcSequence,
    }, 1);
  }
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    finish({ ok: false, failure: 'protocol_limit', error: 'protocol line exceeds size limit' }, 1);
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!started) {
    started = true;
    void execute(message);
    return;
  }
  if (!message || message.kind !== 'rpc_result' || !Number.isSafeInteger(message.id)) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.ok === true) waiter.resolve(message.value);
  else waiter.reject(new Error(String(message.error || 'host RPC failed').slice(0, 800)));
});

lines.on('close', () => {
  if (!started) finish({ ok: false, failure: 'protocol_eof', error: 'stdin closed before execute command' }, 1);
});
