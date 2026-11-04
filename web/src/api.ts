import type { HubState } from '../../shared/types.ts';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Yêu cầu thất bại (HTTP ${response.status}).`);
  return body;
}

export function getState(signal?: AbortSignal): Promise<HubState> {
  return request('/api/state', { signal });
}

export function saveQuotas(quotas: Record<string, number>): Promise<{ ok: true }> {
  return request('/api/quota', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(quotas),
  });
}

export function removeMachine(machineId: string): Promise<{ ok: true }> {
  return request(`/api/machines/${encodeURIComponent(machineId)}`, { method: 'DELETE' });
}

export function saveResetSchedule(dayOfWeek: number, time: string): Promise<{ resetSchedule: unknown }> {
  return request('/api/reset-schedule', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dayOfWeek, time }),
  });
}
