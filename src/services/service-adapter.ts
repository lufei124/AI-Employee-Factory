export type ServiceState = 'running' | 'stopped' | 'not-installed' | 'error';

export interface ServiceStatus {
  state: ServiceState;
  detail?: string;
}

export interface ServiceAdapter {
  install(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<ServiceStatus>;
  uninstall(): Promise<void>;
}
