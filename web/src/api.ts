export interface DashboardData {
  total: number;
  running: number;
  pendingAuthorization: number;
  archived: number;
  agents: Array<{
    id: string;
    name: string;
    status: string;
    archived: boolean;
    runtime: 'claude' | 'codex' | 'unknown';
    bridgeEnabled: boolean;
    bridgeAuthorization: string;
    updatedAt: string;
  }>;
}

export interface CreateAgentRequest {
  id: string;
  name: string;
  runtime: 'claude' | 'codex';
  feishu: 'dedicated' | 'disabled';
  description?: string;
  goals?: string[];
  responsibilities?: string[];
  policies?: string[];
  escalation_conditions?: string[];
  skills?: string[];
  model?: string;
}

export interface GeneratedProfile {
  id?: string;
  name: string;
  description: string;
  goals: string[];
  responsibilities: string[];
  policies: string[];
  escalation_conditions: string[];
  skills: string[];
}

export interface OperationDto {
  id: string;
  type: string;
  agentId?: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress?: number;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  error?: { code: string; message: string; remediation?: string };
}

export interface AgentDocument {
  key: string;
  path: string;
  content: string;
  dirty: boolean;
}

export interface TrashEntry {
  trashId: string;
  agentId: string;
  name: string;
  deletedAt: string;
  expiresAt: string;
  remainingDays: number;
  state: 'moving' | 'ready' | 'restoring' | 'purging' | 'failed';
}

export interface JobConfig {
  schema_version: 1;
  id: string;
  enabled: boolean;
  managed_by: 'admin' | 'employee';
  schedule: { type: 'daily'; time: string };
  execution:
    | {
        type: 'script';
        script_file: string;
        interpreter: 'node' | 'bash' | 'direct';
        args: string[];
        timeout_seconds: number;
        concurrency: 'forbid';
      }
    | {
        type: 'agent';
        prompt_file: string;
        timeout_seconds: number;
        concurrency: 'forbid';
        precheck?: {
          script_file: string;
          interpreter: 'node' | 'bash' | 'direct';
          args: string[];
          no_data_exit_code: number;
        };
      };
}

export interface AgentDetail {
  registry: {
    id: string;
    name: string;
    role: 'worker' | 'chief';
    status: 'stopped' | 'running' | 'error' | 'archived';
    archived: boolean;
    runtime_home: { path: string };
    bridge: {
      enabled: boolean;
      authorization: 'pending' | 'ready' | 'error';
      home: string;
    };
  };
  agent: {
    description: string;
    runtime: { provider: 'claude' | 'codex'; locked: true; model?: string };
  };
}

export type SkillScope = 'project' | 'user';

export interface SkillMetadata {
  name: string;
  version: string;
  source: string;
  installed_at: string;
  digest: string;
  scope: SkillScope;
}

export interface StoreRepository {
  name: string;
  url: string;
  description?: string;
  cached: boolean;
  lastRefreshedAt?: string;
}

export interface StoreSkill {
  name: string;
  description: string;
  version: string;
  path: string;
  repository: string;
}

let csrfToken = '';

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !(init.body instanceof FormData)) {
    headers.set('content-type', 'application/json');
  }
  if (init.method && init.method !== 'GET') headers.set('x-csrf-token', csrfToken);
  const response = await fetch(`/api/v1${url}`, { ...init, headers });
  const payload = (await response.json()) as {
    data?: T;
    error?: { message: string; remediation?: string };
  };
  if (!response.ok || payload.data === undefined) {
    throw new Error(
      `${payload.error?.message ?? `请求失败 (${response.status})`}${payload.error?.remediation ? `\n${payload.error.remediation}` : ''}`,
    );
  }
  return payload.data;
}

