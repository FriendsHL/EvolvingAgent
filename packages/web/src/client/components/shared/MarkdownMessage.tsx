/**
 * Markdown renderer for chat assistant messages.
 *
 * Thin wrapper around react-markdown + remark-gfm. Custom components keep
 * the rendered output visually consistent with the existing gray bubble
 * (no heavy prose styles — the chat area is narrow). Code blocks get a
 * light background and monospace font; inline code gets a subtle pill.
 */
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'

const components: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-5 mb-2 last:mb-0 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 last:mb-0 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => <h1 className="text-base font-semibold mb-2 mt-3 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="text-sm font-semibold mb-2 mt-3 first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold mb-1.5 mt-2 first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="text-xs font-semibold mb-1 mt-2 first:mt-0 uppercase tracking-wide text-gray-500">{children}</h4>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline break-all">
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-gray-300 pl-3 text-gray-600 italic my-2">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-gray-200" />,
  code: ({ inline, className, children }: {
    inline?: boolean
    className?: string
    children?: React.ReactNode
  }) => {
    if (inline) {
      return (
        <code className="bg-gray-200/70 rounded px-1 py-0.5 text-[12px] font-mono break-words">
          {children}
        </code>
      )
    }
    return (
      <code className={`block font-mono text-[12px] ${className ?? ''}`}>
        {children}
      </code>
    )
  },
  pre: ({ children }) => (
    <pre className="bg-gray-900 text-gray-100 rounded-lg p-3 my-2 overflow-x-auto text-[12px] leading-relaxed">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="text-xs border-collapse">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-gray-300 bg-gray-100 px-2 py-1 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border border-gray-300 px-2 py-1">{children}</td>,
}

export default function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
