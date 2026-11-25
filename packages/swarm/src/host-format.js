// Small shared helpers for the Swarm host half. No DSH imports live here so
// the module is directly testable with `node --test`.

export class HostError extends Error {
  constructor(code, message, details = undefined) {
    super(message || code);
    this.name = 'HostError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function failure(code, message, details) {
  return new HostError(code, message, details);
}

export function asHostError(error) {
  if (error instanceof HostError) return error;
  if (error && typeof error === 'object' && typeof error.code === 'string') {
    return new HostError(error.code, error.message || error.code);
  }
  return new HostError('INTERNAL', error instanceof Error ? error.message : String(error));
}

export function okText(value) {
  return { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) };
}

export function truncateText(text, limit) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (value.length <= limit) return value;
  if (limit <= 1) return '…';
  return `${value.slice(0, limit - 1)}…`;
}

export function oneLine(text, limit = 200) {
  return truncateText(String(text ?? '').replace(/\s+/g, ' ').trim(), limit);
}

export function contractReceipt(added) {
  if (!added.taskId) return '';
  return ` Delivery ${JSON.stringify(added.taskId)} assigned.${added.notified ? '' : ' Join notice not delivered; the assignment is saved.'}`;
}

export function byteLength(text) {
  return new TextEncoder().encode(String(text ?? '')).length;
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/** Quote-aware splitter for `/swarm` command input. */
export function splitWords(raw) {
  const words = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const char of String(raw ?? '')) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

/**
 * Parse raw command input. DSH passes text without the leading slash in most
 * builds, but tolerate `/swarm ...` too so the same helper works from tests.
 */
export function parseSwarmInput(raw) {
  const words = splitWords(raw);
  if (words[0] === 'swarm' || words[0] === '/swarm') words.shift();
  return words;
}

export function takeFlag(words, name) {
  const index = words.indexOf(name);
  if (index === -1) return null;
  const value = words[index + 1];
  if (value === undefined) return null;
  words.splice(index, 2);
  return value;
}

export function hasFlag(words, name) {
  const index = words.indexOf(name);
  if (index === -1) return false;
  words.splice(index, 1);
  return true;
}

export function firstLine(text, limit = 90) {
  const line = String(text ?? '').split(/\r?\n/, 1)[0];
  return oneLine(line, limit);
}
