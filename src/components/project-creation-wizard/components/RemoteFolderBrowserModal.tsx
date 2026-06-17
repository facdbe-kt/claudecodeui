import { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderOpen, FolderPlus, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../shared/view/ui';
import { browseRemoteFolders } from '../data/workspaceApi';
import type { RemoteAuthType, RemoteBrowseEntry } from '../types';

type RemoteFolderBrowserModalProps = {
  isOpen: boolean;
  connection: {
    remote_host: string;
    remote_port: number;
    remote_user: string;
    remote_path: string;
    remote_auth_type: RemoteAuthType;
    credential: string;
  };
  initialPath: string;
  onClose: () => void;
  onFolderSelected: (folderPath: string) => void;
};

// Resolve the parent of a POSIX-style remote path. Returns null at the root.
const getRemoteParentPath = (currentPath: string): string | null => {
  if (!currentPath || currentPath === '/') {
    return null;
  }
  const normalized = currentPath.replace(/\/+$/, '');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) {
    return '/';
  }
  return normalized.slice(0, lastSlash);
};

const joinRemotePath = (base: string, name: string): string => {
  if (base === '/') {
    return `/${name}`;
  }
  return `${base.replace(/\/+$/, '')}/${name}`;
};

export default function RemoteFolderBrowserModal({
  isOpen,
  connection,
  initialPath,
  onClose,
  onFolderSelected,
}: RemoteFolderBrowserModalProps) {
  const { t } = useTranslation();
  const [currentPath, setCurrentPath] = useState(initialPath || '.');
  const [entries, setEntries] = useState<RemoteBrowseEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFolders = useCallback(
    async (pathToLoad: string) => {
      setLoading(true);
      setError(null);

      try {
        const result = await browseRemoteFolders({
          remote_host: connection.remote_host,
          remote_port: connection.remote_port,
          remote_user: connection.remote_user,
          remote_path: connection.remote_path,
          remote_auth_type: connection.remote_auth_type,
          credential: connection.credential,
          browsePath: pathToLoad,
        });
        setCurrentPath(result.path);
        setEntries(result.entries);
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : t('remoteProject.errors.connectionFailed'),
        );
      } finally {
        setLoading(false);
      }
    },
    [connection, t],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    loadFolders(initialPath || '.');
    // Only re-run when the modal opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Directories first, then files; alphabetical within each group.
  const sortedEntries = useMemo(
    () =>
      [...entries].sort((first, second) => {
        if (first.isDirectory !== second.isDirectory) {
          return first.isDirectory ? -1 : 1;
        }
        return first.name.toLowerCase().localeCompare(second.name.toLowerCase());
      }),
    [entries],
  );

  const parentPath = getRemoteParentPath(currentPath);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/50">
              <FolderOpen className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {t('remoteProject.selectFolder')}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && (
          <div className="px-4 pt-3">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
            </div>
          ) : (
            <div className="space-y-1">
              {parentPath && (
                <button
                  onClick={() => loadFolders(parentPath)}
                  className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <FolderOpen className="h-5 w-5 text-gray-400" />
                  <span className="font-medium text-gray-700 dark:text-gray-300">..</span>
                </button>
              )}

              {sortedEntries.length === 0 ? (
                <div className="py-8 text-center text-gray-500 dark:text-gray-400">
                  {t('projects.noProjects')}
                </div>
              ) : (
                sortedEntries.map((entry) =>
                  entry.isDirectory ? (
                    <button
                      key={entry.name}
                      onClick={() => loadFolders(joinRemotePath(currentPath, entry.name))}
                      className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      <FolderPlus className="h-5 w-5 text-blue-500" />
                      <span className="font-medium text-gray-900 dark:text-white">{entry.name}</span>
                    </button>
                  ) : (
                    <div
                      key={entry.name}
                      className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left opacity-60"
                    >
                      <FolderOpen className="h-5 w-5 text-gray-300 dark:text-gray-600" />
                      <span className="text-gray-500 dark:text-gray-400">{entry.name}</span>
                    </div>
                  ),
                )
              )}
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2 bg-gray-50 px-4 py-3 dark:bg-gray-900/50">
            <span className="text-sm text-gray-600 dark:text-gray-400">{t('remoteProject.remotePath')}:</span>
            <code className="flex-1 truncate font-mono text-sm text-gray-900 dark:text-white">
              {currentPath}
            </code>
          </div>
          <div className="flex items-center justify-end gap-2 p-4">
            <Button variant="outline" onClick={onClose}>
              {t('remoteProject.cancel')}
            </Button>
            <Button variant="outline" onClick={() => onFolderSelected(currentPath)}>
              {t('remoteProject.selectFolder')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
