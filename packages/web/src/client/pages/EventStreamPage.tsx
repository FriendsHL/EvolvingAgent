import EventStream from '../components/EventStream.js'

export default function EventStreamPage() {
  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-gray-900">Event Stream</h1>
        <p className="text-sm text-gray-500 mt-1">
          Live feed of every agent event across all sessions. Plan steps, tool calls, reflections,
          hooks and errors stream here in real time. Click any row to expand its raw payload.
        </p>
      </div>
      <EventStream height="calc(100vh - 180px)" />
    </div>
  )
}
