import { requestUrl } from 'obsidian';
import { TICKTICK_API_BASE } from './constants';
import { TickTickProject, TickTickTaskPayload, TickTickTaskSummary } from './types';

export class TickTickClient {
  private getAccessToken: () => Promise<string>;
  private refreshIfNeeded: () => Promise<void>;

  constructor(args: { getAccessToken: () => Promise<string>; refreshIfNeeded: () => Promise<void> }) {
    this.getAccessToken = args.getAccessToken;
    this.refreshIfNeeded = args.refreshIfNeeded;
  }

  private async request<T>(path: string, method: string = 'GET', body?: unknown): Promise<T> {
    const doRequest = async () => {
      const token = await this.getAccessToken();
      return requestUrl({
        url: `${TICKTICK_API_BASE}${path}`,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        throw: false,
      });
    };

    let res = await doRequest();

    // one retry after refresh on 401
    if (res.status === 401) {
      await this.refreshIfNeeded();
      res = await doRequest();
    }

    if (res.status < 200 || res.status >= 300) {
      console.error('[TickTick Flow Sync] API error:', method, path, res.status, res.text);
      const detail = (res.text || '').slice(0, 180).replace(/\s+/g, ' ').trim();
      throw new Error(`TickTick API ${method} ${path} failed (${res.status})${detail ? `: ${detail}` : ''}`);
    }

    return (res.json ?? {}) as T;
  }

  async listProjects(): Promise<TickTickProject[]> {
    const projects = await this.request<TickTickProject[]>('/open/v1/project', 'GET');
    return (projects ?? []).filter((p) => !p.closed);
  }

  async createTask(payload: TickTickTaskPayload): Promise<{ id: string; projectId: string }> {
    return this.request<{ id: string; projectId: string }>('/open/v1/task', 'POST', payload);
  }

  async updateTask(taskId: string, payload: TickTickTaskPayload): Promise<{ id: string; projectId: string }> {
    const body: TickTickTaskPayload = {
      ...payload,
      id: taskId,
    };
    return this.request<{ id: string; projectId: string }>(`/open/v1/task/${encodeURIComponent(taskId)}`, 'POST', body);
  }

  async getTask(projectId: string, taskId: string): Promise<TickTickTaskSummary> {
    return this.request<TickTickTaskSummary>(
      `/open/v1/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`,
      'GET',
    );
  }

  async listProjectTasks(projectId: string): Promise<TickTickTaskSummary[]> {
    const data = await this.request<{ tasks?: TickTickTaskSummary[] }>(
      `/open/v1/project/${encodeURIComponent(projectId)}/data`,
      'GET',
    );
    return Array.isArray(data?.tasks) ? data.tasks : [];
  }

  async completeTask(projectId: string, taskId: string): Promise<void> {
    try {
      await this.request(
        `/open/v1/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}/complete`,
        'POST',
        {},
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // TickTick complete endpoint can return empty body; some clients surface JSON parse error even when completion succeeded.
      if (msg.toLowerCase().includes('unexpected end of json input')) {
        console.warn('[TickTick Flow Sync] Ignoring empty-body JSON parse error from complete endpoint', { projectId, taskId });
        return;
      }
      throw e;
    }
  }

  async listKnownTags(maxProjects: number = 25): Promise<string[]> {
    const projects = await this.listProjects();
    const tags = new Set<string>();

    for (const p of projects.slice(0, Math.max(1, maxProjects))) {
      try {
        const data = await this.request<{ tasks?: Array<{ tags?: string[] }> }>(
          `/open/v1/project/${encodeURIComponent(p.id)}/data`,
          'GET',
        );
        const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
        for (const t of tasks) {
          const taskTags = Array.isArray(t?.tags) ? t.tags : [];
          for (const tag of taskTags) {
            const normalized = String(tag || '').trim();
            if (normalized) tags.add(normalized);
          }
        }
      } catch {
        // best-effort suggestions only
      }
    }

    return Array.from(tags).sort((a, b) => a.localeCompare(b));
  }
}
