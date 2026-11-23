// Teamwork v1 interview contract.
//
// The interview never asks the operator to pick a development/demo/benchmark
// mode directly.  It asks what restrictions apply, then maps that selection to
// the integrity mode that governs the campaign.

import { createHash } from 'node:crypto';

export const INTEGRITY_RESTRICTIONS = Object.freeze([
  {
    value: 'a',
    label: '不能依赖外部开源代码或第三方实现',
    code: 'external-open-source',
  },
  {
    value: 'b',
    label: '不能使用仅用于演示的捷径或占位实现',
    code: 'demo-shortcuts',
  },
  {
    value: 'c',
    label: '不能硬编码评测/验收输出',
    code: 'hardcoded-outputs',
  },
  {
    value: 'd',
    label: '只允许标准库，不允许额外依赖',
    code: 'standard-library-only',
  },
  {
    value: 'e',
    label: '以上限制都不适用',
    code: 'none',
  },
]);

const RESTRICTION_LABELS = new Map(INTEGRITY_RESTRICTIONS.map(r => [r.value, r.label]));
const RESTRICTION_CODES = new Map(INTEGRITY_RESTRICTIONS.map(r => [r.value, r.code]));

export const INTERVIEW_STEPS = Object.freeze([
  {
    step: 1,
    key: 'objective',
    title: '目标',
    prompt: '这次 campaign 要达成的可验证结果是什么？',
    required: true,
    kind: 'text',
  },
  {
    step: 2,
    key: 'users',
    title: '使用者',
    prompt: '谁使用这个结果，主要在什么场景下使用？',
    required: true,
    kind: 'text',
  },
  {
    step: 3,
    key: 'restrictions',
    title: '限制与诚信约束',
    prompt: '以下哪些限制适用于本任务？（可多选）',
    required: true,
    kind: 'choice',
    multiple: true,
    options: INTEGRITY_RESTRICTIONS,
  },
  {
    step: 4,
    key: 'deliverables',
    title: '交付物',
    prompt: '需要交付哪些文件、命令或可观察结果？',
    required: true,
    kind: 'text',
  },
  {
    step: 5,
    key: 'constraints',
    title: '约束',
    prompt: '有哪些技术、范围或不可违反的约束？',
    required: true,
    kind: 'text',
  },
  {
    step: 6,
    key: 'acceptance',
    title: '验收',
    prompt: '用哪条命令或哪组可复现证据验收？',
    required: true,
    kind: 'text',
  },
  {
    step: 7,
    key: 'route',
    title: '路线',
    prompt: '这对工作更适合轻量串行路线还是完整并行路线？',
    required: true,
    kind: 'choice',
    options: [
      { value: 'swe-light', label: '轻量：实现者 → 审查者，串行推进' },
      { value: 'general', label: '完整：勘察 → 实现 → 双审查/挑战 → 审计' },
    ],
  },
  {
    step: 8,
    key: 'workdir',
    title: '工作目录',
    prompt: '在哪个工作目录中执行？（默认当前目录）',
    required: true,
    kind: 'text',
  },
  {
    step: 9,
    key: 'draft',
    title: '草案确认',
    prompt: '草案已生成。请确认文本、版本和 token 后才可启动。',
    required: false,
    kind: 'text',
  },
]);

export const REQUIRED_INTERVIEW_KEYS = Object.freeze(
  INTERVIEW_STEPS.filter(s => s.required).map(s => s.key),
);

function cleanText(value, max = 8192) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\u0000/g, '').trim().slice(0, max);
}

function stepForKey(keyOrStep) {
  if (typeof keyOrStep === 'number') {
    return INTERVIEW_STEPS.find(s => s.step === keyOrStep) || null;
  }
  const text = String(keyOrStep ?? '').trim();
  if (/^\d+$/.test(text)) {
    return INTERVIEW_STEPS.find(s => s.step === Number(text)) || null;
  }
  return INTERVIEW_STEPS.find(s => s.key === text) || null;
}

