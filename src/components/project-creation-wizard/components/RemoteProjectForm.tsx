import { useCallback, useMemo, useState } from 'react';
import { CheckCircle2, FolderOpen, Loader2, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '../../../shared/view/ui';
import { createRemoteProject, testRemoteConnection } from '../data/workspaceApi';
import type { RemoteAuthType, RemoteProjectFormState } from '../types';
import ErrorBanner from './ErrorBanner';
import RemoteFolderBrowserModal from './RemoteFolderBrowserModal';

type RemoteProjectFormProps = {
  onClose: () => void;
  onProjectCreated?: (project?: Record<string, unknown>) => void;
};

const initialRemoteState: RemoteProjectFormState = {
  customProjectName: '',
  remote_host: '',
  remote_port: '22',
  remote_user: '',
  remote_path: '',
  remote_auth_type: 'key',
  credential: '',
};

const fieldLabelClass =
  'mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300';

export default function RemoteProjectForm({
  onClose,
  onProjectCreated,
}: RemoteProjectFormProps) {
  const { t } = useTranslation();
  const [formState, setFormState] = useState<RemoteProjectFormState>(initialRemoteState);
  const [error, setError] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testSucceeded, setTestSucceeded] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);

  const updateField = useCallback(
    <K extends keyof RemoteProjectFormState>(key: K, value: RemoteProjectFormState[K]) => {
      setFormState((previous) => ({ ...previous, [key]: value }));
      // Any change invalidates a prior successful test.
      setTestSucceeded(false);
    },
    [],
  );

  const portNumber = useMemo(() => Number(formState.remote_port), [formState.remote_port]);

  const validationError = useMemo(() => {
    if (!formState.remote_host.trim()) {
      return t('remoteProject.errors.invalidHost');
    }
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      return t('remoteProject.errors.invalidPort');
    }
    if (!formState.remote_user.trim()) {
      return t('remoteProject.errors.invalidHost');
    }
    // 'agent' auth uses the server's own SSH key/agent: no credential needed.
    if (formState.remote_auth_type !== 'agent' && !formState.credential.trim()) {
      return t('remoteProject.errors.emptyCredential');
    }
    if (!formState.remote_path.trim()) {
      return t('remoteProject.errors.invalidPath');
    }
    return null;
  }, [formState, portNumber, t]);

  const connectionPayload = useMemo(
    () => ({
      remote_host: formState.remote_host.trim(),
      remote_port: portNumber,
      remote_user: formState.remote_user.trim(),
      remote_path: formState.remote_path.trim(),
      remote_auth_type: formState.remote_auth_type,
      // 'agent' auth uses the server's own SSH key/agent: send no credential.
      credential:
        formState.remote_auth_type === 'agent' ? '' : formState.credential,
    }),
    [formState, portNumber],
  );

  const handleTest = useCallback(async () => {
    setError(null);
    setTestSucceeded(false);

    if (validationError) {
      setError(validationError);
      return;
    }

    setIsTesting(true);
    try {
      await testRemoteConnection(connectionPayload);
      setTestSucceeded(true);
    } catch (testError) {
      setError(
        testError instanceof Error
          ? testError.message
          : t('remoteProject.errors.connectionFailed'),
      );
    } finally {
      setIsTesting(false);
    }
  }, [connectionPayload, t, validationError]);

  const handleSave = useCallback(async () => {
    setError(null);

    if (validationError) {
      setError(validationError);
      return;
    }

    if (!testSucceeded) {
      // Encourage a successful test first, but do not hard-block — run it inline.
      setIsSaving(true);
      try {
        await testRemoteConnection(connectionPayload);
        setTestSucceeded(true);
      } catch (testError) {
        setError(
          testError instanceof Error
            ? testError.message
            : t('remoteProject.errors.connectionFailed'),
        );
        setIsSaving(false);
        return;
      }
    } else {
      setIsSaving(true);
    }

    try {
      const project = await createRemoteProject({
        ...connectionPayload,
        customProjectName: formState.customProjectName.trim(),
      });
      onProjectCreated?.(project as Record<string, unknown>);
      onClose();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : t('messages.createProjectFailed'),
      );
    } finally {
      setIsSaving(false);
    }
  }, [
    connectionPayload,
    formState.customProjectName,
    onClose,
    onProjectCreated,
    t,
    testSucceeded,
    validationError,
  ]);

  const handleBrowse = useCallback(() => {
    setError(null);
    if (validationError) {
      setError(validationError);
      return;
    }
    setShowBrowser(true);
  }, [validationError]);

  const busy = isTesting || isSaving;

  return (
    <>
      <div className="space-y-4">
        {error && <ErrorBanner message={error} />}

        <div>
          <label className={fieldLabelClass}>{t('projects.projectNamePlaceholder')}</label>
          <Input
            type="text"
            value={formState.customProjectName}
            onChange={(event) => updateField('customProjectName', event.target.value)}
            placeholder={t('projects.projectNamePlaceholder')}
            className="w-full"
            disabled={busy}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <label className={fieldLabelClass}>{t('remoteProject.host')}</label>
            <Input
              type="text"
              value={formState.remote_host}
              onChange={(event) => updateField('remote_host', event.target.value)}
              placeholder="example.com"
              className="w-full"
              disabled={busy}
            />
          </div>
          <div>
            <label className={fieldLabelClass}>{t('remoteProject.port')}</label>
            <Input
              type="number"
              min={1}
              max={65535}
              value={formState.remote_port}
              onChange={(event) => updateField('remote_port', event.target.value)}
              placeholder="22"
              className="w-full"
              disabled={busy}
            />
          </div>
        </div>

        <div>
          <label className={fieldLabelClass}>{t('remoteProject.user')}</label>
          <Input
            type="text"
            value={formState.remote_user}
            onChange={(event) => updateField('remote_user', event.target.value)}
            placeholder="root"
            className="w-full"
            disabled={busy}
          />
        </div>

        <div>
          <label className={fieldLabelClass}>{t('remoteProject.authType')}</label>
          <div className="flex rounded-lg bg-gray-100 p-0.5 dark:bg-gray-700">
            <button
              type="button"
              onClick={() => updateField('remote_auth_type', 'key' as RemoteAuthType)}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-all ${
                formState.remote_auth_type === 'key'
                  ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-900 dark:text-white'
                  : 'text-gray-500 dark:text-gray-400'
              }`}
              disabled={busy}
            >
              {t('remoteProject.authKey')}
            </button>
            <button
              type="button"
              onClick={() => updateField('remote_auth_type', 'password' as RemoteAuthType)}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-all ${
                formState.remote_auth_type === 'password'
                  ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-900 dark:text-white'
                  : 'text-gray-500 dark:text-gray-400'
              }`}
              disabled={busy}
            >
              {t('remoteProject.authPassword')}
            </button>
            <button
              type="button"
              onClick={() => updateField('remote_auth_type', 'agent' as RemoteAuthType)}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-all ${
                formState.remote_auth_type === 'agent'
                  ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-900 dark:text-white'
                  : 'text-gray-500 dark:text-gray-400'
              }`}
              disabled={busy}
            >
              {t('remoteProject.authAgent')}
            </button>
          </div>
        </div>

        {formState.remote_auth_type !== 'agent' && (
          <div>
            <label className={fieldLabelClass}>
              {formState.remote_auth_type === 'key'
                ? t('remoteProject.pasteKey')
                : t('remoteProject.authPassword')}
            </label>
            {formState.remote_auth_type === 'key' ? (
              <textarea
                value={formState.credential}
                onChange={(event) => updateField('credential', event.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                rows={5}
                spellCheck={false}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                disabled={busy}
              />
            ) : (
              <Input
                type="password"
                value={formState.credential}
                onChange={(event) => updateField('credential', event.target.value)}
                placeholder="••••••••"
                className="w-full"
                autoComplete="new-password"
                disabled={busy}
              />
            )}
          </div>
        )}

        <div>
          <label className={fieldLabelClass}>{t('remoteProject.remotePath')}</label>
          <div className="flex items-center gap-2">
            <Input
              type="text"
              value={formState.remote_path}
              onChange={(event) => updateField('remote_path', event.target.value)}
              placeholder="/home/user/project"
              className="flex-1"
              disabled={busy}
            />
            <Button
              type="button"
              variant="outline"
              onClick={handleBrowse}
              disabled={busy}
            >
              <FolderOpen className="mr-1 h-4 w-4" />
              {t('remoteProject.browse')}
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button type="button" variant="outline" onClick={handleTest} disabled={busy}>
            {isTesting ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : null}
            {t('remoteProject.testConnection')}
          </Button>
          {testSucceeded && !isTesting && (
            <span className="flex items-center gap-1 text-sm text-green-600 dark:text-green-400">
              <CheckCircle2 className="h-4 w-4" />
              {t('remoteProject.success.connectionSuccess')}
            </span>
          )}
          {error && !isTesting && !testSucceeded && (
            <span className="flex items-center gap-1 text-sm text-red-600 dark:text-red-400">
              <XCircle className="h-4 w-4" />
            </span>
          )}
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between border-t border-gray-200 pt-6 dark:border-gray-700">
        <Button variant="outline" onClick={onClose} disabled={busy}>
          {t('remoteProject.cancel')}
        </Button>
        <Button onClick={handleSave} disabled={busy}>
          {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {t('remoteProject.save')}
        </Button>
      </div>

      <RemoteFolderBrowserModal
        isOpen={showBrowser}
        connection={connectionPayload}
        initialPath={formState.remote_path.trim() || '.'}
        onClose={() => setShowBrowser(false)}
        onFolderSelected={(folderPath) => {
          updateField('remote_path', folderPath);
          setShowBrowser(false);
        }}
      />
    </>
  );
}
