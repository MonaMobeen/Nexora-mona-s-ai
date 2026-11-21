import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { Menu } from 'lucide-react';
import { ConversationView } from './components/ConversationView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { KnowledgePanel } from './components/KnowledgePanel';
import { MemoryPanel } from './components/MemoryPanel';
import { ObservabilityPanel } from './components/ObservabilityPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { Sidebar } from './components/Sidebar';
import { ToolsAndAgentsPanel } from './components/ToolsAndAgentsPanel';
import {
  auth,
  deleteDocumentMetaFromFirestore,
  deleteMemoryInFirestore,
  deleteSessionFromFirestore,
  ensureUserProfile,
  fetchMemoriesFromFirestore,
  fetchSessionMessagesFromFirestore,
  fetchSessionsFromFirestore,
  sanitizeDocId,
  saveApprovedMemoryToFirestore,
  saveDocumentMetaToFirestore,
  saveMessageToFirestore,
  signInWithGoogle,
  signOutUser,
  updateMemoryInFirestore,
  updateUserProfilePrefs,
  upsertSessionInFirestore,
  writeAuditLogToFirestore,
} from './lib/firebase';
import type {
  ApprovalRequest,
  ChatMessage,
  ChatSession,
  MemoryEntry,
  RagDocument,
  SourceReference,
  ToolActivityDetail,
  UserPreferences,
  WorkspaceTab,
} from './types/nexora';
import { useLiveVoice } from './voice/useLiveVoice';

function createInitialSession(): ChatSession {
  return {
    id: `sess_${Date.now()}`,
    title: 'New Conversation',
    mode: 'multimodal',
    language: 'auto',
    summary: '',
    messageCount: 0,
    updatedAt: new Date().toISOString(),
  };
}

function getOrCreateGuestId(): string {
  const key = 'nexora_guest_id';
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const created = `g_${Math.random().toString(36).slice(2, 10)}`;
  sessionStorage.setItem(key, created);
  return created;
}

