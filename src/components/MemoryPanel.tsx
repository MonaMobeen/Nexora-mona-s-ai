import { useState } from 'react';
import { Check, Edit3, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import type { MemoryEntry } from '../types/nexora';

interface MemoryPanelProps {
  memories: MemoryEntry[];
  isSignedIn: boolean;
  onAddMemory: (fact: string, category: MemoryEntry['category']) => Promise<void>;
  onUpdateMemory: (id: string, fact: string, category: MemoryEntry['category']) => Promise<void>;
  onDeleteMemory: (id: string) => Promise<void>;
}

const CATEGORIES: ReadonlyArray<{ id: 'all' | MemoryEntry['category']; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'preference', label: 'Preferences' },
  { id: 'project', label: 'Projects' },
  { id: 'fact', label: 'Facts' },
  { id: 'instruction', label: 'Instructions' },
];

export function MemoryPanel({
  memories,
  isSignedIn,
  onAddMemory,
  onUpdateMemory,
  onDeleteMemory,
}: MemoryPanelProps) {
  const [filter, setFilter] = useState<'all' | MemoryEntry['category']>('all');
  const [newFact, setNewFact] = useState('');
  const [newCategory, setNewCategory] = useState<MemoryEntry['category']>('preference');
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editFact, setEditFact] = useState('');
  const [editCategory, setEditCategory] = useState<MemoryEntry['category']>('fact');

  const filtered = filter === 'all' ? memories : memories.filter((m) => m.category === filter);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFact.trim() || saving) return;
    setSaving(true);
    try {
      await onAddMemory(newFact.trim(), newCategory);
      setNewFact('');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveEdit = async (id: string) => {
    if (!editFact.trim()) return;
    await onUpdateMemory(id, editFact.trim(), editCategory);
    setEditingId(null);
  };

  return (
    <div className="h-full overflow-y-auto px-6 py-8">
      <div className="max-w-4xl mx-auto space-y-8">
        <header className="space-y-2">
          <h1 className="font-display text-2xl font-semibold text-slate-100">User-Controlled Memory</h1>
          <p className="text-sm text-slate-400 leading-relaxed">
            Nexora only persists long-term facts, preferences, or recurring instructions with your explicit approval.{' '}
            {isSignedIn
              ? 'Synced to your private Firestore workspace.'
              : 'Currently stored in browser memory; sign in with Google to persist across devices.'}
          </p>
        </header>

        {/* Add Memory Form */}
        <form onSubmit={handleAdd} className="bg-[#11141B] border border-white/8 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2 text-xs font-medium text-blue-300">
            <ShieldCheck className="w-4 h-4" />
            <span>Explicit Consent Entry</span>
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              value={newFact}
              onChange={(e) => setNewFact(e.target.value)}
              maxLength={1000}
              placeholder="e.g., Prefer concise TypeScript architecture explanations in English and Roman Urdu"
              className="flex-1 min-h-[42px] px-3.5 py-2 text-sm bg-[#090B10] text-slate-100 placeholder:text-slate-500 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#3B82F6]"
            />
            <select
              aria-label="Memory category"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value as MemoryEntry['category'])}
              className="min-h-[42px] px-3 py-2 text-sm bg-[#090B10] text-slate-200 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#3B82F6]"
            >
              <option value="preference">Preference</option>
              <option value="project">Project</option>
              <option value="fact">Fact</option>
              <option value="instruction">Instruction</option>
            </select>
            <button
              type="submit"
              disabled={!newFact.trim() || saving}
              className="min-h-[42px] inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-[#3B82F6] hover:bg-[#2563EB] disabled:opacity-40 text-white rounded-lg transition-colors whitespace-nowrap"
            >
              <Plus className="w-4 h-4" />
              Save Memory
            </button>
          </div>
        </form>

        {/* Filter Controls */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-1 p-1 bg-[#11141B] border border-white/8 rounded-lg">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setFilter(c.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  filter === c.id ? 'bg-white/12 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <span className="text-xs font-mono tabular-nums text-slate-400">
            {filtered.length} approved entries
          </span>
        </div>

        {/* Memory List */}
        {filtered.length === 0 ? (
          <div className="bg-[#11141B] border border-white/8 rounded-xl p-8 text-center space-y-2">
            <p className="text-sm font-medium text-slate-300">No stored memories in this view</p>
            <p className="text-xs text-slate-500">
              Add a memory above or ask Nexora in conversation to remember a preference for your approval.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/8 bg-[#11141B] border border-white/8 rounded-xl overflow-hidden">
            {filtered.map((mem) => {
              const isEditing = editingId === mem.id;
              return (
                <div key={mem.id} className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  {isEditing ? (
                    <div className="flex-1 flex flex-col sm:flex-row gap-2">
                      <input
                        type="text"
                        value={editFact}
                        onChange={(e) => setEditFact(e.target.value)}
                        className="flex-1 min-h-[38px] px-3 py-1.5 text-sm bg-[#090B10] text-slate-100 border border-blue-500/40 rounded-lg"
                      />
                      <select
                        value={editCategory}
                        onChange={(e) => setEditCategory(e.target.value as MemoryEntry['category'])}
                        className="min-h-[38px] px-2.5 py-1.5 text-xs bg-[#090B10] text-slate-200 border border-white/10 rounded-lg"
                      >
                        <option value="preference">Preference</option>
                        <option value="project">Project</option>
                        <option value="fact">Fact</option>
                        <option value="instruction">Instruction</option>
                      </select>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => void handleSaveEdit(mem.id)}
                          aria-label="Save edit"
                          className="p-2 text-emerald-400 hover:bg-white/5 rounded-lg"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          aria-label="Cancel edit"
                          className="p-2 text-slate-400 hover:bg-white/5 rounded-lg"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="space-y-1 min-w-0">
                        <p className="text-sm text-slate-100 leading-relaxed break-words">{mem.fact}</p>
                        <p className="text-xs text-slate-500 font-mono tabular-nums">
                          {mem.category} · source {mem.source} · {new Date(mem.updatedAt).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(mem.id);
                            setEditFact(mem.fact);
                            setEditCategory(mem.category);
                          }}
                          aria-label="Edit memory"
                          className="p-2 text-slate-400 hover:text-slate-100 hover:bg-white/5 rounded-lg transition-colors"
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void onDeleteMemory(mem.id)}
                          aria-label="Delete memory"
                          className="p-2 text-slate-400 hover:text-rose-400 hover:bg-white/5 rounded-lg transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