export async function initializeWebSession(): Promise<void> {
  const match = window.location.hash.match(/^#session=([^&]+)/);
  if (match?.[1]) {
    const token = decodeURIComponent(match[1]);
    const result = await request<{ csrfToken: string }>('/session', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    csrfToken = result.csrfToken;
    window.history.replaceState(null, '', `${window.location.pathname}#/`);
    return;
  }
  const result = await request<{ csrfToken: string }>('/session');
  csrfToken = result.csrfToken;
}

export const api = {
  factoryStatus: () => request<{ initialized: boolean }>('/factory/status'),
  initializeFactory: () => request<{ initialized: boolean }>('/factory/init', { method: 'POST' }),
  dashboard: () => request<DashboardData>('/dashboard'),
  listAgents: () => request<DashboardData['agents']>('/agents'),
  createAgent: (input: CreateAgentRequest) =>
    request<{ id: string; workspace: string }>('/agents', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  generateEmployeeProfile: (brief: string) =>
    request<GeneratedProfile>('/agents/generate', {
      method: 'POST',
      body: JSON.stringify({ brief }),
    }),
  getAgent: (id: string) => request<AgentDetail>(`/agents/${encodeURIComponent(id)}`),
  terminalGuidance: (id: string) =>
    request<{ runtimeLogin: string; bridgeAuthorize: string; chat: string }>(
      `/agents/${encodeURIComponent(id)}/terminal-guidance`,
    ),
  listDocuments: (id: string) =>
    request<Record<string, unknown>>(`/agents/${encodeURIComponent(id)}/documents`),
  lifecycle: (
    id: string,
    action: 'start' | 'stop' | 'restart' | 'status' | 'archive',
    confirmId?: string,
  ) =>
    request<{ state: string }>(`/agents/${encodeURIComponent(id)}/actions/${action}`, {
      method: 'POST',
      body: JSON.stringify(action === 'archive' ? { confirmId } : {}),
    }),
  trashAgent: (id: string) =>
    request<TrashEntry>(`/agents/${encodeURIComponent(id)}/actions/trash`, {
      method: 'POST',
      body: JSON.stringify({ confirmId: id }),
    }),
  listTrash: () => request<TrashEntry[]>('/trash'),
  restoreTrash: (trashId: string) =>
    request<{ restored: boolean; trashId: string }>(
      `/trash/${encodeURIComponent(trashId)}/actions/restore`,
      {
        method: 'POST',
        body: JSON.stringify({ confirmTrashId: trashId }),
      },
    ),
  readDocument: (id: string, key: string) =>
    request<AgentDocument>(`/agents/${encodeURIComponent(id)}/documents/${key}`),
  saveDocument: (id: string, key: string, content: string) =>
    request<AgentDocument>(`/agents/${encodeURIComponent(id)}/documents/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),
  listJobs: (id: string) => request<JobConfig[]>(`/agents/${encodeURIComponent(id)}/jobs`),
  listSkills: (id: string) => request<SkillMetadata[]>(`/agents/${encodeURIComponent(id)}/skills`),
  uploadSkill: (id: string, files: File[], scope?: SkillScope) => {
    const data = new FormData();
    for (const file of files) {
      const relative =
        (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      data.append('files', file, relative);
    }
    if (scope) data.append('scope', scope);
    return request<{ name: string; version: string; scope: SkillScope }>(
      `/agents/${encodeURIComponent(id)}/skills/upload`,
      {
        method: 'POST',
        body: data,
      },
    );
  },
  removeSkill: (id: string, name: string, scope?: SkillScope) =>
    request<{ removed: boolean; scope: SkillScope }>(
      `/agents/${encodeURIComponent(id)}/skills/${encodeURIComponent(name)}`,
      {
        method: 'DELETE',
        body: JSON.stringify({ confirmName: name, ...(scope ? { scope } : {}) }),
      },
    ),
  listSkillStoreRepositories: () => request<StoreRepository[]>('/skill-store/repositories'),
  addSkillStoreRepository: (input: { name: string; url: string; description?: string }) =>
    request<StoreRepository>('/skill-store/repositories', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  removeSkillStoreRepository: (name: string) =>
    request<{ removed: boolean }>(`/skill-store/repositories/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmName: name }),
    }),
  refreshSkillStoreRepository: (name: string) =>
    request<StoreRepository>(`/skill-store/repositories/${encodeURIComponent(name)}/refresh`, {
      method: 'POST',
    }),
  listSkillStoreSkills: (name: string) =>
    request<StoreSkill[]>(`/skill-store/repositories/${encodeURIComponent(name)}/skills`),
  installSkillFromStore: (input: {
    repoName: string;
    skillPath: string;
    agentId: string;
    scope?: SkillScope;
  }) =>
    request<SkillMetadata>('/skill-store/install', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  installAllSkillFromStore: (input: { repoName: string; agentId: string; scope?: SkillScope }) =>
    request<{ total: number; installed: SkillMetadata[]; skipped: string[]; failed: string[] }>(
      '/skill-store/install-all',
      { method: 'POST', body: JSON.stringify(input) },
    ),
  latestLog: (id: string, lines = 200) =>
    request<{ file: string; content: string }>(
      `/agents/${encodeURIComponent(id)}/logs?lines=${lines}`,
    ),
  listBackups: () =>
    request<Array<{ name: string; size: number; modifiedAt: string; encrypted: boolean }>>(
      '/backups',
    ),
  importBackup: (file: File) => {
    const data = new FormData();
    data.append('backup', file, file.name);
    return request<{ name: string; size: number; encrypted: boolean }>('/backups/import', {
      method: 'POST',
      body: data,
    });
  },
  backupDownloadUrl: (name: string) => `/api/v1/backups/${encodeURIComponent(name)}/download`,
  createBackup: (id: string, includeRuntime = false, passphrase?: string) =>
    request<OperationDto>(`/agents/${encodeURIComponent(id)}/backup`, {
      method: 'POST',
      body: JSON.stringify({ includeRuntime, ...(passphrase ? { passphrase } : {}) }),
    }),
  restoreBackup: (input: { name: string; newId?: string; newName?: string; passphrase?: string }) =>
    request<OperationDto>('/backups/restore', {
      method: 'POST',
      body: JSON.stringify({ ...input, confirmName: input.name }),
    }),
  runDoctor: (id?: string) =>
    request<OperationDto>(id ? `/agents/${encodeURIComponent(id)}/doctor` : '/doctor', {
      method: 'POST',
    }),
  listOperations: () => request<OperationDto[]>('/operations'),
  operation: (id: string) => request<OperationDto>(`/operations/${id}`),
  operationEvents: (id: string, after = 0) =>
    request<Array<{ seq: number; kind: string; message?: string; progress?: number }>>(
      `/operations/${id}/events?after=${after}`,
    ),
};
