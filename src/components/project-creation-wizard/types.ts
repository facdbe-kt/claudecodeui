export type WizardStep = 1 | 2;

export type TokenMode = 'stored' | 'new' | 'none';

export type FolderSuggestion = {
  name: string;
  path: string;
  type?: string;
};

export type GithubTokenCredential = {
  id: number;
  credential_name: string;
  is_active: boolean;
};

export type CredentialsResponse = {
  credentials?: GithubTokenCredential[];
  error?: string;
};

export type BrowseFilesystemResponse = {
  path?: string;
  suggestions?: FolderSuggestion[];
  error?: string;
};

export type CreateFolderResponse = {
  success?: boolean;
  path?: string;
  error?: string;
  details?: string;
};

export type CreateProjectPayload = {
  path: string;
  customName?: string;
};

export type CreateProjectApiError = {
  code?: string;
  message?: string;
  details?: unknown;
};

export type CreateProjectResponse = {
  success?: boolean;
  project?: Record<string, unknown>;
  error?: string | CreateProjectApiError;
  details?: string;
  message?: string;
};

export type CloneProgressEvent = {
  type?: string;
  message?: string;
  project?: Record<string, unknown>;
};

export type WizardFormState = {
  workspacePath: string;
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
};

export type ProjectKind = 'local' | 'remote';

export type RemoteAuthType = 'key' | 'password';

export type RemoteProjectFormState = {
  customProjectName: string;
  remote_host: string;
  remote_port: string;
  remote_user: string;
  remote_path: string;
  remote_auth_type: RemoteAuthType;
  credential: string;
};

export type RemoteTestResponse = {
  ok?: boolean;
  error?: string;
};

export type RemoteBrowseEntry = {
  name: string;
  isDirectory: boolean;
};

export type RemoteBrowseResponse = {
  path?: string;
  entries?: RemoteBrowseEntry[];
  error?: string;
};

export type RemoteCreateResponse = {
  success?: boolean;
  project?: Record<string, unknown>;
  error?: string | { message?: string };
  details?: string;
  message?: string;
};
