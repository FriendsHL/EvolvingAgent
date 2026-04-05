const BASE = '/api'

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`API ${res.status}: ${body}`)
  }
  return res.json()
}

export function apiGet<T>(path: string): Promise<T> {
  return api<T>(path)
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined })
}

export function apiPut<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'PUT', body: JSON.stringify(body) })
}

export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined })
}

export function apiDelete<T>(path: string): Promise<T> {
  return api<T>(path, { method: 'DELETE' })
}
