import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ENV } from '../config/env.ts';

// --- Prompt Injection Detection & Input Sanitization ---
const INJECTION_PATTERNS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: 'system_override', regex: /\b(ignore|disregard|bypass|override)\s+(all\s+)?((previous|prior|system|safety)\s+)+(instructions|rules|prompts?)\b/i },
  { label: 'prompt_leak', regex: /\b(reveal|print|dump|show|repeat)\s+(your\s+)?(system\s+prompt|hidden\s+instructions|api\s+key|secret)\b/i },
  { label: 'token_delimiter', regex: /(<\|im_start\|>|<\|im_end\|>|\[SYSTEM\]|###\s*SYSTEM)/i },
  { label: 'jailbreak_persona', regex: /\b(DAN\s+mode|developer\s+mode\s+enabled|act\s+without\s+restrictions)\b/i },
];

export interface SanitizationResult {
  sanitized: string;
  flagged: boolean;
  reasons: string[];
}

export function sanitizeUserInput(raw: string, maxLength = 8000): SanitizationResult {
  const cleaned = raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);

  const reasons: string[] = [];
  for (const p of INJECTION_PATTERNS) {
    if (p.regex.test(cleaned)) {
      reasons.push(p.label);
    }
  }

  return {
    sanitized: cleaned,
    flagged: reasons.length > 0,
    reasons,
  };
}

// --- SSRF Guard for External URL Reads ---
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
  /\.local$/i,
  /\.internal$/i,
];

export function validateExternalUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL format.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are permitted.');
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(host))) {
    throw new Error('Access to private, loopback, or metadata network addresses is blocked.');
  }

  return parsed;
}

// --- Safe Recursive-Descent Math Parser (No eval / Function) ---
export function evaluateMathExpression(expr: string): number {
  const tokens = tokenizeMath(expr);
  let pos = 0;

  function peek(): string | undefined {
    return tokens[pos];
  }

  function consume(): string {
    return tokens[pos++]!;
  }

  function parseExpression(): number {
    let val = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = consume();
      const right = parseTerm();
      val = op === '+' ? val + right : val - right;
    }
    return val;
  }

  function parseTerm(): number {
    let val = parsePower();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = consume();
      const right = parsePower();
      if (op === '*') val *= right;
      else if (op === '/') {
        if (right === 0) throw new Error('Division by zero.');
        val /= right;
      } else {
        if (right === 0) throw new Error('Modulo by zero.');
        val %= right;
      }
    }
    return val;
  }

  function parsePower(): number {
    const base = parseUnary();
    if (peek() === '^') {
      consume();
      const exp = parsePower();
      return Math.pow(base, exp);
    }
    return base;
  }

  function parseUnary(): number {
    if (peek() === '-') {
      consume();
      return -parseUnary();
    }
    if (peek() === '+') {
      consume();
      return parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary(): number {
    const tok = peek();
    if (!tok) throw new Error('Unexpected end of expression.');

    if (tok === '(') {
      consume();
      const val = parseExpression();
      if (consume() !== ')') throw new Error('Mismatched parentheses.');
      return val;
    }

    if (/^[0-9]+(\.[0-9]+)?$/.test(tok)) {
      consume();
      return Number(tok);
    }

    if (/^[a-zA-Z_]+$/.test(tok)) {
      consume();
      const lower = tok.toLowerCase();
      if (lower === 'pi') return Math.PI;
      if (lower === 'e') return Math.E;

      if (consume() !== '(') throw new Error(`Expected '(' after function ${tok}.`);
      const arg = parseExpression();
      if (consume() !== ')') throw new Error(`Expected ')' after argument to ${tok}.`);

      switch (lower) {
        case 'sqrt': {
          if (arg < 0) throw new Error('Square root of negative number.');
          return Math.sqrt(arg);
        }
        case 'abs': return Math.abs(arg);
        case 'round': return Math.round(arg);
        case 'floor': return Math.floor(arg);
        case 'ceil': return Math.ceil(arg);
        case 'sin': return Math.sin(arg);
        case 'cos': return Math.cos(arg);
        case 'tan': return Math.tan(arg);
        case 'log': return Math.log10(arg);
        case 'ln': return Math.log(arg);
        default:
          throw new Error(`Unsupported math function: ${tok}`);
      }
    }

    throw new Error(`Unexpected token: ${tok}`);
  }

  const result = parseExpression();
  if (pos < tokens.length) {
    throw new Error(`Unexpected trailing token: ${tokens[pos]}`);
  }
  if (!Number.isFinite(result)) {
    throw new Error('Expression evaluated to a non-finite number.');
  }
  return result;
}

function tokenizeMath(input: string): string[] {
  const cleaned = input.replace(/\s+/g, '');
  if (!cleaned || cleaned.length > 256) {
    throw new Error('Math expression is empty or exceeds 256 characters.');
  }
  const tokens: string[] = [];
  let i = 0;
  while (i < cleaned.length) {
    const ch = cleaned[i]!;
    if ('+-*/%^()'.includes(ch)) {
      tokens.push(ch);
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const match = cleaned.slice(i).match(/^[0-9]+(\.[0-9]+)?/);
      if (!match) throw new Error(`Invalid number at position ${i}`);
      tokens.push(match[0]);
      i += match[0].length;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const match = cleaned.slice(i).match(/^[a-zA-Z_]+/);
      if (!match) throw new Error(`Invalid identifier at position ${i}`);
      tokens.push(match[0]);
      i += match[0].length;
      continue;
    }
    throw new Error(`Disallowed character in math expression: ${ch}`);
  }
  return tokens;
}

// --- Sliding-Window Rate Limiter ---
interface RateBucket {
  timestamps: number[];
}

export function createRateLimiter(maxPerMinute = ENV.RATE_LIMIT_MAX_RPM) {
  const buckets = new Map<string, RateBucket>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const windowStart = now - 60_000;
    const bucket = buckets.get(key) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((t) => t > windowStart);

    if (bucket.timestamps.length >= maxPerMinute) {
      res.status(429).json({
        error: 'Rate limit exceeded. Please wait before sending additional requests.',
      });
      return;
    }

    bucket.timestamps.push(now);
    buckets.set(key, bucket);
    next();
  };
}

// --- Firebase ID Token Verification (Zero-IAM JWKS verification) ---
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
);

export interface VerifiedActor {
  userId: string;
  authenticated: boolean;
  emailVerified: boolean;
}

export async function resolveRequestActor(authHeader?: string, guestSessionId?: string): Promise<VerifiedActor> {
  if (authHeader && authHeader.startsWith('Bearer ') && ENV.FIREBASE.projectId) {
    const token = authHeader.slice(7).trim();
    if (token) {
      try {
        const { payload } = await jwtVerify(token, FIREBASE_JWKS, {
          issuer: `https://securetoken.google.com/${ENV.FIREBASE.projectId}`,
          audience: ENV.FIREBASE.projectId,
        });
        if (typeof payload.sub === 'string' && payload.sub.length > 0) {
          return {
            userId: payload.sub,
            authenticated: true,
            emailVerified: Boolean(payload.email_verified),
          };
        }
      } catch {
        // Invalid/expired bearer token falls back to rejected if auth required or guest isolation
      }
    }
  }

  const safeGuest = (guestSessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'default';
  return {
    userId: `guest_${safeGuest}`,
    authenticated: false,
    emailVerified: false,
  };
}
