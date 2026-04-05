import { useParams, useNavigate } from 'react-router-dom'
import { useApi } from '../hooks/useApi.js'
import { apiGet } from '../api/client.js'
import StatusBadge from '../components/shared/StatusBadge.js'

interface ExecutionStep {
  id: string
  description: string
  tool?: string
  result: { success: boolean; output: string; error?: string }
  duration: number
}

interface Experience {
  id: string
  task: string
  result: 'success' | 'partial' | 'failure'
  steps: ExecutionStep[]
  reflection: { whatWorked: string[]; whatFailed: string[]; lesson: string }
  tags: string[]
  timestamp: string
  admissionScore: number
  health: { referencedCount: number; contradictionCount: number; lastReferenced?: string }
}

export default function ExperienceDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data: exp, loading } = useApi<Experience>(() => apiGet(`/memory/experiences/${id}`), [id])

  if (loading) return <div className="text-gray-400">Loading...</div>
  if (!exp) return <div className="text-gray-400">Experience not found</div>

  return (
    <div>
      <button onClick={() => navigate('/memory')} className="text-sm text-blue-600 hover:underline mb-4 block">
        &larr; Back to Memory
      </button>

      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold">{exp.task}</h2>
            <div className="flex items-center gap-2 mt-2">
              <StatusBadge status={exp.result} />
              <span className="text-xs text-gray-400">{new Date(exp.timestamp).toLocaleString()}</span>
            </div>
          </div>
          <div className="text-right text-sm">
            <p className="text-gray-500">Admission Score: <span className="font-medium">{exp.admissionScore.toFixed(3)}</span></p>
            <p className="text-gray-500">References: {exp.health.referencedCount}</p>
            <p className="text-gray-500">Contradictions: {exp.health.contradictionCount}</p>
          </div>
        </div>

        {exp.tags.length > 0 && (
          <div className="flex gap-1 mt-2">
            {exp.tags.map((tag) => (
              <span key={tag} className="bg-blue-50 text-blue-700 text-xs px-2 py-0.5 rounded">{tag}</span>
            ))}
          </div>
        )}
      </div>

      {/* Execution Steps */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <h3 className="text-sm font-medium text-gray-600 mb-4">Execution Steps ({exp.steps.length})</h3>
        <div className="space-y-3">
          {exp.steps.map((step, i) => (
            <div key={step.id} className="border border-gray-100 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-gray-400">#{i + 1}</span>
                  <span className={`w-2 h-2 rounded-full ${step.result.success ? 'bg-green-500' : 'bg-red-500'}`} />
                  <span className="text-sm">{step.description}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-400">
                  {step.tool && <span className="bg-gray-100 px-2 py-0.5 rounded">{step.tool}</span>}
                  <span>{step.duration}ms</span>
                </div>
              </div>
              {step.result.output && (
                <pre className="mt-2 text-xs bg-gray-50 p-2 rounded overflow-x-auto max-h-32">
                  {step.result.output.slice(0, 500)}
                </pre>
              )}
              {step.result.error && (
                <p className="mt-1 text-xs text-red-600">{step.result.error}</p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Reflection */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h3 className="text-sm font-medium text-gray-600 mb-4">Reflection</h3>
        <div className="grid grid-cols-2 gap-6">
          <div>
            <h4 className="text-xs font-medium text-green-600 mb-2">What Worked</h4>
            <ul className="space-y-1">
              {exp.reflection.whatWorked.map((item, i) => (
                <li key={i} className="text-sm text-gray-700">+ {item}</li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="text-xs font-medium text-red-600 mb-2">What Failed</h4>
            <ul className="space-y-1">
              {exp.reflection.whatFailed.map((item, i) => (
                <li key={i} className="text-sm text-gray-700">- {item}</li>
              ))}
            </ul>
          </div>
        </div>
        <div className="mt-4 bg-blue-50 rounded-lg p-3">
          <h4 className="text-xs font-medium text-blue-600 mb-1">Lesson Learned</h4>
          <p className="text-sm text-gray-700">{exp.reflection.lesson}</p>
        </div>
      </div>
    </div>
  )
}
