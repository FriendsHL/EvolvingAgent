import EventStream from '../components/EventStream.js'

export default function EventStreamPage() {
  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-gray-900">事件流</h1>
        <p className="text-sm text-gray-500 mt-1">
          所有 session 的 agent 事件的实时 feed。规划步骤、工具调用、反思、钩子和错误会实时出现在这里。点击任意行展开原始 payload。
        </p>
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2.5 text-xs text-blue-900 mt-2">
          <strong>事件会自动持久化</strong>：每个 session 的事件被写入
          <code className="mx-1">data/events/&lt;sessionId&gt;.jsonl</code>，
          可通过 <code className="mx-1">GET /api/sessions/:id/events</code> 回溯任意 session 的完整事件历史。
        </div>
      </div>
      <EventStream height="calc(100vh - 210px)" />
    </div>
  )
}
