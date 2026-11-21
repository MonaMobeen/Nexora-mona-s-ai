import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import type {
  ChatMessage,
  ChatSession,
  LanguagePreference,
  MemoryEntry,
  RagDocument,
  SpeakingStyle,
  UserPreferences,
  VoiceName,
} from '../types/nexora';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

export const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
} as const;
export type OperationTypeValue = (typeof OperationType)[keyof typeof OperationType];

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationTypeValue;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: Array<{
      providerId?: string | null;
      email?: string | null;
    }>;
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationTypeValue,
  path: string | null,
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Mandatory startup connectivity check
async function testConnection(): Promise<void> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

export function sanitizeDocId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  return cleaned || `id_${Date.now()}`;
}

function toIsoString(val: unknown): string {
  if (val instanceof Timestamp) return val.toDate().toISOString();
  if (typeof val === 'string') return val;
  return new Date().toISOString();
}

export async function signInWithGoogle(): Promise<User> {
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

export async function signOutUser(): Promise<void> {
  await signOut(auth);
}

export async function ensureUserProfile(
  uid: string,
  displayName: string,
): Promise<UserPreferences> {
  const safeUid = sanitizeDocId(uid);
  const path = `users/${safeUid}`;
  const ref = doc(db, 'users', safeUid);
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const data = snap.data();
      return {
        preferredVoice: (data.preferredVoice as VoiceName) ?? 'Zephyr',
        speakingStyle: (data.speakingStyle as SpeakingStyle) ?? 'natural',
        preferredLanguage: (data.preferredLanguage as LanguagePreference) ?? 'auto',
        extendedThinking: false,
      };
    }

    const defaults: UserPreferences = {
      preferredVoice: 'Zephyr',
      speakingStyle: 'natural',
      preferredLanguage: 'auto',
      extendedThinking: false,
    };

    await setDoc(ref, {
      uid: safeUid,
      displayName: (displayName || 'Nexora User').slice(0, 120),
      preferredVoice: defaults.preferredVoice,
      speakingStyle: defaults.speakingStyle,
      preferredLanguage: defaults.preferredLanguage,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return defaults;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function updateUserProfilePrefs(
  uid: string,
  prefs: Pick<UserPreferences, 'preferredVoice' | 'speakingStyle' | 'preferredLanguage'>,
): Promise<void> {
  const safeUid = sanitizeDocId(uid);
  const path = `users/${safeUid}`;
  try {
    await updateDoc(doc(db, 'users', safeUid), {
      preferredVoice: prefs.preferredVoice,
      speakingStyle: prefs.speakingStyle,
      preferredLanguage: prefs.preferredLanguage,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

// --- User-Approved Memories ---
export async function fetchMemoriesFromFirestore(uid: string): Promise<MemoryEntry[]> {
  const safeUid = sanitizeDocId(uid);
  const path = `users/${safeUid}/memories`;
  try {
    const q = query(collection(db, path), orderBy('updatedAt', 'desc'));
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        fact: String(data.fact ?? ''),
        category: (data.category as MemoryEntry['category']) ?? 'fact',
        source: (data.source as MemoryEntry['source']) ?? 'manual',
        approvedByUser: Boolean(data.approvedByUser),
        updatedAt: toIsoString(data.updatedAt),
      };
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function saveApprovedMemoryToFirestore(
  uid: string,
  memory: Omit<MemoryEntry, 'updatedAt'>,
): Promise<void> {
  const safeUid = sanitizeDocId(uid);
  const safeId = sanitizeDocId(memory.id);
  const path = `users/${safeUid}/memories/${safeId}`;
  try {
    await setDoc(doc(db, 'users', safeUid, 'memories', safeId), {
      userId: safeUid,
      fact: memory.fact.trim().slice(0, 1000),
      category: memory.category,
      source: memory.source,
      approvedByUser: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateMemoryInFirestore(
  uid: string,
  memoryId: string,
  fact: string,
  category: MemoryEntry['category'],
): Promise<void> {
  const safeUid = sanitizeDocId(uid);
  const safeId = sanitizeDocId(memoryId);
  const path = `users/${safeUid}/memories/${safeId}`;
  try {
    await updateDoc(doc(db, 'users', safeUid, 'memories', safeId), {
      fact: fact.trim().slice(0, 1000),
      category,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteMemoryInFirestore(uid: string, memoryId: string): Promise<void> {
  const safeUid = sanitizeDocId(uid);
  const safeId = sanitizeDocId(memoryId);
  const path = `users/${safeUid}/memories/${safeId}`;
  try {
    await deleteDoc(doc(db, 'users', safeUid, 'memories', safeId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

// --- Sessions & Messages ---
export async function fetchSessionsFromFirestore(uid: string): Promise<ChatSession[]> {
  const safeUid = sanitizeDocId(uid);
  const path = `users/${safeUid}/sessions`;
  try {
    const q = query(collection(db, path), orderBy('updatedAt', 'desc'));
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        title: String(data.title ?? 'Conversation'),
        mode: (data.mode as ChatSession['mode']) ?? 'multimodal',
        language: (data.language as LanguagePreference) ?? 'auto',
        summary: String(data.summary ?? ''),
        messageCount: Number(data.messageCount ?? 0),
        updatedAt: toIsoString(data.updatedAt),
      };
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function upsertSessionInFirestore(uid: string, session: ChatSession): Promise<void> {
  const safeUid = sanitizeDocId(uid);
  const safeSid = sanitizeDocId(session.id);
  const path = `users/${safeUid}/sessions/${safeSid}`;
  const ref = doc(db, 'users', safeUid, 'sessions', safeSid);
  try {
    const existing = await getDoc(ref);
    if (!existing.exists()) {
      await setDoc(ref, {
        userId: safeUid,
        title: session.title.trim().slice(0, 160) || 'New Conversation',
        mode: session.mode,
        language: session.language,
        summary: session.summary.slice(0, 2000),
        messageCount: Math.min(5000, Math.max(0, Math.trunc(session.messageCount))),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        title: session.title.trim().slice(0, 160) || 'New Conversation',
        mode: session.mode,
        language: session.language,
        summary: session.summary.slice(0, 2000),
        messageCount: Math.min(5000, Math.max(0, Math.trunc(session.messageCount))),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function fetchSessionMessagesFromFirestore(
  uid: string,
  sessionId: string,
): Promise<ChatMessage[]> {
  const safeUid = sanitizeDocId(uid);
  const safeSid = sanitizeDocId(sessionId);
  const path = `users/${safeUid}/sessions/${safeSid}/messages`;
  try {
    const q = query(collection(db, path), orderBy('createdAt', 'asc'));
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        role: (data.role as ChatMessage['role']) ?? 'assistant',
        content: String(data.content ?? ''),
        modality: (data.modality as ChatMessage['modality']) ?? 'text',
        agentRoute: data.agentRoute ? String(data.agentRoute) : undefined,
        latencyMs: typeof data.latencyMs === 'number' ? data.latencyMs : undefined,
        createdAt: toIsoString(data.createdAt),
      };
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function saveMessageToFirestore(
  uid: string,
  sessionId: string,
  msg: ChatMessage,
): Promise<void> {
  const safeUid = sanitizeDocId(uid);
  const safeSid = sanitizeDocId(sessionId);
  const safeMid = sanitizeDocId(msg.id);
  const path = `users/${safeUid}/sessions/${safeSid}/messages/${safeMid}`;
  try {
    const payload: Record<string, unknown> = {
      userId: safeUid,
      sessionId: safeSid,
      role: msg.role,
      content: msg.content.slice(0, 12000) || ' ',
      modality: msg.modality,
      createdAt: serverTimestamp(),
    };
    if (msg.agentRoute) payload.agentRoute = msg.agentRoute.slice(0, 64);
    if (typeof msg.latencyMs === 'number') {
      payload.latencyMs = Math.min(600000, Math.max(0, Math.trunc(msg.latencyMs)));
    }
    await setDoc(doc(db, 'users', safeUid, 'sessions', safeSid, 'messages', safeMid), payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function deleteSessionFromFirestore(uid: string, sessionId: string): Promise<void> {
  const safeUid = sanitizeDocId(uid);
  const safeSid = sanitizeDocId(sessionId);
  const path = `users/${safeUid}/sessions/${safeSid}`;
  try {
    await deleteDoc(doc(db, 'users', safeUid, 'sessions', safeSid));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

// --- Knowledge Documents Metadata ---
export async function saveDocumentMetaToFirestore(uid: string, docMeta: RagDocument): Promise<void> {
  const safeUid = sanitizeDocId(uid);
  const safeDid = sanitizeDocId(docMeta.id);
  const path = `users/${safeUid}/documents/${safeDid}`;
  try {
    await setDoc(doc(db, 'users', safeUid, 'documents', safeDid), {
      userId: safeUid,
      filename: docMeta.filename.slice(0, 240),
      mimeType: docMeta.mimeType.slice(0, 120),
      sizeBytes: Math.min(20971520, Math.max(0, Math.trunc(docMeta.sizeBytes))),
      chunkCount: Math.min(5000, Math.max(0, Math.trunc(docMeta.chunkCount))),
      status: docMeta.status,
      summary: docMeta.summary.slice(0, 2000),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function deleteDocumentMetaFromFirestore(uid: string, docId: string): Promise<void> {
  const safeUid = sanitizeDocId(uid);
  const safeDid = sanitizeDocId(docId);
  const path = `users/${safeUid}/documents/${safeDid}`;
  try {
    await deleteDoc(doc(db, 'users', safeUid, 'documents', safeDid));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function writeAuditLogToFirestore(
  uid: string,
  entry: {
    eventType: 'tool_call' | 'memory_consent' | 'rag_ingest' | 'a2a_dispatch' | 'security_guard' | 'voice_session';
    action: string;
    status: 'success' | 'denied' | 'error';
    latencyMs?: number;
  },
): Promise<void> {
  const safeUid = sanitizeDocId(uid);
  const logId = sanitizeDocId(`log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  const path = `users/${safeUid}/auditLogs/${logId}`;
  try {
    const payload: Record<string, unknown> = {
      userId: safeUid,
      eventType: entry.eventType,
      action: entry.action.slice(0, 120),
      status: entry.status,
      createdAt: serverTimestamp(),
    };
    if (typeof entry.latencyMs === 'number') {
      payload.latencyMs = Math.min(600000, Math.max(0, Math.trunc(entry.latencyMs)));
    }
    await setDoc(doc(db, 'users', safeUid, 'auditLogs', logId), payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}
