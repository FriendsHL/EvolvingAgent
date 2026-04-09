import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi.js'
import { apiGet } from '../api/client.js'

interface MainAgentInfo {
  id: 'main'
  name: string
  provider: string
  models: { planner: string; executor: string; reflector: string }
  prompts: Array<{ id: string; source: string; length: number; preview: string }>
  tools: string[]
  skills: string[]
  note: string
}

export default function AgentsPage() {
  const { data: mainData } = useApi<MainAgentInfo>(() => apiGet('/agents/main'))

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Agents</h2>
      </div>

      {/* Main agent — the one /api/chat actually uses */}
      {mainData && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-5 mb-6">
          <div className="flex items-start justify-between mb-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 bg-blue-600 text-white text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide">
                  Main
                </span>
                <h3 className="text-base font-semibold text-gray-900">{mainData.name}</h3>
              </div>
              <p className="text-xs text-gray-500 mt-1">{mainData.note}</p>
            </div>
            <div className="text-right text-xs text-gray-500">
              <div>Provider: <span className="font-mono text-gray-800">{mainData.provider}</span></div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
            <div className="bg-white rounded-lg border border-blue-100 p-3">
              <div className="text-[11px] text-gray-400 uppercase tracking-wide">Planner</div>
              <div className="text-sm font-mono text-gray-800 truncate">{mainData.models.planner}</div>
            </div>
            <div className="bg-white rounded-lg border border-blue-100 p-3">
              <div className="text-[11px] text-gray-400 uppercase tracking-wide">Executor</div>
              <div className="text-sm font-mono text-gray-800 truncate">{mainData.models.executor}</div>
            </div>
            <div className="bg-white rounded-lg border border-blue-100 p-3">
              <div className="text-[11px] text-gray-400 uppercase tracking-wide">Reflector</div>
              <div className="text-sm font-mono text-gray-800 truncate">{mainData.models.reflector}</div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
            <div>
              <div className="text-[11px] text-gray-400 uppercase tracking-wide mb-1">
                Tools ({mainData.tools.length})
              </div>
              <div className="flex flex-wrap gap-1">
                {mainData.tools.map((t) => (
                  <span key={t} className="text-[11px] font-mono bg-white border border-gray-200 text-gray-700 px-1.5 py-0.5 rounded">
                    {t}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-gray-400 uppercase tracking-wide mb-1">
                Skills ({mainData.skills.length})
              </div>
              <div className="flex flex-wrap gap-1">
                {mainData.skills.map((s) => (
                  <span key={s} className="text-[11px] font-mono bg-white border border-gray-200 text-gray-700 px-1.5 py-0.5 rounded">
                    {s}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div>
            <div className="text-[11px] text-gray-400 uppercase tracking-wide mb-1 flex items-center gap-2">
              Prompts
              <Link to="/prompts" className="text-blue-600 hover:underline normal-case tracking-normal">
                edit →
              </Link>
            </div>
            <div className="space-y-2">
              {mainData.prompts.map((p) => (
                <div key={p.id} className="bg-white rounded-lg border border-blue-100 p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-xs font-semibold">{p.id}</span>
                    <span className="text-[10px] text-gray-400">{p.source}</span>
                    <span className="text-[10px] text-gray-400 ml-auto">{p.length} chars</span>
                  </div>
                  <p className="text-xs text-gray-600 font-mono whitespace-pre-wrap line-clamp-2">
                    {p.preview}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Phase 5 placeholder — Custom agent registry removed
          In the current runtime the Main Agent shown above is env-driven
          (EVOLVING_AGENT_PROVIDER). The old "create custom agent" form
          only wrote an informational entry that did not affect chat
          behavior, which was misleading. Phase 5 (router + role-shaped
          sub-agents) will bring back real per-agent definitions loaded
          from packages/core/src/sub-agents/builtin/*.md with identity
          prompts, tool allowlists, and private memory namespaces.
          Until then, there is nothing useful to display here beyond
          the Main Agent card. */}
      <div className="mt-2 rounded-xl border border-dashed border-gray-300 bg-gray-50 p-5 text-sm text-gray-600">
        <div className="font-medium text-gray-800 mb-1">即将上线 · Sub-Agents (Phase 5)</div>
        <p className="text-xs leading-relaxed">
          当前架构下，<span className="font-mono text-gray-800">/api/chat</span> 使用的
          <span className="font-medium"> 主 Agent </span>
          由环境变量（<span className="font-mono">EVOLVING_AGENT_PROVIDER</span>）决定。
          自定义 agent 列表在 Phase 5 会重启——那时你能在这里管理按<strong>角色</strong>定义的
          sub-agent（调研 / 代码 / 分析 ...），每个 sub-agent 有自己的身份 prompt、
          工具白名单和私有记忆。现在先不做 informational 的伪入口。
        </p>
        <p className="text-xs text-gray-500 mt-2">
          想调整主 Agent 的 prompts 请走 <Link to="/prompts" className="text-blue-600 hover:underline">Prompts 页面</Link>。
        </p>
      </div>
    </div>
  )
}
