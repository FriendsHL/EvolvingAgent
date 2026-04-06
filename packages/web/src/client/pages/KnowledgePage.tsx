import { useState } from 'react'
import { useApi } from '../hooks/useApi.js'
import { apiGet, apiPost, apiDelete } from '../api/client.js'

interface KnowledgeEntry {
  id: string
  title: string
  content: string
  tags: string[]
  source?: string
  createdAt: string
  updatedAt: string
}

interface FormState {
  title: string
  content: string
  tags: string
  source: string
}

const emptyForm: FormState = { title: '', content: '', tags: '', source: '' }

export default function KnowledgePage() {
  const { data, refetch } = useApi<{ entries: KnowledgeEntry[] }>(() => apiGet('/knowledge'))
  const entries = data?.entries ?? []
  const [form, setForm] = useState<FormState>(emptyForm)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    if (!form.title.trim() || !form.content.trim()) {
      setError('Title and content are required')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const tags = form.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      await apiPost('/knowledge', {
        title: form.title.trim(),
        content: form.content.trim(),
        tags,
        source: form.source.trim() || undefined,
      })
      setForm(emptyForm)
      setShowForm(false)
      refetch()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this knowledge entry?')) return
    try {
      await apiDelete(`/knowledge/${id}`)
      refetch()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">Knowledge Base</h2>
          <p className="text-xs text-gray-500 mt-1">
            User-curated documents, notes, and facts available to the agent.
          </p>
        </div>
        <button
          onClick={() => {
            setShowForm((v) => !v)
            setError(null)
          }}
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700"
        >
          {showForm ? 'Close' : 'Add Entry'}
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <h3 className="text-sm font-medium mb-4">New Knowledge Entry</h3>
          <div className="space-y-3">
            <input
              placeholder="Title"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm"
            />
            <textarea
              placeholder="Content"
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm font-mono"
              rows={8}
            />
            <input
              placeholder="Tags (comma-separated)"
              value={form.tags}
              onChange={(e) => setForm({ ...form, tags: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm"
            />
            <input
              placeholder="Source (optional URL or reference)"
              value={form.source}
              onChange={(e) => setForm({ ...form, source: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm"
            />
            {error && <p className="text-xs text-red-500">{error}</p>}
          </div>
          <div className="flex gap-2 mt-4">
            <button
              onClick={handleSave}
              disabled={saving}
              className="bg-blue-600 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => {
                setShowForm(false)
                setForm(emptyForm)
                setError(null)
              }}
              className="text-gray-500 text-sm px-4 py-1.5"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {entries.length === 0 && !showForm && (
          <div className="text-center text-gray-400 py-12">No knowledge entries yet</div>
        )}
        {entries.map((entry) => (
          <div key={entry.id} className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-medium">{entry.title}</h3>
                <p className="text-xs text-gray-600 mt-2 whitespace-pre-wrap line-clamp-6">
                  {entry.content}
                </p>
                {entry.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {entry.tags.map((t, i) => (
                      <span
                        key={i}
                        className="text-[10px] bg-gray-50 text-gray-500 px-1.5 py-0.5 rounded"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-3 mt-2 text-[10px] text-gray-400">
                  <span>Updated: {new Date(entry.updatedAt).toLocaleString()}</span>
                  {entry.source && <span>Source: {entry.source}</span>}
                </div>
              </div>
              <button
                onClick={() => handleDelete(entry.id)}
                className="text-red-500 text-xs hover:underline shrink-0"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
