import path from 'node:path';

export const usage = 'Usage: /boost <task>\n@file relative/source.js\n@check <foreground acceptance command>\nProvide 1–4 @file lines and exactly one @check.\n\nExample:\n/boost Fix clamp for negative values\n@file src/clamp.js\n@check node --test';
export function parseRequest(input) {
  const files = [], taskLines = [];
  let command = '';
  if (typeof input !== 'string' || input.length > 12000 || input.includes('\0')) throw new Error(usage);
  for (const raw of input.trim().split(/\r?\n/u)) {
    const line = raw.trim();
    if (/^@file(?:\s|$)/u.test(line)) {
      const file = line.slice(5).trim();
      if (!file || file.length > 512 || files.length >= 4 || files.includes(file) || path.posix.isAbsolute(file) || path.win32.isAbsolute(file) || file.split(/[\\/]/u).includes('..')) throw new Error(usage);
      files.push(file);
    } else if (/^@check(?:\s|$)/u.test(line)) {
      if (command || !(command = line.slice(6).trim()) || command.length > 2000) throw new Error(usage);
    } else taskLines.push(raw);
  }
  const task = taskLines.join('\n').trim();
  if (!task || !command || !files.length) throw new Error(usage);
  return { task, files, command };
}