function splitSelection(value) {
  if (Array.isArray(value)) return value.flatMap(v => splitSelection(v));
  return String(value ?? '')
    .split(/[,，、;\s]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Reverse-map an integrity restriction selection to a mode.
 *
 * The UI only ever shows restriction labels; modes are an internal result.
 */
export function mapIntegrityRestrictions(selection) {
  const raw = splitSelection(selection);
  const unique = [...new Set(raw)];
  const unknown = unique.filter(v => !RESTRICTION_LABELS.has(v));
  const selected = unique.filter(v => RESTRICTION_LABELS.has(v));

  if (unknown.length || selected.length === 0) {
    return {
      mode: 'invalid',
      selected,
      unknown,
      notAllowed: [],
      standardLibraryOnly: false,
      reason: unknown.length ? `unknown restriction: ${unknown.join(',')}` : 'selection is empty',
    };
  }
  if (selected.includes('e')) {
    if (selected.length > 1) {
      return {
        mode: 'invalid',
        selected,
        unknown: [],
        notAllowed: [],
        standardLibraryOnly: false,
        reason: '“none” cannot be combined with other restrictions',
      };
    }
    return {
      mode: 'development',
      selected,
      unknown: [],
      notAllowed: [],
      standardLibraryOnly: false,
      reason: 'no restrictions selected',
    };
  }

  const notAllowed = selected
    .filter(v => v !== 'd')
    .map(v => RESTRICTION_LABELS.get(v));

  if (selected.includes('d')) {
    return {
      mode: 'benchmark',
      selected,
      unknown: [],
      notAllowed: [
        ...notAllowed,
        'dependencies outside the standard library',
        'external open-source code or third-party implementations',
      ],
      standardLibraryOnly: true,
      reason: 'standard-library-only benchmark constraints selected',
    };
  }

  return {
    mode: 'demo',
    selected,
    unknown: [],
    notAllowed,
    standardLibraryOnly: false,
    reason: 'restricted implementation constraints selected',
  };
}

export function validateInterviewAnswer(keyOrStep, value) {
  const spec = stepForKey(keyOrStep);
  if (!spec) {
    return { ok: false, code: 'UNKNOWN_STEP', reason: `unknown interview step: ${keyOrStep}` };
  }
  if (spec.kind === 'choice' && spec.multiple) {
    const mapped = mapIntegrityRestrictions(value);
    if (mapped.mode === 'invalid') {
      return {
        ok: false,
        code: 'INVALID_RESTRICTIONS',
        reason: mapped.reason,
      };
    }
    return true;
  }
  if (spec.kind === 'choice') {
    const text = cleanText(value, 64);
    const allowed = (spec.options || []).map(o => o.value);
    if (!allowed.includes(text)) {
      return {
        ok: false,
        code: 'INVALID_CHOICE',
        reason: `expected one of: ${allowed.join(', ')}`,
      };
    }
    return true;
  }
  if (spec.key === 'workdir') {
    const text = cleanText(value, 4096);
    if (!text) {
      return { ok: false, code: 'EMPTY_ANSWER', reason: 'workdir is required' };
    }
    return true;
  }
  if (spec.required && !cleanText(value)) {
    return { ok: false, code: 'EMPTY_ANSWER', reason: `${spec.key} is required` };
  }
  return true;
}

function normalizeRestrictions(value) {
  const mapped = mapIntegrityRestrictions(value);
  return {
    raw: mapped.selected.join(','),
    selected: mapped.selected,
    integrity: mapped,
  };
}

function normalizeAnswers(answers, opts = {}) {
  const source = answers && typeof answers === 'object' ? answers : {};
  const cwd = cleanText(opts.cwd, 4096) || cleanText(source.workdir, 4096) || '.';
  const mode = opts.mode || (source.route === 'general' ? 'general' : 'swe-light');
  const skipInterview = opts.skipInterview === true;

  const out = {};
  out.objective = cleanText(source.objective, 8192)
    || (skipInterview ? '未指定目标；按原始请求推进，并在草案中显式保留此缺口。' : '');
  out.users = cleanText(source.users, 4096)
    || (skipInterview ? '未指定使用者。' : '');
  out.restrictions = skipInterview && !cleanText(source.restrictions)
    ? 'e'
    : cleanText(source.restrictions, 256);
  out.deliverables = cleanText(source.deliverables, 8192)
    || (skipInterview ? '未指定交付物；以验收命令和可观察结果为准。' : '');
  out.constraints = cleanText(source.constraints, 8192)
    || (skipInterview ? '未指定额外约束。' : '');
  out.acceptance = cleanText(source.acceptance, 4096)
    || cleanText(opts.defaultAcceptance, 4096)
    || 'npm test';
  out.route = cleanText(source.route, 32) || (mode === 'general' ? 'general' : 'swe-light');
  out.workdir = cleanText(source.workdir, 4096) || cwd;
  out.originalRequest = cleanText(opts.originalRequest, 16384) || '';
  return out;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function draftToken(parts) {
  const hash = createHash('sha256').update(canonical(parts)).digest('hex');
  return `tw1_${hash.slice(0, 32)}`;
}

/**
 * Build the visible draft.  A campaign can only move to awaiting-confirm through
 * this function; skipInterview is therefore still visible and still requires an
 * explicit text confirmation.
 */
export function buildInterviewDraft(answers, opts = {}) {
  const normalized = normalizeAnswers(answers, opts);
  const errors = [];

  for (const key of REQUIRED_INTERVIEW_KEYS) {
    const value = normalized[key];
    if (!value) errors.push({ key, code: 'MISSING', reason: `${key} is required` });
  }
  if (!['swe-light', 'general'].includes(normalized.route)) {
    errors.push({ key: 'route', code: 'INVALID_ROUTE', reason: 'route must be swe-light or general' });
  }
  const integrity = mapIntegrityRestrictions(normalized.restrictions);
  if (integrity.mode === 'invalid') {
    errors.push({ key: 'restrictions', code: 'INVALID_RESTRICTIONS', reason: integrity.reason });
  }
  if (errors.length) return { ok: false, errors };

  const runId = cleanText(opts.runId, 128) || 'tw-draft';
  const version = Number.isInteger(opts.version) && opts.version > 0 ? opts.version : 1;
  const at = Number.isFinite(opts.now) ? opts.now : Date.now();
  const acceptance = normalized.acceptance;
  const confirmedCommand = cleanText(opts.confirmedCommand, 4096) || acceptance;

  const files = Array.isArray(opts.files) ? opts.files.slice(0, 4) : [];
  const deliverables = normalized.deliverables
    .split(/\n|[,，;；]/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 32);
  const constraints = normalized.constraints
    .split(/\n|[,，;；]/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 32);

  const mode = opts.mode || (normalized.route === 'general' ? 'general' : 'swe-light');
  const lines = [
    'BEGIN PROMPT',
    'Teamwork campaign request',
    `Run: ${runId}`,
    `Mode: ${mode}`,
    `Route: ${normalized.route}`,
    `Integrity mode: ${integrity.mode}`,
    `Integrity restrictions: ${integrity.notAllowed.length ? integrity.notAllowed.join('; ') : 'none'}`,
    `Objective: ${normalized.objective}`,
    `Users: ${normalized.users}`,
    `Deliverables: ${deliverables.length ? deliverables.join('; ') : normalized.deliverables}`,
    `Constraints: ${constraints.length ? constraints.join('; ') : normalized.constraints}`,
    `Files: ${files.length ? files.join('; ') : 'none'}`,
    `Acceptance: ${acceptance}`,
    `Verification command: ${confirmedCommand}`,
    `Workdir: ${normalized.workdir}`,
    'END PROMPT',
  ];
  if (normalized.originalRequest) {
    lines.splice(1, 0, `Original request: ${normalized.originalRequest}`);
  }
  const text = lines.join('\n');
  const token = draftToken({
    runId,
    version,
    text,
    route: normalized.route,
    integrity: integrity.mode,
    restrictions: integrity.selected,
    workdir: normalized.workdir,
  });

  return {
    ok: true,
    draft: {
      mode,
      text,
      confirmLine: `confirm ${runId} ${token}`,
      version,
      token,
      integrity: {
        mode: integrity.mode,
        selected: integrity.selected,
        notAllowed: integrity.notAllowed,
        standardLibraryOnly: integrity.standardLibraryOnly,
      },
      route: normalized.route,
      files,
      acceptance,
      confirmedCommand,
      workdir: normalized.workdir,
      deliverables,
      constraints,
      answers: { ...normalized },
      at,
    },
  };
}

export function interviewStepIndex(answers) {
  const source = answers && typeof answers === 'object' ? answers : {};
  for (const step of INTERVIEW_STEPS) {
    if (!step.required) return 9;
    if (!cleanText(source[step.key])) return step.step;
  }
  return 9;
}

export function answeredKeys(answers) {
  const source = answers && typeof answers === 'object' ? answers : {};
  return REQUIRED_INTERVIEW_KEYS.filter(k => cleanText(source[k]));
}

export function restrictionLabel(value) {
  return RESTRICTION_LABELS.get(value) || null;
}

export function restrictionCode(value) {
  return RESTRICTION_CODES.get(value) || null;
}
