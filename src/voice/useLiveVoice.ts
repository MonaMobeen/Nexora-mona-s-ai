import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ApprovalRequest,
  MemoryEntry,
  OrbState,
  ToolActivityDetail,
  UserPreferences,
} from '../types/nexora';
import { VoiceAudioEngine } from './audioEngine';

interface UseLiveVoiceOptions {
  guestId: string;
  getAuthToken: () => Promise<string | null>;
  sessionId: string;
  preferences: UserPreferences;
  memories: MemoryEntry[];
  onTranscriptTurn: (role: 'user' | 'assistant', text: string, tools?: ToolActivityDetail[]) => void;
  onApprovalRequest: (req: ApprovalRequest) => void;
}

type TransportMode = 'none' | 'ws' | 'http';

export function useLiveVoice(options: UseLiveVoiceOptions) {
  const [orbState, setOrbState] = useState<OrbState>('idle');
  const [connected, setConnected] = useState(false);
  const [muted, setMuted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [liveUserDraft, setLiveUserDraft] = useState('');
  const [liveAssistantDraft, setLiveAssistantDraft] = useState('');
  const [activeModel, setActiveModel] = useState<string>('');

  const wsRef = useRef<WebSocket | null>(null);
  const transportRef = useRef<TransportMode>('none');
  const bridgeIdRef = useRef<string | null>(null);
  const bridgeAbortRef = useRef<AbortController | null>(null);
  const httpQueueRef = useRef<Array<{ type: 'audio' | 'text' | 'stop'; data?: string; text?: string }>>([]);
  const httpFlushTimerRef = useRef<number | null>(null);
  const httpFlushingRef = useRef(false);
  const wsPingTimerRef = useRef<number | null>(null);
  const connectingRef = useRef(false);
  const readyRef = useRef(false);
  const intentionalCloseRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);

  const audioEngineRef = useRef<VoiceAudioEngine>(new VoiceAudioEngine());
  const userDraftRef = useRef('');
  const assistantDraftRef = useRef('');
  const pendingToolsRef = useRef<ToolActivityDetail[]>([]);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const flushUserDraft = useCallback(() => {
    const text = userDraftRef.current.trim();
    if (text) {
      optionsRef.current.onTranscriptTurn('user', text);
      userDraftRef.current = '';
      setLiveUserDraft('');
    }
  }, []);

  const flushAssistantDraft = useCallback(() => {
    const text = assistantDraftRef.current.trim();
    if (text) {
      const tools = pendingToolsRef.current.length > 0 ? [...pendingToolsRef.current] : undefined;
      optionsRef.current.onTranscriptTurn('assistant', text, tools);
      assistantDraftRef.current = '';
      pendingToolsRef.current = [];
      setLiveAssistantDraft('');
    }
  }, []);

  const clearTimers = useCallback(() => {
    if (wsPingTimerRef.current !== null) {
      window.clearInterval(wsPingTimerRef.current);
      wsPingTimerRef.current = null;
    }
    if (httpFlushTimerRef.current !== null) {
      window.clearInterval(httpFlushTimerRef.current);
      httpFlushTimerRef.current = null;
    }
  }, []);

  const teardownTransports = useCallback(
    (notifyServer: boolean) => {
      clearTimers();
      readyRef.current = false;

      if (wsRef.current) {
        const ws = wsRef.current;
        wsRef.current = null;
        try {
          if (notifyServer && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'stop' }));
          }
          ws.onopen = null;
          ws.onmessage = null;
          ws.onerror = null;
          ws.onclose = null;
          ws.close(1000, 'Session closed');
        } catch {
          // ignore close errors
        }
      }

      if (bridgeAbortRef.current) {
        bridgeAbortRef.current.abort();
        bridgeAbortRef.current = null;
      }

      const activeBridgeId = bridgeIdRef.current;
      bridgeIdRef.current = null;
      httpQueueRef.current = [];
      httpFlushingRef.current = false;
      transportRef.current = 'none';

      if (notifyServer && activeBridgeId) {
        void (async () => {
          try {
            const token = await optionsRef.current.getAuthToken();
            await fetch(`/api/live/input/${encodeURIComponent(activeBridgeId)}`, {
              method: 'POST',
              credentials: 'same-origin',
              headers: {
                'Content-Type': 'application/json',
                'x-nexora-guest-id': optionsRef.current.guestId,
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify({ items: [{ type: 'stop' }] }),
            });
          } catch {
            // ignore teardown failure
          }
        })();
      }
    },
    [clearTimers],
  );

  const stopSession = useCallback(
    async (preserveError = false) => {
      intentionalCloseRef.current = true;
      connectingRef.current = false;
      reconnectAttemptsRef.current = 0;
      flushUserDraft();
      flushAssistantDraft();
      teardownTransports(true);
      await audioEngineRef.current.stop();
      setConnected(false);
      setMuted(false);
      if (!preserveError) {
        setOrbState('idle');
      }
      setActiveModel('');
    },
    [flushAssistantDraft, flushUserDraft, teardownTransports],
  );

  const flushHttpQueue = useCallback(async () => {
    if (httpFlushingRef.current) return;
    const bridgeId = bridgeIdRef.current;
    if (!bridgeId || httpQueueRef.current.length === 0) return;

    httpFlushingRef.current = true;
    try {
      while (httpQueueRef.current.length > 0 && bridgeIdRef.current === bridgeId) {
        const batch = httpQueueRef.current.splice(0, 12);
        const token = await optionsRef.current.getAuthToken();
        const res = await fetch(`/api/live/input/${encodeURIComponent(bridgeId)}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'x-nexora-guest-id': optionsRef.current.guestId,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ items: batch }),
        });
        if (!res.ok) {
          break;
        }
      }
    } catch {
      // ignore transient send failures; stream handler surfaces disconnects
    } finally {
      httpFlushingRef.current = false;
    }
  }, []);

  const handleServerMessage = useCallback(
    (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case 'ping':
        case 'pong':
          break;

        case 'ready':
          readyRef.current = true;
          connectingRef.current = false;
          reconnectAttemptsRef.current = 0;
          setConnected(true);
          setOrbState('listening');
          setActiveModel(String(msg.model ?? 'gemini-3.8-live'));
          break;

        case 'input_transcript': {
          const chunk = String(msg.text ?? '');
          userDraftRef.current += chunk;
          setLiveUserDraft(userDraftRef.current);
          setOrbState('listening');
          break;
        }

        case 'output_transcript': {
          flushUserDraft();
          const chunk = String(msg.text ?? '');
          assistantDraftRef.current += chunk;
          setLiveAssistantDraft(assistantDraftRef.current);
          break;
        }

        case 'audio': {
          flushUserDraft();
          if (typeof msg.data === 'string') {
            audioEngineRef.current.playPcmChunk(msg.data);
            setOrbState('speaking');
          }
          break;
        }

        case 'interrupted':
          audioEngineRef.current.interruptPlayback();
          flushAssistantDraft();
          setOrbState('interrupted');
          setTimeout(() => {
            setOrbState((cur) => (cur === 'interrupted' ? 'listening' : cur));
          }, 320);
          break;

        case 'turn_complete':
          flushUserDraft();
          flushAssistantDraft();
          if (!audioEngineRef.current.isPlayingOutput()) {
            setOrbState('listening');
          }
          break;

        case 'state':
          if (msg.state === 'processing') setOrbState('processing');
          else if (msg.state === 'idle' && !audioEngineRef.current.isPlayingOutput()) {
            setOrbState('listening');
          }
          break;

        case 'tool_start':
          setOrbState('processing');
          break;

        case 'tool_result':
          pendingToolsRef.current.push({
            toolName: String(msg.toolName ?? 'tool'),
            success: Boolean(msg.success),
            latencyMs: Number(msg.latencyMs ?? 0),
            summary: msg.success ? 'Executed via MCP' : 'Failed',
          });
          break;

        case 'approval_request':
          optionsRef.current.onApprovalRequest({
            actionId: String(msg.actionId),
            actionType: 'save_memory',
            title: String(msg.title ?? 'Approve Action'),
            description: String(msg.description ?? ''),
            payload: (msg.payload ?? {}) as Record<string, unknown>,
          });
          break;

        case 'error':
          readyRef.current = false;
          setErrorMessage(String(msg.message ?? 'Live voice connection error.'));
          setOrbState('error');
          void stopSession(true);
          break;

        case 'closed':
          readyRef.current = false;
          void stopSession(false);
          break;
      }
    },
    [flushAssistantDraft, flushUserDraft, stopSession],
  );

  const connectViaHttpBridge = useCallback(
    async (token: string | null) => {
      teardownTransports(false);
      transportRef.current = 'http';

      const startPayload = {
        sessionId: optionsRef.current.sessionId,
        voiceName: optionsRef.current.preferences.preferredVoice,
        speakingStyle: optionsRef.current.preferences.speakingStyle,
        languagePreference: optionsRef.current.preferences.preferredLanguage,
        extendedThinking: optionsRef.current.preferences.extendedThinking,
        memories: optionsRef.current.memories
          .filter((m) => m.approvedByUser)
          .map((m) => ({ id: m.id, fact: m.fact, category: m.category })),
      };

      const startRes = await fetch('/api/live/start', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'x-nexora-guest-id': optionsRef.current.guestId,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(startPayload),
      });

      if (!startRes.ok) {
        const errBody = (await startRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || `Live voice start failed (${startRes.status}).`);
      }

      const { bridgeId, model } = (await startRes.json()) as {
        bridgeId: string;
        model: string;
      };
      bridgeIdRef.current = bridgeId;

      const abort = new AbortController();
      bridgeAbortRef.current = abort;

      const streamRes = await fetch(`/api/live/stream/${encodeURIComponent(bridgeId)}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          'x-nexora-guest-id': optionsRef.current.guestId,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: abort.signal,
      });

      if (!streamRes.ok || !streamRes.body) {
        throw new Error(`Live voice stream failed (${streamRes.status}).`);
      }

      readyRef.current = true;
      connectingRef.current = false;
      setConnected(true);
      setOrbState('listening');
      setActiveModel(model || 'gemini-3.8-live');

      httpFlushTimerRef.current = window.setInterval(() => {
        void flushHttpQueue();
      }, 220);

      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      void (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split('\n\n');
            buffer = blocks.pop() ?? '';

            for (const block of blocks) {
              const line = block
                .split('\n')
                .find((l) => l.startsWith('data: '));
              if (!line) continue;
              const msg = JSON.parse(line.slice(6)) as Record<string, unknown>;
              handleServerMessage(msg);
            }
          }
          if (!intentionalCloseRef.current && bridgeIdRef.current === bridgeId) {
            readyRef.current = false;
            setConnected(false);
            await audioEngineRef.current.stop();
            setOrbState('idle');
          }
        } catch (err) {
          if (intentionalCloseRef.current || (err instanceof Error && err.name === 'AbortError')) {
            return;
          }
          readyRef.current = false;
          setConnected(false);
          await audioEngineRef.current.stop();
          setErrorMessage('Voice stream interrupted. Click Start Conversation to reconnect.');
          setOrbState('error');
        }
      })();
    },
    [flushHttpQueue, handleServerMessage, teardownTransports],
  );

  const connectViaWebSocket = useCallback(
    (token: string | null): Promise<'ready' | 'fallback'> => {
      return new Promise((resolve) => {
        teardownTransports(false);
        transportRef.current = 'ws';

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws/live`);
        wsRef.current = ws;

        let settled = false;
        const handshakeTimeout = window.setTimeout(() => {
          if (!settled) {
            settled = true;
            try {
              ws.close();
            } catch {
              // ignore
            }
            resolve('fallback');
          }
        }, 4500);

        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              type: 'start',
              token,
              guestId: optionsRef.current.guestId,
              sessionId: optionsRef.current.sessionId,
              voiceName: optionsRef.current.preferences.preferredVoice,
              speakingStyle: optionsRef.current.preferences.speakingStyle,
              languagePreference: optionsRef.current.preferences.preferredLanguage,
              extendedThinking: optionsRef.current.preferences.extendedThinking,
              memories: optionsRef.current.memories
                .filter((m) => m.approvedByUser)
                .map((m) => ({ id: m.id, fact: m.fact, category: m.category })),
            }),
          );

          wsPingTimerRef.current = window.setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
            }
          }, 15_000);
        };

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string) as Record<string, unknown>;
          if (msg.type === 'ready' && !settled) {
            settled = true;
            window.clearTimeout(handshakeTimeout);
            resolve('ready');
          }
          if (msg.type === 'error' && !settled) {
            settled = true;
            window.clearTimeout(handshakeTimeout);
            resolve('ready'); // let handleServerMessage display explicit backend error
          }
          handleServerMessage(msg);
        };

        ws.onerror = () => {
          if (!settled) {
            settled = true;
            window.clearTimeout(handshakeTimeout);
            resolve('fallback');
            return;
          }
          if (!intentionalCloseRef.current && wsRef.current === ws) {
            readyRef.current = false;
            if (reconnectAttemptsRef.current < 1) {
              reconnectAttemptsRef.current += 1;
              setOrbState('processing');
              void (async () => {
                const freshToken = await optionsRef.current.getAuthToken();
                try {
                  await connectViaHttpBridge(freshToken);
                } catch {
                  setErrorMessage('Voice connection interrupted. Click Start Conversation to reconnect.');
                  setOrbState('error');
                  await audioEngineRef.current.stop();
                  setConnected(false);
                }
              })();
            } else {
              setErrorMessage('Voice connection interrupted. Click Start Conversation to reconnect.');
              setOrbState('error');
            }
          }
        };

        ws.onclose = (ev) => {
          window.clearTimeout(handshakeTimeout);
          if (!settled) {
            settled = true;
            resolve('fallback');
            return;
          }
          if (wsRef.current !== ws) return;
          clearTimers();
          readyRef.current = false;
          setConnected(false);

          if (!intentionalCloseRef.current && ev.code !== 1000) {
            if (reconnectAttemptsRef.current < 1) {
              reconnectAttemptsRef.current += 1;
              setOrbState('processing');
              void (async () => {
                const freshToken = await optionsRef.current.getAuthToken();
                try {
                  await connectViaHttpBridge(freshToken);
                } catch {
                  await audioEngineRef.current.stop();
                  setErrorMessage((prev) => prev || 'Voice connection closed unexpectedly. Click Start Conversation to reconnect.');
                  setOrbState('error');
                }
              })();
            } else {
              void audioEngineRef.current.stop();
              setErrorMessage((prev) => prev || 'Voice connection closed unexpectedly. Click Start Conversation to reconnect.');
              setOrbState('error');
            }
          } else {
            void audioEngineRef.current.stop();
            setOrbState((prev) => (prev === 'error' ? 'error' : 'idle'));
          }
        };
      });
    },
    [clearTimers, connectViaHttpBridge, handleServerMessage, teardownTransports],
  );

  const startSession = useCallback(async () => {
    if (connected || connectingRef.current) return;
    connectingRef.current = true;
    intentionalCloseRef.current = false;
    readyRef.current = false;
    reconnectAttemptsRef.current = 0;
    setErrorMessage(null);
    setOrbState('processing');

    try {
      const [token] = await Promise.all([
        optionsRef.current.getAuthToken(),
        fetch('/api/health', { credentials: 'same-origin' }).catch(() => null),
      ]);

      await audioEngineRef.current.start(
        (base64Pcm, rms) => {
          if (!readyRef.current) return;

          if (transportRef.current === 'ws') {
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'audio', data: base64Pcm }));
            }
          } else if (transportRef.current === 'http' && bridgeIdRef.current) {
            httpQueueRef.current.push({ type: 'audio', data: base64Pcm });
            if (httpQueueRef.current.length >= 2) {
              void flushHttpQueue();
            }
          }

          if (rms > 0.02 && !audioEngineRef.current.isPlayingOutput()) {
            setOrbState((prev) => (prev === 'processing' ? prev : 'listening'));
          }
        },
        () => {
          setOrbState((prev) => (prev === 'speaking' ? 'listening' : prev));
        },
      );

      if (intentionalCloseRef.current) {
        connectingRef.current = false;
        await audioEngineRef.current.stop();
        return;
      }

      const wsOutcome = await connectViaWebSocket(token);
      if (wsOutcome === 'fallback' && !intentionalCloseRef.current) {
        await connectViaHttpBridge(token);
      }
    } catch (err) {
      connectingRef.current = false;
      readyRef.current = false;
      const message =
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Microphone access was denied. Enable microphone permissions in your browser to use voice.'
          : err instanceof Error
            ? err.message
            : 'Failed to start real-time voice session.';
      setErrorMessage(message);
      setOrbState('error');
      teardownTransports(false);
      await audioEngineRef.current.stop();
    }
  }, [connected, connectViaHttpBridge, connectViaWebSocket, flushHttpQueue, teardownTransports]);

  const toggleMute = useCallback(() => {
    const next = !audioEngineRef.current.isMuted();
    audioEngineRef.current.setMuted(next);
    setMuted(next);
  }, []);

  const interruptAudio = useCallback(() => {
    audioEngineRef.current.interruptPlayback();
    setOrbState('interrupted');
    setTimeout(() => {
      setOrbState((cur) => (cur === 'interrupted' && connected ? 'listening' : cur));
    }, 280);
  }, [connected]);

  const sendLiveText = useCallback(
    (text: string) => {
      if (!readyRef.current) return;
      if (transportRef.current === 'ws' && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'text', text }));
        optionsRef.current.onTranscriptTurn('user', text);
      } else if (transportRef.current === 'http' && bridgeIdRef.current) {
        httpQueueRef.current.push({ type: 'text', text });
        void flushHttpQueue();
        optionsRef.current.onTranscriptTurn('user', text);
      }
    },
    [flushHttpQueue],
  );

  useEffect(() => {
    return () => {
      void stopSession(false);
    };
  }, [stopSession]);

  return {
    orbState,
    connected,
    muted,
    errorMessage,
    liveUserDraft,
    liveAssistantDraft,
    activeModel,
    audioEngine: audioEngineRef.current,
    startSession,
    stopSession: () => stopSession(false),
    toggleMute,
    interruptAudio,
    sendLiveText,
    clearError: () => {
      setErrorMessage(null);
      setOrbState('idle');
    },
  };
}
