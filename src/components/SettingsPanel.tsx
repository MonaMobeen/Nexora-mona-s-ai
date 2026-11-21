import type { UserPreferences } from '../types/nexora';

interface SettingsPanelProps {
  preferences: UserPreferences;
  isSignedIn: boolean;
  onUpdatePreferences: (patch: Partial<UserPreferences>) => void;
}

export function SettingsPanel({
  preferences,
  isSignedIn,
  onUpdatePreferences,
}: SettingsPanelProps) {
  return (
    <div className="h-full overflow-y-auto px-6 py-8">
      <div className="max-w-3xl mx-auto space-y-8">
        <header className="space-y-2">
          <h1 className="font-display text-2xl font-semibold text-slate-100">Voice & Agent Settings</h1>
          <p className="text-sm text-slate-400">
            Configure Gemini Live speech synthesis, multilingual behavior, and reasoning depth.{' '}
            {isSignedIn ? 'Preferences persist automatically to Firestore.' : 'Sign in with Google to save across sessions.'}
          </p>
        </header>

        <div className="bg-[#11141B] border border-white/8 rounded-xl divide-y divide-white/8">
          {/* Voice Persona */}
          <div className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">Live Speech Voice</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Native Gemini Live 24kHz audio persona for speech-to-speech responses.
              </p>
            </div>
            <select
              aria-label="Preferred voice"
              value={preferences.preferredVoice}
              onChange={(e) =>
                onUpdatePreferences({ preferredVoice: e.target.value as UserPreferences['preferredVoice'] })
              }
              className="min-h-[40px] px-3 py-2 text-sm bg-[#090B10] text-slate-100 border border-white/10 rounded-lg"
            >
              <option value="Zephyr">Zephyr (Balanced)</option>
              <option value="Puck">Puck (Energetic)</option>
              <option value="Charon">Charon (Deep)</option>
              <option value="Kore">Kore (Clear)</option>
              <option value="Fenrir">Fenrir (Direct)</option>
            </select>
          </div>

          {/* Speaking Style */}
          <div className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">Speaking Style</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Controls tone and density across both Live voice and text responses.
              </p>
            </div>
            <select
              aria-label="Speaking style"
              value={preferences.speakingStyle}
              onChange={(e) =>
                onUpdatePreferences({ speakingStyle: e.target.value as UserPreferences['speakingStyle'] })
              }
              className="min-h-[40px] px-3 py-2 text-sm bg-[#090B10] text-slate-100 border border-white/10 rounded-lg"
            >
              <option value="natural">Natural Conversational</option>
              <option value="concise">Concise Executive</option>
              <option value="technical">Deep Technical</option>
              <option value="warm">Warm & Supportive</option>
            </select>
          </div>

          {/* Language Preference */}
          <div className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">Multilingual Mode</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Supports automatic code-switching across English, Urdu (اردو), and Roman Urdu.
              </p>
            </div>
            <select
              aria-label="Language mode"
              value={preferences.preferredLanguage}
              onChange={(e) =>
                onUpdatePreferences({ preferredLanguage: e.target.value as UserPreferences['preferredLanguage'] })
              }
              className="min-h-[40px] px-3 py-2 text-sm bg-[#090B10] text-slate-100 border border-white/10 rounded-lg"
            >
              <option value="auto">Auto-Detect (English / Urdu / Roman Urdu)</option>
              <option value="en">English Primary</option>
              <option value="ur">Urdu Script (اردو)</option>
              <option value="ur-Latn">Roman Urdu</option>
            </select>
          </div>

          {/* Extended Thinking Live */}
          <div className="p-5 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">Live Extended Thinking Model</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Uses <span className="font-mono text-slate-300">gemini-3.8-live-extended-thinking</span> with non-blocking MCP tools for multi-step voice reasoning.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={preferences.extendedThinking}
              onClick={() => onUpdatePreferences({ extendedThinking: !preferences.extendedThinking })}
              className={`w-12 h-7 rounded-full p-1 transition-colors shrink-0 ${
                preferences.extendedThinking ? 'bg-[#3B82F6]' : 'bg-white/15'
              }`}
            >
              <span
                className={`block w-5 h-5 rounded-full bg-white transition-transform ${
                  preferences.extendedThinking ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </div>

        {/* Security & Architecture Summary */}
        <section className="bg-[#11141B] border border-white/8 rounded-xl p-5 space-y-2">
          <h2 className="text-sm font-semibold text-slate-100">Security & Privacy Architecture</h2>
          <ul className="text-xs text-slate-400 space-y-1.5 list-disc pl-4">
            <li>Gemini API keys remain strictly on the server; browser streams PCM audio via authenticated WebSocket.</li>
            <li>Prompt injection heuristics, safe math parsing, SSRF URL filtering, and per-client rate limiting protect all endpoints.</li>
            <li>Long-term memories require explicit user consent and are protected by owner-verified Firestore security rules.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
