import { requestUrl } from 'obsidian';
import { TICKTICK_API_BASE } from './constants';
import { TickTickProject, TickTickTaskPayload } from './types';

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

  async completeTask(projectId: string, taskId: string): Promise<void> {
    await this.request(
      `/open/v1/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}/complete`,
      'POST',
      {},
    );
  }
}
