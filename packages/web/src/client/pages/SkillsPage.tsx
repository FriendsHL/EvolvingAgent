import { useState } from 'react'
import { useApi } from '../hooks/useApi.js'
import { apiGet, apiPost, apiPut, apiDelete, apiPatch } from '../api/client.js'

// === Types ===

interface SkillMetadata {
  score: number
  usageCount: number
  lastUsed?: string
  enabled: boolean
  status: 'active' | 'disabled' | 'archived'
  createdAt: string
  createdFrom: 'builtin' | 'user' | 'agent'
}

interface SkillWithMeta {
  id: string
  name: string
  description: string
  category: 'builtin' | 'system' | 'learned'
  triggers: string[]
  inputs: Array<{ name: string; type: string; required?: boolean }>
  metadata: SkillMetadata
}

interface SkillUsageRecord {
  timestamp: string
  success: boolean
  duration?: number
}

interface SkillStep {
  description: string
  tool?: string
  params?: Record<string, unknown>
}

interface SkillFormData {
  name: string
  description: string
  triggers: string
  steps: SkillStep[]
}

type TabFilter = 'all' | 'builtin' | 'system' | 'learned'

const emptyForm: SkillFormData = {
  name: '',
  description: '',
  triggers: '',
  steps: [{ description: '' }],
}

// === Category badge colors ===

const categoryColors: Record<string, { bg: string; text: string }> = {
  builtin: { bg: 'bg-purple-100', text: 'text-purple-700' },
  system: { bg: 'bg-blue-100', text: 'text-blue-700' },
  learned: { bg: 'bg-green-100', text: 'text-green-700' },
}

// === Component ===