export default function App() {
  const [guestId] = useState<string>(() => getOrCreateGuestId());
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const [activeTab, setActiveTab] = useState<WorkspaceTab>('conversation');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [preferences, setPreferences] = useState<UserPreferences>({
    preferredVoice: 'Zephyr',
    speakingStyle: 'natural',
    preferredLanguage: 'auto',
    extendedThinking: false,
  });

  const [sessions, setSessions] = useState<ChatSession[]>(() => [createInitialSession()]);
  const [activeSessionId, setActiveSessionId] = useState<string>(() => sessions[0]!.id);
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessage[]>>({});
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [documents, setDocuments] = useState<RagDocument[]>([]);

  const [isSendingText, setIsSendingText] = useState(false);
  const [activeTraces, setActiveTraces] = useState<string[]>([]);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? sessions[0]!,
    [sessions, activeSessionId],
  );
  const activeMessages = messagesBySession[activeSession.id] ?? [];

  const getAuthToken = useCallback(async (): Promise<string | null> => {
    if (!auth.currentUser) return null;
    try {
      return await auth.currentUser.getIdToken();
    } catch {
      return null;
    }
  }, []);

  // Load RAG documents from server for current actor
  const refreshServerDocuments = useCallback(async () => {
    try {
      const token = await getAuthToken();
      const res = await fetch('/api/rag/documents', {
        headers: {
          'x-nexora-guest-id': guestId,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (res.ok) {
        const data = (await res.json()) as { documents?: RagDocument[] };
        setDocuments(data.documents ?? []);
      }
    } catch {
      // non-fatal
    }
  }, [getAuthToken, guestId]);

  // Auth State & Firestore Hydration
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      setAuthLoading(false);
      if (nextUser && nextUser.emailVerified) {
        try {
          const [prefs, remoteMemories, remoteSessions] = await Promise.all([
            ensureUserProfile(nextUser.uid, nextUser.displayName || 'Nexora User'),
            fetchMemoriesFromFirestore(nextUser.uid),
            fetchSessionsFromFirestore(nextUser.uid),
          ]);
          setPreferences((prev) => ({ ...prev, ...prefs }));
          setMemories(remoteMemories);
          if (remoteSessions.length > 0) {
            setSessions(remoteSessions);
            setActiveSessionId(remoteSessions[0]!.id);
            const firstMsgs = await fetchSessionMessagesFromFirestore(
              nextUser.uid,
              remoteSessions[0]!.id,
            );
            setMessagesBySession((prev) => ({
              ...prev,
              [remoteSessions[0]!.id]: firstMsgs,
            }));
          }
        } catch (err) {
          console.error('Firestore hydration warning:', err);
        }
      }
      await refreshServerDocuments();
    });
    return () => unsub();
  }, [refreshServerDocuments]);

  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      setActiveSessionId(sessionId);
      if (user && !messagesBySession[sessionId]) {
        const loaded = await fetchSessionMessagesFromFirestore(user.uid, sessionId);
        setMessagesBySession((prev) => ({ ...prev, [sessionId]: loaded }));
      }
    },
    [messagesBySession, user],
  );

  const persistTurnToFirestore = useCallback(
    async (session: ChatSession, msg: ChatMessage) => {
      if (!user) return;
      await upsertSessionInFirestore(user.uid, session);
      await saveMessageToFirestore(user.uid, session.id, msg);
    },
    [user],
  );

  // Append a voice transcript turn
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  const handleVoiceTranscriptTurn = useCallback(
    (role: 'user' | 'assistant', text: string, tools?: ToolActivityDetail[]) => {
      const sid = activeSessionIdRef.current;
      const newMsg: ChatMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        role,
        content: text,
        modality: 'voice',
        agentRoute: role === 'assistant' ? 'gemini-3.8-live' : undefined,
        tools,
        createdAt: new Date().toISOString(),
      };

      setMessagesBySession((prev) => ({
        ...prev,
        [sid]: [...(prev[sid] ?? []), newMsg],
      }));

      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sid) return s;
          const updated: ChatSession = {
            ...s,
            title: s.title === 'New Conversation' && role === 'user' ? text.slice(0, 60) : s.title,
            messageCount: s.messageCount + 1,
            updatedAt: new Date().toISOString(),
          };
          void persistTurnToFirestore(updated, newMsg);
          return updated;
        }),
      );
    },
    [persistTurnToFirestore],
  );

  const liveVoice = useLiveVoice({
    guestId,
    getAuthToken,
    sessionId: activeSession.id,
    preferences,
    memories,
    onTranscriptTurn: handleVoiceTranscriptTurn,
    onApprovalRequest: (req) => setPendingApproval(req),
  });

  // Handle text chat submission (or send into active Live session)
  const handleSendText = useCallback(
    async (text: string) => {
      if (liveVoice.connected) {
        liveVoice.sendLiveText(text);
        return;
      }

      const sid = activeSession.id;
      const userMsg: ChatMessage = {
        id: `msg_${Date.now()}_u`,
        role: 'user',
        content: text,
        modality: 'text',
        createdAt: new Date().toISOString(),
      };

      const assistantMsgId = `msg_${Date.now()}_a`;
      const assistantPlaceholder: ChatMessage = {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        modality: 'text',
        streaming: true,
        createdAt: new Date().toISOString(),
      };

      const priorHistory = (messagesBySession[sid] ?? []).map((m) => ({
        role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.content,
      }));

      setMessagesBySession((prev) => ({
        ...prev,
        [sid]: [...(prev[sid] ?? []), userMsg, assistantPlaceholder],
      }));

      const updatedSessionUser: ChatSession = {
        ...activeSession,
        title: activeSession.title === 'New Conversation' ? text.slice(0, 60) : activeSession.title,
        messageCount: activeSession.messageCount + 1,
        updatedAt: new Date().toISOString(),
      };
      setSessions((prev) => prev.map((s) => (s.id === sid ? updatedSessionUser : s)));
      void persistTurnToFirestore(updatedSessionUser, userMsg);

      setIsSendingText(true);
      setActiveTraces([]);

      let accumulatedText = '';
      let finalRoute = 'nexora-orchestrator';
      let finalLatency = 0;
      const collectedTools: ToolActivityDetail[] = [];
      let collectedSources: SourceReference[] = [];

      try {
        const token = await getAuthToken();
        const res = await fetch('/api/agent/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-nexora-guest-id': guestId,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            sessionId: sid,
            message: text,
            history: priorHistory,
            memories: memories
              .filter((m) => m.approvedByUser)
              .map((m) => ({ id: m.id, fact: m.fact, category: m.category })),
            languagePreference: preferences.preferredLanguage,
            speakingStyle: preferences.speakingStyle,
            existingSummary: activeSession.summary,
          }),
        });

        if (!res.ok || !res.body) {
          const errPayload = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(errPayload.error || `Request failed with status ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const evt = JSON.parse(line.slice(6)) as Record<string, unknown>;

            if (evt.type === 'trace') {
              setActiveTraces((prev) => [...prev.slice(-4), `${evt.step}: ${evt.detail}`]);
            } else if (evt.type === 'tool_start') {
              setActiveTraces((prev) => [...prev.slice(-4), `Running MCP tool ${evt.toolName}...`]);
            } else if (evt.type === 'tool_result') {
              collectedTools.push({
                toolName: String(evt.toolName),
                success: Boolean(evt.success),
                latencyMs: Number(evt.latencyMs ?? 0),
                summary: String(evt.summary ?? ''),
              });
            } else if (evt.type === 'a2a_event') {
              setActiveTraces((prev) => [
                ...prev.slice(-4),
                `A2A ${evt.agentId} -> ${evt.status}`,
              ]);
            } else if (evt.type === 'approval_request') {
              setPendingApproval({
                actionId: String(evt.actionId),
                actionType: evt.actionType as ApprovalRequest['actionType'],
                title: String(evt.title),
                description: String(evt.description),
                payload: (evt.payload ?? {}) as Record<string, unknown>,
              });
            } else if (evt.type === 'sources') {
              collectedSources = (evt.sources as SourceReference[]) ?? [];
            } else if (evt.type === 'delta') {
              accumulatedText += String(evt.text ?? '');
              setMessagesBySession((prev) => ({
                ...prev,
                [sid]: (prev[sid] ?? []).map((m) =>
                  m.id === assistantMsgId ? { ...m, content: accumulatedText } : m,
                ),
              }));
            } else if (evt.type === 'done') {
              finalLatency = Number(evt.latencyMs ?? 0);
              finalRoute = String(evt.agentRoute ?? 'nexora-orchestrator');
              if (typeof evt.compressedSummary === 'string' && evt.compressedSummary) {
                setSessions((prev) =>
                  prev.map((s) =>
                    s.id === sid ? { ...s, summary: evt.compressedSummary as string } : s,
                  ),
                );
              }
            } else if (evt.type === 'error') {
              throw new Error(String(evt.message ?? 'Agent error'));
            }
          }
        }

        const finalizedAssistant: ChatMessage = {
          id: assistantMsgId,
          role: 'assistant',
          content: accumulatedText || 'Completed without text output.',
          modality: 'text',
          agentRoute: finalRoute,
          latencyMs: finalLatency,
          tools: collectedTools.length > 0 ? collectedTools : undefined,
          sources: collectedSources.length > 0 ? collectedSources : undefined,
          streaming: false,
          createdAt: new Date().toISOString(),
        };

        setMessagesBySession((prev) => ({
          ...prev,
          [sid]: (prev[sid] ?? []).map((m) => (m.id === assistantMsgId ? finalizedAssistant : m)),
        }));

        const updatedSessionAssistant: ChatSession = {
          ...updatedSessionUser,
          messageCount: updatedSessionUser.messageCount + 1,
          updatedAt: new Date().toISOString(),
        };
        setSessions((prev) => prev.map((s) => (s.id === sid ? updatedSessionAssistant : s)));
        void persistTurnToFirestore(updatedSessionAssistant, finalizedAssistant);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to generate response.';
        setMessagesBySession((prev) => ({
          ...prev,
          [sid]: (prev[sid] ?? []).map((m) =>
            m.id === assistantMsgId ? { ...m, content: `Error: ${message}`, streaming: false } : m,
          ),
        }));
      } finally {
        setIsSendingText(false);
        setActiveTraces([]);
      }
    },
    [
      activeSession,
      getAuthToken,
      guestId,
      liveVoice,
      memories,
      messagesBySession,
      persistTurnToFirestore,
      preferences.preferredLanguage,
      preferences.speakingStyle,
    ],
  );

  // Memory Actions (explicit consent)
  const handleAddMemory = useCallback(
    async (fact: string, category: MemoryEntry['category'], source: MemoryEntry['source'] = 'manual') => {
      const id = sanitizeDocId(`mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
      const entry: MemoryEntry = {
        id,
        fact,
        category,
        source,
        approvedByUser: true,
        updatedAt: new Date().toISOString(),
      };
      setMemories((prev) => [entry, ...prev]);
      if (user) {
        await saveApprovedMemoryToFirestore(user.uid, entry);
        await writeAuditLogToFirestore(user.uid, {
          eventType: 'memory_consent',
          action: 'approved_memory_create',
          status: 'success',
        });
      }
    },
    [user],
  );

  const handleUpdateMemory = useCallback(
    async (id: string, fact: string, category: MemoryEntry['category']) => {
      setMemories((prev) =>
        prev.map((m) =>
          m.id === id ? { ...m, fact, category, updatedAt: new Date().toISOString() } : m,
        ),
      );
      if (user) {
        await updateMemoryInFirestore(user.uid, id, fact, category);
      }
    },
    [user],
  );

  const handleDeleteMemory = useCallback(
    async (id: string) => {
      setMemories((prev) => prev.filter((m) => m.id !== id));
      if (user) {
        await deleteMemoryInFirestore(user.uid, id);
        await writeAuditLogToFirestore(user.uid, {
          eventType: 'memory_consent',
          action: 'memory_delete',
          status: 'success',
        });
      }
    },
    [user],
  );

  const handleResolveApproval = useCallback(
    async (approved: boolean) => {
      const current = pendingApproval;
      setPendingApproval(null);
      if (!current) return;

      if (approved && current.actionType === 'save_memory') {
        const fact = String(current.payload.fact ?? '');
        const category = (current.payload.category as MemoryEntry['category']) ?? 'fact';
        const source = (current.payload.source as MemoryEntry['source']) ?? 'text';
        if (fact) {
          await handleAddMemory(fact, category, source);
        }
      } else if (!approved && user) {
        await writeAuditLogToFirestore(user.uid, {
          eventType: 'memory_consent',
          action: 'declined_sensitive_action',
          status: 'denied',
        });
      }
    },
    [handleAddMemory, pendingApproval, user],
  );

  const handleUpdatePreferences = useCallback(
    (patch: Partial<UserPreferences>) => {
      setPreferences((prev) => {
        const next = { ...prev, ...patch };
        if (user) {
          void updateUserProfilePrefs(user.uid, {
            preferredVoice: next.preferredVoice,
            speakingStyle: next.speakingStyle,
            preferredLanguage: next.preferredLanguage,
          });
        }
        return next;
      });
    },
    [user],
  );

  const handleNewSession = useCallback(() => {
    const fresh = createInitialSession();
    setSessions((prev) => [fresh, ...prev]);
    setActiveSessionId(fresh.id);
    setMessagesBySession((prev) => ({ ...prev, [fresh.id]: [] }));
  }, []);

  const handleDeleteSession = useCallback(
    async (sid: string) => {
      setSessions((prev) => {
        const remaining = prev.filter((s) => s.id !== sid);
        if (sid === activeSessionId && remaining.length > 0) {
          setActiveSessionId(remaining[0]!.id);
        }
        return remaining;
      });
      if (user) {
        await deleteSessionFromFirestore(user.uid, sid);
      }
    },
    [activeSessionId, user],
  );

  const handleUploadComplete = useCallback(
    async (docMeta: RagDocument) => {
      setDocuments((prev) => [docMeta, ...prev.filter((d) => d.id !== docMeta.id)]);
      if (user) {
        await saveDocumentMetaToFirestore(user.uid, docMeta);
        await writeAuditLogToFirestore(user.uid, {
          eventType: 'rag_ingest',
          action: `indexed_${docMeta.chunkCount}_chunks`,
          status: 'success',
        });
      }
    },
    [user],
  );

  const handleDeleteDocument = useCallback(
    async (docId: string) => {
      const token = await getAuthToken();
      await fetch(`/api/rag/documents/${encodeURIComponent(docId)}`, {
        method: 'DELETE',
        headers: {
          'x-nexora-guest-id': guestId,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      setDocuments((prev) => prev.filter((d) => d.id !== docId));
      if (user) {
        await deleteDocumentMetaFromFirestore(user.uid, docId).catch(() => {});
      }
    },
    [getAuthToken, guestId, user],
  );

  return (
    <ErrorBoundary>
      <div className="h-screen w-screen overflow-hidden bg-[#090B10] text-slate-100 flex">
        <Sidebar
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          sessions={sessions}
          activeSessionId={activeSession.id}
          onSelectSession={(sid) => void handleSelectSession(sid)}
          onNewSession={handleNewSession}
          onDeleteSession={(sid) => void handleDeleteSession(sid)}
          user={user}
          authLoading={authLoading}
          onSignIn={() => void signInWithGoogle()}
          onSignOut={() => void signOutUser()}
          mobileOpen={mobileMenuOpen}
          onCloseMobile={() => setMobileMenuOpen(false)}
        />

        <div className="flex-1 flex flex-col min-w-0 h-full">
          {/* Top Bar */}
          <header className="h-16 px-4 sm:px-6 border-b border-white/8 bg-[#090B10] flex items-center justify-between gap-8 shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(true)}
                aria-label="Open navigation"
                className="lg:hidden p-2 -ml-1 text-slate-300 hover:text-white rounded-lg"
              >
                <Menu className="w-5 h-5" />
              </button>
              <span className="text-sm font-medium text-slate-200 truncate">
                {activeTab === 'conversation'
                  ? activeSession.title
                  : activeTab === 'memory'
                    ? 'Memory Governance'
                    : activeTab === 'tools'
                      ? 'MCP & A2A Ecosystem'
                      : activeTab === 'knowledge'
                        ? 'RAG Document Intelligence'
                        : activeTab === 'observability'
                          ? 'Developer Observability'
                          : 'Settings'}
              </span>
            </div>

            <div className="flex items-center gap-4 text-xs text-slate-400 font-mono tabular-nums shrink-0">
              <span>{memories.length} memories</span>
              <span aria-hidden="true">·</span>
              <span>{documents.length} docs</span>
            </div>
          </header>

          {/* Main Workspace Viewport */}
          <main className="flex-1 min-h-0">
            {activeTab === 'conversation' && (
              <ConversationView
                messages={activeMessages}
                isSendingText={isSendingText}
                activeTraces={activeTraces}
                orbState={liveVoice.orbState}
                voiceConnected={liveVoice.connected}
                voiceMuted={liveVoice.muted}
                voiceError={liveVoice.errorMessage}
                liveUserDraft={liveVoice.liveUserDraft}
                liveAssistantDraft={liveVoice.liveAssistantDraft}
                activeLiveModel={liveVoice.activeModel}
                audioEngine={liveVoice.audioEngine}
                preferences={preferences}
                pendingApproval={pendingApproval}
                onStartVoice={() => void liveVoice.startSession()}
                onStopVoice={() => void liveVoice.stopSession()}
                onToggleMute={liveVoice.toggleMute}
                onInterruptAudio={liveVoice.interruptAudio}
                onClearVoiceError={liveVoice.clearError}
                onSendText={(t) => void handleSendText(t)}
                onClearConversation={() =>
                  setMessagesBySession((prev) => ({ ...prev, [activeSession.id]: [] }))
                }
                onResolveApproval={(ok) => void handleResolveApproval(ok)}
                onUpdatePreferences={handleUpdatePreferences}
              />
            )}

            {activeTab === 'memory' && (
              <MemoryPanel
                memories={memories}
                isSignedIn={Boolean(user)}
                onAddMemory={(f, c) => handleAddMemory(f, c, 'manual')}
                onUpdateMemory={handleUpdateMemory}
                onDeleteMemory={handleDeleteMemory}
              />
            )}

            {activeTab === 'tools' && (
              <ToolsAndAgentsPanel guestId={guestId} getAuthToken={getAuthToken} />
            )}

            {activeTab === 'knowledge' && (
              <KnowledgePanel
                documents={documents}
                guestId={guestId}
                getAuthToken={getAuthToken}
                onUploadComplete={handleUploadComplete}
                onDeleteDocument={handleDeleteDocument}
              />
            )}

            {activeTab === 'observability' && <ObservabilityPanel />}

            {activeTab === 'settings' && (
              <SettingsPanel
                preferences={preferences}
                isSignedIn={Boolean(user)}
                onUpdatePreferences={handleUpdatePreferences}
              />
            )}
          </main>
        </div>
      </div>
    </ErrorBoundary>
  );
}
