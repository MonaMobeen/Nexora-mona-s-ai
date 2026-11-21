import {
  Activity,
  BrainCircuit,
  Database,
  LogIn,
  LogOut,
  MessageSquare,
  Plus,
  Settings,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import type { User } from 'firebase/auth';
import type { ChatSession, WorkspaceTab } from '../types/nexora';

interface SidebarProps {
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  sessions: ChatSession[];
  activeSessionId: string;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onDeleteSession: (sessionId: string) => void;
  user: User | null;
  authLoading: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const NAV_ITEMS: ReadonlyArray<{ id: WorkspaceTab; label: string; icon: typeof MessageSquare }> = [
  { id: 'conversation', label: 'Conversation', icon: MessageSquare },
  { id: 'memory', label: 'Memory', icon: BrainCircuit },
  { id: 'tools', label: 'Tools & A2A', icon: Wrench },
  { id: 'knowledge', label: 'Knowledge Base', icon: Database },
  { id: 'observability', label: 'Observability', icon: Activity },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function Sidebar({
  activeTab,
  onSelectTab,
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  user,
  authLoading,
  onSignIn,
  onSignOut,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const sidebarContent = (
    <div className="flex flex-col h-full bg-[#0D1017] border-r border-white/8 w-[264px] shrink-0">
      {/* Brand Header */}
      <div className="flex items-center justify-between px-5 h-16 border-b border-white/8">
        <span className="font-display text-lg font-semibold tracking-tight text-slate-100 whitespace-nowrap">
          Mona&apos;s AI
        </span>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close navigation"
          className="lg:hidden p-2 text-slate-400 hover:text-slate-100 rounded-lg"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Primary Action */}
      <div className="p-4">
        <button
          type="button"
          onClick={() => {
            onNewSession();
            onSelectTab('conversation');
            onCloseMobile();
          }}
          className="w-full min-h-[40px] flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-[#3B82F6] hover:bg-[#2563EB] text-white rounded-lg transition-colors whitespace-nowrap"
        >
          <Plus className="w-4 h-4 shrink-0" />
          New Conversation
        </button>
      </div>

      {/* Navigation Tabs */}
      <nav aria-label="Workspace navigation" className="px-3 space-y-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onSelectTab(item.id);
                onCloseMobile();
              }}
              className={`w-full min-h-[40px] flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                active
                  ? 'bg-white/10 text-white'
                  : 'text-slate-400 hover:text-slate-100 hover:bg-white/5'
              }`}
            >
              <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-[#60A5FA]' : 'text-slate-400'}`} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Session History */}
      <div className="mt-6 flex-1 min-h-0 flex flex-col border-t border-white/8 pt-4">
        <div className="px-5 pb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-slate-400">Recent Sessions</span>
          <span className="text-xs font-mono tabular-nums text-slate-500">{sessions.length}</span>
        </div>

        <div className="flex-1 overflow-y-auto px-3 space-y-1 pb-4">
          {sessions.length === 0 ? (
            <p className="px-3 py-2 text-xs text-slate-500">No saved sessions yet.</p>
          ) : (
            sessions.map((s) => {
              const isSelected = s.id === activeSessionId;
              return (
                <div
                  key={s.id}
                  className={`group flex items-center justify-between rounded-lg px-3 py-2 transition-colors ${
                    isSelected ? 'bg-white/8 text-slate-100' : 'text-slate-400 hover:bg-white/4 hover:text-slate-200'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      onSelectSession(s.id);
                      onSelectTab('conversation');
                      onCloseMobile();
                    }}
                    className="flex-1 text-left min-w-0 pr-2"
                  >
                    <p className="text-xs font-medium truncate">{s.title}</p>
                    <p className="text-[11px] text-slate-500 font-mono tabular-nums truncate mt-0.5">
                      {s.messageCount} msgs · {new Date(s.updatedAt).toLocaleDateString()}
                    </p>
                  </button>
                  {sessions.length > 1 && (
                    <button
                      type="button"
                      onClick={() => onDeleteSession(s.id)}
                      aria-label={`Delete ${s.title}`}
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1.5 text-slate-500 hover:text-rose-400 rounded transition-opacity"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* User Auth Footer */}
      <div className="p-4 border-t border-white/8">
        {authLoading ? (
          <div className="h-10 rounded-lg bg-white/5 animate-pulse" />
        ) : user ? (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-medium text-slate-200 truncate">{user.displayName || 'Authenticated User'}</p>
              <p className="text-[11px] text-slate-500 truncate">{user.email}</p>
            </div>
            <button
              type="button"
              onClick={onSignOut}
              aria-label="Sign out"
              className="p-2 text-slate-400 hover:text-slate-100 hover:bg-white/5 rounded-lg transition-colors shrink-0"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onSignIn}
            className="w-full min-h-[40px] flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium bg-white/6 hover:bg-white/10 text-slate-200 border border-white/10 rounded-lg transition-colors"
          >
            <LogIn className="w-3.5 h-3.5 text-[#60A5FA]" />
            Sign in with Google to sync
          </button>
        )}
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block h-full">{sidebarContent}</aside>
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="fixed inset-0 bg-black/70" onClick={onCloseMobile} />
          <div className="relative z-10 h-full">{sidebarContent}</div>
        </div>
      )}
    </>
  );
}