export default function SkillsPage() {
  const { data, refetch } = useApi<{ skills: SkillWithMeta[] }>(() => apiGet('/skills'))
  const skills = data?.skills ?? []
  const [activeTab, setActiveTab] = useState<TabFilter>('all')
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<SkillFormData>(emptyForm)
  const [showForm, setShowForm] = useState(false)
  const [historySkillId, setHistorySkillId] = useState<string | null>(null)
  const [historyData, setHistoryData] = useState<SkillUsageRecord[]>([])

  // Filter skills by tab
  const filtered = activeTab === 'all' ? skills : skills.filter((s) => s.category === activeTab)

  const tabs: { key: TabFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'builtin', label: 'Builtin' },
    { key: 'system', label: 'System' },
    { key: 'learned', label: 'Learned' },
  ]

  const openCreate = () => {
    setEditing(null)
    setForm(emptyForm)
    setShowForm(true)
  }

  const openEdit = (skill: SkillWithMeta) => {
    setEditing(skill.id)
    setForm({
      name: skill.name,
      description: skill.description,
      triggers: skill.triggers.join(', '),
      steps: [{ description: '' }], // Steps aren't returned from server, reset
    })
    setShowForm(true)
  }

  const handleSave = async () => {
    const triggers = form.triggers
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)

    if (editing) {
      await apiPut(`/skills/${editing}`, {
        name: form.name,
        description: form.description,
        triggers,
        steps: form.steps.filter((s) => s.description.trim()),
      })
    } else {
      await apiPost('/skills', {
        name: form.name,
        description: form.description,
        triggers,
        steps: form.steps.filter((s) => s.description.trim()),
      })
    }
    setShowForm(false)
    refetch()
  }

  const handleDelete = async (id: string) => {
    try {
      await apiDelete(`/skills/${id}`)
      refetch()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  const handleToggle = async (id: string) => {
    await apiPatch(`/skills/${id}/toggle`)
    refetch()
  }

  const viewHistory = async (id: string) => {
    if (historySkillId === id) {
      setHistorySkillId(null)
      return
    }
    const result = await apiGet<{ history: SkillUsageRecord[] }>(`/skills/${id}/history`)
    setHistoryData(result.history)
    setHistorySkillId(id)
  }

  // Step editor helpers
  const addStep = () => setForm({ ...form, steps: [...form.steps, { description: '' }] })
  const removeStep = (i: number) => setForm({ ...form, steps: form.steps.filter((_, j) => j !== i) })
  const updateStep = (i: number, field: string, value: string) => {
    const steps = [...form.steps]
    steps[i] = { ...steps[i], [field]: value }
    setForm({ ...form, steps })
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Skills</h2>
        <button
          onClick={openCreate}
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700"
        >
          Create Skill
        </button>
      </div>

      {/* Tab navigation */}
      <div className="flex gap-1 mb-6 bg-gray-100 rounded-lg p-1 w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`text-sm px-4 py-1.5 rounded-md transition-colors ${
              activeTab === tab.key
                ? 'bg-white text-gray-900 shadow-sm font-medium'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
            <span className="ml-1.5 text-xs text-gray-400">
              {tab.key === 'all' ? skills.length : skills.filter((s) => s.category === tab.key).length}
            </span>
          </button>
        ))}
      </div>

      {/* Create / Edit form */}
      {showForm && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <h3 className="text-sm font-medium mb-4">{editing ? 'Edit Skill' : 'New Skill'}</h3>
          <div className="space-y-3">
            <input
              placeholder="Skill name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm"
            />
            <textarea
              placeholder="Description"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm"
              rows={2}
            />
            <input
              placeholder="Triggers (comma-separated keywords)"
              value={form.triggers}
              onChange={(e) => setForm({ ...form, triggers: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm"
            />
            <div>
              <label className="text-xs text-gray-500">Steps</label>
              {form.steps.map((step, i) => (
                <div key={i} className="flex gap-2 mt-1">
                  <input
                    placeholder="Step description"
                    value={step.description}
                    onChange={(e) => updateStep(i, 'description', e.target.value)}
                    className="flex-1 border rounded-lg px-3 py-1.5 text-sm"
                  />
                  <input
                    placeholder="Tool (optional)"
                    value={step.tool ?? ''}
                    onChange={(e) => updateStep(i, 'tool', e.target.value)}
                    className="w-32 border rounded-lg px-3 py-1.5 text-sm"
                  />
                  {form.steps.length > 1 && (
                    <button
                      onClick={() => removeStep(i)}
                      className="text-red-400 hover:text-red-600 text-sm px-2"
                    >
                      x
                    </button>
                  )}
                </div>
              ))}
              <button onClick={addStep} className="text-blue-600 text-xs mt-2 hover:underline">
                + Add step
              </button>
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <button
              onClick={handleSave}
              className="bg-blue-600 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-blue-700"
            >
              Save
            </button>
            <button onClick={() => setShowForm(false)} className="text-gray-500 text-sm px-4 py-1.5">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Skill list */}
      <div className="space-y-3">
        {filtered.length === 0 && !showForm && (
          <div className="text-center text-gray-400 py-12">
            {activeTab === 'all' ? 'No skills configured yet' : `No ${activeTab} skills`}
          </div>
        )}
        {filtered.map((skill) => {
          const cat = categoryColors[skill.category] ?? categoryColors.system
          return (
            <div key={skill.id} className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  {/* Title row */}
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium truncate">{skill.name}</h3>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${cat.bg} ${cat.text}`}>
                      {skill.category}
                    </span>
                    {!skill.metadata.enabled && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">
                        disabled
                      </span>
                    )}
                  </div>

                  {/* Description */}
                  <p className="text-xs text-gray-500 mt-1">{skill.description}</p>

                  {/* Triggers */}
                  {skill.triggers.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {skill.triggers.map((t, i) => (
                        <span key={i} className="text-[10px] bg-gray-50 text-gray-500 px-1.5 py-0.5 rounded">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Stats row */}
                  <div className="flex items-center gap-4 mt-2.5">
                    {/* Score bar */}
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-gray-400">Score</span>
                      <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full transition-all"
                          style={{ width: `${(skill.metadata.score * 100).toFixed(0)}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-gray-500">{skill.metadata.score.toFixed(2)}</span>
                    </div>
                    <span className="text-[10px] text-gray-400">
                      Used: {skill.metadata.usageCount}x
                    </span>
                    {skill.metadata.lastUsed && (
                      <span className="text-[10px] text-gray-400">
                        Last: {new Date(skill.metadata.lastUsed).toLocaleDateString()}
                      </span>
                    )}
                    <span className="text-[10px] text-gray-400">
                      From: {skill.metadata.createdFrom}
                    </span>
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-2 ml-4 shrink-0">
                  <button
                    onClick={() => viewHistory(skill.id)}
                    className="text-gray-400 hover:text-gray-600 text-xs"
                    title="Usage history"
                  >
                    History
                  </button>
                  <button
                    onClick={() => handleToggle(skill.id)}
                    className={`text-xs px-2 py-0.5 rounded ${
                      skill.metadata.enabled
                        ? 'bg-green-50 text-green-600 hover:bg-green-100'
                        : 'bg-gray-50 text-gray-500 hover:bg-gray-100'
                    }`}
                  >
                    {skill.metadata.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                  {skill.category !== 'builtin' && (
                    <>
                      <button
                        onClick={() => openEdit(skill)}
                        className="text-blue-600 text-xs hover:underline"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(skill.id)}
                        className="text-red-500 text-xs hover:underline"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* History panel (expandable) */}
              {historySkillId === skill.id && (
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <h4 className="text-xs font-medium text-gray-500 mb-2">Usage History</h4>
                  {historyData.length === 0 ? (
                    <p className="text-xs text-gray-400">No usage recorded yet</p>
                  ) : (
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {historyData
                        .slice()
                        .reverse()
                        .slice(0, 20)
                        .map((record, i) => (
                          <div key={i} className="flex items-center gap-3 text-[11px]">
                            <span className={record.success ? 'text-green-500' : 'text-red-500'}>
                              {record.success ? 'OK' : 'FAIL'}
                            </span>
                            <span className="text-gray-400">
                              {new Date(record.timestamp).toLocaleString()}
                            </span>
                            {record.duration != null && (
                              <span className="text-gray-400">{record.duration}ms</span>
                            )}
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
