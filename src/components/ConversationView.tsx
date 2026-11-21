import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Eraser,
  ExternalLink,
  Hand,
  Mic,
  MicOff,
  PhoneOff,
  Send,
  ShieldAlert,
  VolumeX,
} from 'lucide-react';
import type {
  ApprovalRequest,
  ChatMessage,
  OrbState,
  UserPreferences,
} from '../types/nexora';
import type { VoiceAudioEngine } from '../voice/audioEngine';
import { VoiceOrb } from './VoiceOrb';

interface ConversationViewProps {
  messages: ChatMessage[];
  isSendingText: boolean;
  activeTraces: string[];
  orbState: OrbState;
  voiceConnected: boolean;
  voiceMuted: boolean;
  voiceError: string | null;
  liveUserDraft: string;
  liveAssistantDraft: string;
  activeLiveModel: string;
  audioEngine: VoiceAudioEngine;
  preferences: UserPreferences;
  pendingApproval: ApprovalRequest | null;
  onStartVoice: () => void;
  onStopVoice: () => void;
  onToggleMute: () => void;
  onInterruptAudio: () => void;
  onClearVoiceError: () => void;
  onSendText: (text: string) => void;
  onClearConversation: () => void;
  onResolveApproval: (approved: boolean) => void;
  onUpdatePreferences: (patch: Partial<UserPreferences>) => void;
}

const EXAMPLE_PROMPTS = [
  {
    label: 'Multilingual Reasoning',
    prompt: 'Explain how Gemini Live barge-in works, aur Roman Urdu mein short summary bhi dein.',
  },
  {
    label: 'Grounded Web Search',
    prompt: 'Search the web for the latest Cloud Run WebSocket timeout limits and calculate 60 * 60 seconds.',
  },
  {
    label: 'Knowledge Base RAG',
    prompt: 'Search my uploaded documents and summarize the key architecture decisions with sources.',
  },
  {
    label: 'Urdu Conversational',
    prompt: 'آج کی تاریخ اور وقت بتائیں، اور بتائیں کہ آپ کون سے ٹولز استعمال کر سکتے ہیں۔',
  },
];

