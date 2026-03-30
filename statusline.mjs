#!/usr/bin/env bun
import { execSync } from 'child_process';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import os from 'os';

// stdin 읽기
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString('utf8').trim();
const data = input ? JSON.parse(input) : {};

const model = data.model?.display_name || 'Claude';
const ctxPct = data.context_window?.used_percentage;
const remainingPct = data.context_window?.remaining_percentage;

// 현재 컨텍스트 토큰 수 계산
const cu = data.context_window?.current_usage;
const usedTokens = cu
  ? (cu.input_tokens || 0) + (cu.cache_creation_input_tokens || 0) + (cu.cache_read_input_tokens || 0)
  : null;

function fmtTokens(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

// ── Plan Usage & Profile (5h/7d + email) ──────────────────────
const CREDENTIALS_PATH = join(os.homedir(), '.claude', '.credentials.json');
const USAGE_CACHE_PATH = join(os.tmpdir(), 'claude-usage-cache.json');
const CACHE_TTL_MS = 5 * 60 * 1000;       // 5분 (usage)

function readCredentials() {
  try {
    const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'));
    return {
      token: creds?.claudeAiOauth?.accessToken ?? null,
      subscriptionType: creds?.claudeAiOauth?.subscriptionType ?? null,
      rateLimitTier: creds?.claudeAiOauth?.rateLimitTier ?? null,
    };
  } catch { return { token: null, subscriptionType: null, rateLimitTier: null }; }
}

async function fetchPlanUsage(token) {
  try {
    if (existsSync(USAGE_CACHE_PATH)) {
      const cache = JSON.parse(readFileSync(USAGE_CACHE_PATH, 'utf8'));
      if (Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.data;
    }
  } catch {}

  // 만료된 캐시를 fallback용으로 보존
  let staleData = null;
  try {
    if (existsSync(USAGE_CACHE_PATH)) {
      staleData = JSON.parse(readFileSync(USAGE_CACHE_PATH, 'utf8')).data;
    }
  } catch {}

  if (!token) return staleData;
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { 'Authorization': `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    });
    if (!res.ok) return staleData;  // 429 등 실패 시 stale 캐시 사용
    const json = await res.json();
    const result = {
      fiveHour: json.five_hour?.utilization ?? null,
      sevenDay: json.seven_day?.utilization ?? null,
      fiveHourResetsAt: json.five_hour?.resets_at ?? null,
    };
    try { writeFileSync(USAGE_CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), data: result })); } catch {}
    return result;
  } catch { return staleData; }
}

const AUTH_CACHE_PATH = join(os.tmpdir(), 'claude-auth-cache.json');
const sessionId = data.session_id ?? null;

function getAuthInfo() {
  const currentToken = readCredentials().token;
  // 같은 세션 + 같은 토큰이면 캐시 사용
  try {
    if (existsSync(AUTH_CACHE_PATH)) {
      const cache = JSON.parse(readFileSync(AUTH_CACHE_PATH, 'utf8'));
      if (cache.sessionId === sessionId && cache.token === currentToken) return cache.data;
    }
  } catch {}

  try {
    const output = execSync('claude auth status --json', {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000
    }).trim();
    const info = JSON.parse(output);
    const result = { email: info.email ?? null, subscriptionType: info.subscriptionType ?? null, orgName: info.orgName ?? null };
    try { writeFileSync(AUTH_CACHE_PATH, JSON.stringify({ sessionId, token: currentToken, data: result })); } catch {}
    return result;
  } catch { return { email: null, subscriptionType: null, orgName: null }; }
}

// ── JSONL 파일에서 오늘/주간 비용 계산 ────────────────────────
function getCosts() {
  const now = Date.now();
  const DAY = 86400000;
  const WEEK = 7 * DAY;
  let today = 0, week = 0;

  const projectsDir = join(os.homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) return { today, week };

  function processDir(dir) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) { processDir(p); continue; }
        if (!entry.name.endsWith('.jsonl')) continue;
        try {
          for (const line of readFileSync(p, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try {
              const r = JSON.parse(line);
              const cost = r.costUSD || r.cost_usd || r.cost || 0;
              if (!cost || typeof cost !== 'number') continue;
              const raw = r.timestamp || r.ts;
              if (!raw) continue;
              const ms = typeof raw === 'number'
                ? (raw > 1e12 ? raw : raw * 1000)
                : new Date(raw).getTime();
              if (isNaN(ms)) continue;
              const age = now - ms;
              if (age < WEEK) week += cost;
              if (age < DAY) today += cost;
            } catch {}
          }
        } catch {}
      }
    } catch {}
  }

  processDir(projectsDir);
  return { today, week };
}

// ── Git 정보 ───────────────────────────────────────────────────
function getGit(cwd) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  const opts = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], cwd: cwd || process.cwd(), env };
  try {
    const branch = execSync('git branch --show-current', opts).trim();
    if (!branch) return null;

    // worktree 경로 감지: .git이 파일(worktree)인지 디렉토리(메인)인지 확인
    let worktreeName = null;
    try {
      const gitDir = execSync('git rev-parse --git-dir', opts).trim();
      // worktree의 경우 .git/worktrees/<name> 형태
      const wtMatch = gitDir.replace(/\\/g, '/').match(/\/worktrees\/([^/]+)$/);
      if (wtMatch) worktreeName = wtMatch[1];
    } catch {}

    let added = 0, removed = 0;
    try {
      const numstat = execSync('git diff HEAD --numstat', opts).trim();
      for (const line of numstat.split('\n').filter(Boolean)) {
        const [a, r] = line.split('\t');
        added += parseInt(a) || 0;
        removed += parseInt(r) || 0;
      }
    } catch {}

    // ahead/behind remote
    let ahead = 0, behind = 0;
    try {
      const ab = execSync(`git rev-list --left-right --count @{upstream}...HEAD`, opts).trim();
      const [b, a] = ab.split(/\s+/);
      behind = parseInt(b) || 0;
      ahead = parseInt(a) || 0;
    } catch {}

    // worktree count
    let worktreeCount = 0;
    try {
      const wtList = execSync('git worktree list --porcelain', opts).trim();
      worktreeCount = (wtList.match(/^worktree /gm) || []).length - 1; // exclude main
    } catch {}

    return { branch, worktreeName, added, removed, ahead, behind, worktreeCount };
  } catch { return null; }
}

// ── 조합 ──────────────────────────────────────────────────────
const { token, subscriptionType, rateLimitTier } = readCredentials();

const [planUsage, { today, week }] = await Promise.all([
  fetchPlanUsage(token),
  Promise.resolve(getCosts()),
]);
const authInfo = getAuthInfo();

function colorBar(pct, len = 10, bgOverride = null) {
  const vBlocks = ['▁', '▂', '▃', '▄', '▅', '▆'];
  const progress = pct / 100 * len;
  const full = Math.floor(progress);
  const frac = Math.round((progress - full) * 7);
  const effectiveFull = frac === 7 ? full + 1 : full;
  const showFrac = frac > 0 && frac < 7;
  const fillEnd = effectiveFull + (showFrac ? 1 : 0);

  // Nord Aurora 3단계: green / orange / red
  const nord = {
    green:  { bg: '\x1b[48;2;163;190;140m', fg: '\x1b[38;2;163;190;140m' },  // #a3be8c
    orange: { bg: '\x1b[48;2;208;135;112m', fg: '\x1b[38;2;208;135;112m' },  // #d08770
    red:    { bg: '\x1b[48;2;191;97;106m',  fg: '\x1b[38;2;191;97;106m'  },  // #bf616a
    snow:   '\x1b[38;2;236;239;244m',                                         // #eceff4
    snowUl: '\x1b[58;2;236;239;244m',
    empty:  '\x1b[48;2;59;66;82m',                                            // #3b4252
    dim:    '\x1b[38;2;216;222;233m',                                          // #d8dee9
    dimUl:  '\x1b[58;2;216;222;233m',
  };
  const themes = [
    { max: 60,       ...nord.green  },
    { max: 85,       ...nord.orange },
    { max: Infinity, ...nord.red    },
  ];
  let theme = themes.find(t => pct < t.max);
  if (bgOverride) {
    theme = { ...theme, bg: bgOverride, fg: bgOverride.replace('48;', '38;') };
  }
  const filledTextUl = nord.snow + nord.snowUl;
  const bgEmpty = nord.empty;
  const emptyTextUl = nord.dim + nord.dimUl;

  // 셀 구성: filled(배경색+ul) / frac(수직블록) / empty(회색+ul)
  const cells = [];
  for (let i = 0; i < len; i++) {
    if (i < effectiveFull)            cells.push({ ch: ' ', type: 'filled', isText: false });
    else if (i === full && showFrac)  cells.push({ ch: vBlocks[frac - 1], type: 'frac', isText: false });
    else                              cells.push({ ch: ' ', type: 'empty', isText: false });
  }

  // 퍼센테이지 텍스트 삽입
  const pctText = `${Math.round(pct)}%`;
  let textStart = pct < 50
    ? Math.max(fillEnd, len - pctText.length - 1)
    : 1;
  textStart = Math.max(1, Math.min(textStart, len - pctText.length - 1));
  for (let i = 0; i < pctText.length && textStart + i < len; i++) {
    const idx = textStart + i;
    const type = cells[idx].type === 'frac' ? 'filled' : cells[idx].type;
    cells[idx] = { ch: pctText[i], type, isText: true };
  }

  // 렌더링
  let result = '';
  let prevKey = '';
  for (const { ch, type, isText } of cells) {
    const key = `${type}:${isText}`;
    if (key !== prevKey) {
      result += '\x1b[0m';
      if (type === 'filled') result += theme.bg + '\x1b[4m' + filledTextUl;
      else if (type === 'frac') result += bgEmpty + '\x1b[4m' + nord.snowUl + theme.fg;
      else                       result += bgEmpty + '\x1b[4m' + emptyTextUl;
      prevKey = key;
    }
    result += ch;
  }
  result += '\x1b[0m';

  return result;
}

// ANSI 코드 + OSC 8 하이퍼링크를 제거한 순수 표시 너비 계산
function stripAnsi(str) {
  return str.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;]*m/g, '');
}

// 각 줄을 터미널 너비 - 40으로 잘라내기 (auto-compact 알림 공간 확보)
function truncateLine(str) {
  const cols = process.stdout.columns || 120;
  const maxWidth = Math.max(40, cols - 40);
  const plain = stripAnsi(str);
  if (plain.length <= maxWidth) return str;
  // 유니코드 이모지 고려한 잘라내기
  let width = 0;
  let i = 0;
  while (i < str.length && width < maxWidth - 1) {
    // ANSI escape 시퀀스는 너비 0
    const oscMatch = str.slice(i).match(/^\x1b\][^\x07]*\x07/);
    if (oscMatch) { i += oscMatch[0].length; continue; }
    const ansiMatch = str.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (ansiMatch) { i += ansiMatch[0].length; continue; }
    width++;
    i++;
  }
  return str.slice(0, i) + '…';
}

// ── Label helper (모든 라벨 5칸 정렬) ───────────────────────
function L(tag) { return tag.padEnd(5); }

// ── Data extraction ─────────────────────────────────────────
const projectDir = data.workspace?.project_dir ?? null;
const currentDir = data.workspace?.current_dir ?? null;
const cwd = currentDir || process.cwd();
const addedDirs = data.workspace?.added_dirs ?? [];

const isPersonalOrg = authInfo.orgName && authInfo.email
  && authInfo.orgName.includes(authInfo.email);
const identity = isPersonalOrg ? authInfo.email : (authInfo.orgName || authInfo.email);

// ── Per-project Git info ────────────────────────────────────
const allProjects = [projectDir || cwd];
for (const d of addedDirs) {
  if (d !== allProjects[0]) allProjects.push(d);
}
const projectGits = allProjects.map(d => ({ path: d, name: basename(d), git: getGit(d) }));

// ── Build lines ─────────────────────────────────────────────
const lines = [];

// Per-project blocks (PRJ / WKT / BR)
for (const proj of projectGits) {
  lines.push(`${L('PRJ')}${proj.name}`);
  if (proj.git) {
    // WKT: worktree name / total count (메인 포함)
    const totalWt = (proj.git.worktreeCount || 0) + 1;
    const wtName = proj.git.worktreeName || 'main';
    lines.push(`${L('WKT')}${wtName} / ${totalWt}`);
    // BR: branch + ahead/behind + diff
    let br = `${L('BR')}${proj.git.branch}`;
    const ab = [];
    if (proj.git.ahead) ab.push(`\u2191${proj.git.ahead}`);
    if (proj.git.behind) ab.push(`\u2193${proj.git.behind}`);
    if (ab.length) br += ` ${ab.join(' ')}`;
    if (proj.git.added || proj.git.removed) br += `  (+${proj.git.added},-${proj.git.removed})`;
    lines.push(br);
  }
  lines.push('\u200B');
}

// LLM
lines.push(`${L('LLM')}${model}`);

// CTX
{
  const pct = ctxPct != null ? Number(ctxPct) : 0;
  const acTrigger = 84;
  let ctxColor;
  if (pct < 20) ctxColor = '\x1b[48;2;163;190;140m';
  else if (pct < 50) ctxColor = '\x1b[48;2;208;135;112m';
  else ctxColor = '\x1b[48;2;191;97;106m';
  let ctx = `${L('CTX')}${colorBar(pct, 10, ctxColor)}`;
  if (pct >= 75) {
    const left = Math.round(acTrigger - pct);
    ctx += left <= 0 ? ' AC!' : ` -${left}%`;
  }
  lines.push(ctx);
}

// ORG
if (identity) lines.push(`${L('ORG')}${identity}`);

// PLN
if (subscriptionType) {
  let planStr = subscriptionType;
  if (rateLimitTier) {
    const tier = rateLimitTier.replace('default_claude_', '').replace(/_/g, ' ').trim();
    if (tier && tier !== subscriptionType) planStr += ` (${tier})`;
  }
  lines.push(`${L('PLN')}${planStr}`);
}

// 5H
if (planUsage?.fiveHour != null) {
  const pct5 = Number(planUsage.fiveHour);
  let str = `${L('5H')}${colorBar(pct5)}`;
  if (planUsage.fiveHourResetsAt) {
    const resetsAt = new Date(planUsage.fiveHourResetsAt);
    const h = resetsAt.getHours();
    const ampm = h < 12 ? 'am' : 'pm';
    const h12 = h % 12 || 12;
    const m = resetsAt.getMinutes();
    const timeStr = m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;
    str += ` ~${timeStr}`;
  }
  lines.push(str);
}

// 7D
if (planUsage?.sevenDay != null) {
  const pct7 = Number(planUsage.sevenDay);
  lines.push(`${L('7D')}${colorBar(pct7)}`);
}

// UP
const durationMs = data.cost?.total_duration_ms ?? null;
if (durationMs != null && durationMs > 0) {
  const totalMins = Math.floor(durationMs / 60000);
  const hrs = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  lines.push(`${L('UP')}${hrs > 0 ? `${hrs}h ${m}m` : `${m}m`}`);
}

// ── Output ────────────────────────────────────────────────────
process.stdout.write(lines.map(truncateLine).join('\n') + '\n');
