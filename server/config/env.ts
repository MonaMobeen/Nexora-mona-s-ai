import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

export interface FirebasePublicConfig {
  projectId: string;
  firestoreDatabaseId?: string;
}

function loadFirebaseConfig(): FirebasePublicConfig {
  try {
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return {
        projectId: String(raw.projectId ?? ''),
        firestoreDatabaseId: raw.firestoreDatabaseId ? String(raw.firestoreDatabaseId) : undefined,
      };
    }
  } catch {
    // Config absent or malformed; handled gracefully
  }
  return { projectId: '' };
}

export const ENV = {
  PORT: Number(process.env.PORT ?? 3000),
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? '',
  APP_URL: process.env.APP_URL ?? '',
  RATE_LIMIT_MAX_RPM: Number(process.env.RATE_LIMIT_MAX_RPM ?? 90),
  FIREBASE: loadFirebaseConfig(),
} as const;

export const MODELS = {
  ORCHESTRATOR: 'gemini-4-hydrogen',
  LIVE_FAST: 'gemini-3.8-live',
  LIVE_THINKING: 'gemini-3.8-live-extended-thinking',
  EMBEDDING: 'gemini-embedding-2',
} as const;

export function hasGeminiApiKey(): boolean {
  return Boolean(ENV.GEMINI_API_KEY && ENV.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY');
}

export function createGenAIClient(): GoogleGenAI {
  if (!hasGeminiApiKey()) {
    throw new Error('GEMINI_API_KEY is not configured in server environment secrets.');
  }
  return new GoogleGenAI({
    apiKey: ENV.GEMINI_API_KEY,
    apiVersion: 'v1beta',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}