export function ConversationView({
  messages,
  isSendingText,
  activeTraces,
  orbState,
  voiceConnected,
  voiceMuted,
  voiceError,
  liveUserDraft,
  liveAssistantDraft,
  activeLiveModel,
  audioEngine,
  preferences,
  pendingApproval,
  onStartVoice,
  onStopVoice,
  onToggleMute,
  onInterruptAudio,
  onClearVoiceError,
  onSendText,
  onClearConversation,
  onResolveApproval,
  onUpdatePreferences,
}: ConversationViewProps) {
  const [inputText, setInputText] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedDetails, setExpandedDetails] = useState<Record<string, boolean>>({});
  const scrollEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, liveUserDraft, liveAssistantDraft, activeTraces.length]);

  const handleCopy = async (id: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputText.trim();
    if (!trimmed || isSendingText) return;
    onSendText(trimmed);
    setInputText('');
  };

  const compactOrb = messages.length > 0 && !voiceConnected;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Voice Stage Header */}
      <section
        aria-label="Real-time voice interface"
        className={`border-b border-white/8 bg-[#0C0F16] px-6 transition-all ${
          compactOrb ? 'py-4' : 'py-7'
        }`}
      >
        <div className="max-w-4xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex flex-col md:flex-row items-center gap-6">
            <VoiceOrb
              state={orbState}
              audioEngine={audioEngine}
              compact={compactOrb}
              onPrimaryClick={voiceConnected ? onStopVoice : onStartVoice}
            />

            <div className="text-center md:text-left space-y-2 max-w-md">
              <h1 className="font-display text-xl md:text-2xl font-semibold tracking-tight text-slate-100">
                {voiceConnected ? "Mona's AI — Live Voice Active" : "Mona's AI"}
              </h1>
              <p className="text-sm text-slate-400 leading-relaxed">
                {voiceConnected
                  ? `Connected to ${activeLiveModel || 'gemini-3.8-live'} · Voice ${preferences.preferredVoice} · Speak naturally in English, Urdu, or Roman Urdu.`
                  : 'Start a low-latency Gemini Live voice session with barge-in interruption, or type below to invoke MCP tools, RAG, and A2A agents.'}
              </p>

              {/* Voice Control Bar */}
              <div className="flex flex-wrap items-center justify-center md:justify-start gap-2.5 pt-1">
                {!voiceConnected ? (
                  <button
                    type="button"
                    onClick={onStartVoice}
                    className="min-h-[40px] inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-[#3B82F6] hover:bg-[#2563EB] text-white rounded-lg transition-colors whitespace-nowrap"
                  >
                    <Mic className="w-4 h-4" />
                    Start Conversation
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={onStopVoice}
                      className="min-h-[40px] inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-rose-600 hover:bg-rose-500 text-white rounded-lg transition-colors whitespace-nowrap"
                    >
                      <PhoneOff className="w-4 h-4" />
                      End Voice
                    </button>
                    <button
                      type="button"
                      onClick={onToggleMute}
                      className={`min-h-[40px] inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium border rounded-lg transition-colors whitespace-nowrap ${
                        voiceMuted
                          ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                          : 'bg-white/5 border-white/10 text-slate-200 hover:bg-white/10'
                      }`}
                    >
                      {voiceMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                      {voiceMuted ? 'Unmute' : 'Mute Mic'}
                    </button>
                    <button
                      type="button"
                      onClick={onInterruptAudio}
                      className="min-h-[40px] inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium bg-white/5 hover:bg-white/10 text-slate-200 border border-white/10 rounded-lg transition-colors whitespace-nowrap"
                    >
                      <VolumeX className="w-4 h-4" />
                      Interrupt
                    </button>
                  </>
                )}

                <select
                  aria-label="Select voice persona"
                  value={preferences.preferredVoice}
                  disabled={voiceConnected}
                  onChange={(e) =>
                    onUpdatePreferences({ preferredVoice: e.target.value as UserPreferences['preferredVoice'] })
                  }
                  className="min-h-[40px] px-3 py-2 text-xs font-medium bg-[#141822] text-slate-200 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#3B82F6] disabled:opacity-50"
                >
                  <option value="Zephyr">Voice: Zephyr</option>
                  <option value="Puck">Voice: Puck</option>
                  <option value="Charon">Voice: Charon</option>
                  <option value="Kore">Voice: Kore</option>
                  <option value="Fenrir">Voice: Fenrir</option>
                </select>
              </div>
            </div>
          </div>

          {/* Clear Action */}
          {messages.length > 0 && (
            <button
              type="button"
              onClick={onClearConversation}
              className="min-h-[40px] inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-300 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Eraser className="w-3.5 h-3.5" />
              Clear Conversation
            </button>
          )}
        </div>

        {/* Voice Error Alert */}
        {voiceError && (
          <div className="max-w-4xl mx-auto mt-4 flex items-center justify-between gap-4 px-4 py-3 bg-rose-950/40 border border-rose-500/30 rounded-lg text-sm text-rose-200">
            <div className="flex items-center gap-2.5">
              <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{voiceError}</span>
            </div>
            <button
              type="button"
              onClick={onClearVoiceError}
              className="text-xs font-medium text-rose-300 hover:text-white whitespace-nowrap"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Live Streaming Transcription */}
        {(liveUserDraft || liveAssistantDraft) && (
          <div className="max-w-4xl mx-auto mt-4 p-3.5 bg-[#121620] border border-white/10 rounded-lg space-y-2">
            {liveUserDraft && (
              <p className="text-xs text-slate-300">
                <span className="font-semibold text-blue-400 mr-2">Live You:</span>
                {liveUserDraft}
              </p>
            )}
            {liveAssistantDraft && (
              <p className="text-xs text-slate-200">
                <span className="font-semibold text-violet-400 mr-2">Live Mona&apos;s AI:</span>
                {liveAssistantDraft}
              </p>
            )}
          </div>
        )}
      </section>

      {/* Human-in-the-Loop Approval Gate */}
      {pendingApproval && (
        <div className="bg-[#131826] border-b border-blue-500/30 px-6 py-4">
          <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <Hand className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-semibold text-slate-100">{pendingApproval.title}</h3>
                <p className="text-xs text-slate-300 mt-0.5">{pendingApproval.description}</p>
                {typeof pendingApproval.payload.fact === 'string' && (
                  <p className="text-xs font-mono text-blue-200 mt-1.5 bg-black/30 px-2.5 py-1.5 rounded border border-white/8">
                    {pendingApproval.payload.fact}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => onResolveApproval(false)}
                className="min-h-[38px] px-3.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg transition-colors"
              >
                Decline
              </button>
              <button
                type="button"
                onClick={() => onResolveApproval(true)}
                className="min-h-[38px] px-4 py-1.5 text-xs font-medium text-white bg-[#3B82F6] hover:bg-[#2563EB] rounded-lg transition-colors"
              >
                Approve & Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Conversation Messages Viewport */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
        <div className="max-w-4xl mx-auto space-y-6">
          {messages.length === 0 ? (
            <div className="py-8 space-y-6">
              <div className="space-y-1.5">
                <h2 className="font-display text-base font-semibold text-slate-200">
                  Start with a prompt or click Start Conversation
                </h2>
                <p className="text-sm text-slate-400">
                  Nexora routes simple questions directly and orchestrates MCP tools, A2A agents, or RAG retrieval when needed.
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {EXAMPLE_PROMPTS.map((ex) => (
                  <button
                    key={ex.label}
                    type="button"
                    onClick={() => onSendText(ex.prompt)}
                    className="text-left p-4 bg-[#11141B] hover:bg-[#161A24] border border-white/8 hover:border-blue-500/40 rounded-xl transition-colors space-y-1.5"
                  >
                    <p className="text-xs font-semibold text-blue-400">{ex.label}</p>
                    <p className="text-sm text-slate-300 leading-snug">{ex.prompt}</p>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg) => {
              const isUser = msg.role === 'user';
              const hasDetails = Boolean((msg.tools && msg.tools.length > 0) || (msg.sources && msg.sources.length > 0));
              const isExpanded = Boolean(expandedDetails[msg.id]);

              return (
                <article
                  key={msg.id}
                  className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                >
                  <div
                    className={`max-w-[88%] md:max-w-[78%] rounded-xl px-4 py-3.5 ${
                      isUser
                        ? 'bg-[#1A2336] border border-blue-500/25 text-slate-100'
                        : 'bg-[#11141B] border border-white/8 text-slate-200'
                    }`}
                  >
                    {/* Metadata row using clean unboxed text with separators (no pills) */}
                    <div className="flex items-center justify-between gap-4 mb-2 text-xs text-slate-400">
                      <div className="flex items-center gap-2 font-mono tabular-nums">
                        <span className={isUser ? 'text-blue-300 font-semibold' : 'text-violet-300 font-semibold'}>
                          {isUser ? 'You' : "Mona's AI"}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{msg.modality === 'voice' ? 'Voice' : 'Text'}</span>
                        {msg.agentRoute && !isUser && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{msg.agentRoute}</span>
                          </>
                        )}
                        {typeof msg.latencyMs === 'number' && !isUser && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{msg.latencyMs}ms</span>
                          </>
                        )}
                      </div>

                      {!isUser && msg.content && (
                        <button
                          type="button"
                          onClick={() => void handleCopy(msg.id, msg.content)}
                          aria-label="Copy response"
                          className="p-1 text-slate-400 hover:text-slate-100 rounded transition-colors"
                        >
                          {copiedId === msg.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      )}
                    </div>

                    <div className="text-[15px] leading-relaxed whitespace-pre-wrap break-words">
                      {msg.content || (msg.streaming ? 'Thinking...' : '')}
                    </div>

                    {/* Expandable Tool & Source Attribution */}
                    {hasDetails && (
                      <div className="mt-3 pt-2.5 border-t border-white/8">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedDetails((prev) => ({ ...prev, [msg.id]: !prev[msg.id] }))
                          }
                          className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-400 hover:text-blue-300"
                        >
                          {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                          <span>
                            {msg.tools?.length ? `${msg.tools.length} tool calls` : ''}
                            {msg.tools?.length && msg.sources?.length ? ' · ' : ''}
                            {msg.sources?.length ? `${msg.sources.length} verified sources` : ''}
                          </span>
                        </button>

                        {isExpanded && (
                          <div className="mt-2.5 space-y-2 text-xs text-slate-300">
                            {msg.tools?.map((t, idx) => (
                              <div
                                key={`${t.toolName}_${idx}`}
                                className="flex items-center justify-between px-3 py-1.5 bg-black/30 rounded-lg border border-white/6 font-mono tabular-nums"
                              >
                                <span>
                                  {t.toolName} · {t.success ? 'ok' : 'error'}
                                </span>
                                <span className="text-slate-400">{t.latencyMs}ms</span>
                              </div>
                            ))}
                            {msg.sources?.map((s, idx) => (
                              <div
                                key={`${s.title}_${idx}`}
                                className="flex items-center justify-between gap-2 px-3 py-1.5 bg-black/30 rounded-lg border border-white/6"
                              >
                                <span className="truncate">
                                  [{s.kind === 'document' ? 'Document' : 'Web'}] {s.title}
                                </span>
                                {s.url ? (
                                  <a
                                    href={s.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-blue-400 hover:underline shrink-0"
                                  >
                                    Open <ExternalLink className="w-3 h-3" />
                                  </a>
                                ) : typeof s.score === 'number' ? (
                                  <span className="font-mono tabular-nums text-slate-400 shrink-0">
                                    score {s.score.toFixed(2)}
                                  </span>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </article>
              );
            })
          )}

          {/* Live Agent Activity Indicator during Text Streaming */}
          {activeTraces.length > 0 && (
            <div className="px-4 py-2.5 bg-[#11141B] border border-white/8 rounded-lg text-xs text-slate-400 font-mono space-y-1">
              {activeTraces.map((line, idx) => (
                <div key={idx}>{line}</div>
              ))}
            </div>
          )}

          <div ref={scrollEndRef} />
        </div>
      </div>

      {/* Multimodal Text Fallback Composer */}
      <footer className="border-t border-white/8 bg-[#0C0F16] px-4 sm:px-6 py-4">
        <form onSubmit={handleSubmit} className="max-w-4xl mx-auto flex items-center gap-3">
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder={
              voiceConnected
                ? 'Type a follow-up message into the live voice session...'
                : "Message Mona's AI in English, Urdu, or Roman Urdu..."
            }
            className="flex-1 min-h-[44px] px-4 py-2.5 text-sm bg-[#141822] text-slate-100 placeholder:text-slate-500 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#3B82F6]"
          />
          <button
            type="submit"
            disabled={!inputText.trim() || isSendingText}
            className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-[#3B82F6] hover:bg-[#2563EB] disabled:opacity-40 text-white rounded-xl transition-colors whitespace-nowrap"
          >
            <Send className="w-4 h-4" />
            <span>{isSendingText ? 'Running' : 'Send'}</span>
          </button>
        </form>
      </footer>
    </div>
  );
}
