import type { HubState } from '../../shared/types.ts';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Yêu cầu thất bại (HTTP ${response.status}).`);
  return body;
}

export function getState(account?: string | null, signal?: AbortSignal): Promise<HubState> {
  return request(`/api/state${account ? `?account=${encodeURIComponent(account)}` : ''}`, { signal });
}

export function saveQuotas(quotas: Record<string, number>, account?: string | null): Promise<{ ok: true }> {
  return request(`/api/quota${account ? `?account=${encodeURIComponent(account)}` : ''}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(quotas),
  });
}

export function removeMachine(machineId: string): Promise<{ ok: true }> {
  return request(`/api/machines/${encodeURIComponent(machineId)}`, { method: 'DELETE' });
}
