import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { getConnection } from '@/modules/database/connection.js';
import type {
    CreateProjectPathResult,
    ProjectRepositoryRow,
    RemoteAuthType,
} from '@/shared/types.js';
import { normalizeProjectPath } from '@/shared/utils.js';

/**
 * Input payload for inserting a remote (SSH) project row.
 *
 * `credentialRef` references the stored `user_credentials` id holding the
 * decryptable secret; the secret itself is never stored on the project row.
 */
export type CreateRemoteProjectInput = {
    customProjectName: string | null;
    host: string;
    port: number;
    user: string;
    remotePath: string;
    authType: RemoteAuthType;
    /** `null` for `authType === 'agent'` (no stored credential). */
    credentialRef: string | null;
};

const REMOTE_PROJECT_COLUMNS =
    'project_id, project_path, custom_project_name, isStarred, isArchived, group_id, ' +
    'project_type, remote_host, remote_port, remote_user, remote_path, remote_auth_type, remote_credential_ref';

function normalizeProjectDisplayName(projectPath: string, customProjectName: string | null): string {
    const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
    if (trimmedCustomName.length > 0) {
        return trimmedCustomName;
    }

    const directoryName = path.basename(projectPath);
    return directoryName || projectPath;
}

export const projectsDb = {
    createProjectPath(projectPath: string, customProjectName: string | null = null): CreateProjectPathResult {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const normalizedProjectName = normalizeProjectDisplayName(normalizedProjectPath, customProjectName);
        const attemptedId = randomUUID();
        const row = db.prepare(`
        INSERT INTO projects (project_id, project_path, custom_project_name, isArchived)
            VALUES (?, ?, ?, 0)
            ON CONFLICT(project_path) DO UPDATE SET
            isArchived = 0
            WHERE projects.isArchived = 1
            RETURNING project_id, project_path, custom_project_name, isStarred, isArchived, group_id
        `).get(attemptedId, normalizedProjectPath, normalizedProjectName) as ProjectRepositoryRow | undefined;

        if (row) {
            return {
                outcome: row.project_id === attemptedId ? 'created' : 'reactivated_archived',
                project: row,
            };
        }

        const existingProject = projectsDb.getProjectPath(normalizedProjectPath);
        return {
            outcome: 'active_conflict',
            project: existingProject,
        };
    },

    getProjectPath(projectPath: string): ProjectRepositoryRow | null {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, group_id
            FROM projects
            WHERE project_path = ?
        `).get(normalizedProjectPath) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    getProjectById(projectId: string): ProjectRepositoryRow | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT ${REMOTE_PROJECT_COLUMNS}
            FROM projects
            WHERE project_id = ?
        `).get(projectId) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    /**
     * Inserts a new `project_type = 'remote'` row and returns it.
     *
     * The synthetic `project_path` (`ssh://user@host:port/remotePath`) keeps the
     * UNIQUE path constraint meaningful for remote workspaces, and the project id
     * is derived deterministically from that key so the same remote target maps
     * to a stable id. Throws on a UNIQUE conflict (duplicate remote project).
     */
    createRemoteProject(input: CreateRemoteProjectInput): ProjectRepositoryRow {
        const db = getConnection();
        const syntheticPath = `ssh://${input.user}@${input.host}:${input.port}${
            input.remotePath.startsWith('/') ? input.remotePath : `/${input.remotePath}`
        }`;
        const projectId = createHash('sha256').update(syntheticPath).digest('hex').slice(0, 32);
        const displayName = normalizeProjectDisplayName(input.remotePath, input.customProjectName);

        const row = db.prepare(`
            INSERT INTO projects (
                project_id, project_path, custom_project_name, isArchived,
                project_type, remote_host, remote_port, remote_user, remote_path,
                remote_auth_type, remote_credential_ref
            )
            VALUES (?, ?, ?, 0, 'remote', ?, ?, ?, ?, ?, ?)
            RETURNING ${REMOTE_PROJECT_COLUMNS}
        `).get(
            projectId,
            syntheticPath,
            displayName,
            input.host,
            input.port,
            input.user,
            input.remotePath,
            input.authType,
            input.credentialRef
        ) as ProjectRepositoryRow;

        return row;
    },

    /**
     * Updates the `remote_*` connection columns for an existing remote project
     * row and returns the refreshed row (or null when no row matched / the row is
     * not remote).
     */
    updateRemoteProject(
        projectId: string,
        fields: { host: string; port: number; user: string; remotePath: string }
    ): ProjectRepositoryRow | null {
        const db = getConnection();
        const row = db.prepare(`
            UPDATE projects
            SET remote_host = ?, remote_port = ?, remote_user = ?, remote_path = ?
            WHERE project_id = ? AND project_type = 'remote'
            RETURNING ${REMOTE_PROJECT_COLUMNS}
        `).get(
            fields.host,
            fields.port,
            fields.user,
            fields.remotePath,
            projectId
        ) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    /**
     * Counts how many project rows reference the given credential id. Used before
     * deleting a credential so a shared credential is not removed while another
     * remote project still depends on it.
     */
    countProjectsByCredentialRef(credentialRef: string): number {
        const db = getConnection();
        const row = db.prepare(`
            SELECT COUNT(*) AS count
            FROM projects
            WHERE remote_credential_ref = ?
        `).get(credentialRef) as { count: number };

        return row.count;
    },

    /**
     * Resolve the absolute project directory from a database project_id.
     *
     * This is the canonical lookup used after the projectName → projectId migration:
     * API routes receive the DB-assigned `projectId` and must resolve the real folder
     * path through this helper before touching the filesystem. Returns `null` when the
     * project row does not exist so callers can respond with a 404.
     */
    getProjectPathById(projectId: string): string | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_path
            FROM projects
            WHERE project_id = ?
        `).get(projectId) as Pick<ProjectRepositoryRow, 'project_path'> | undefined;

        return row?.project_path ?? null;
    },

    getProjectPaths(): ProjectRepositoryRow[] {
        const db = getConnection();
        return db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, group_id,
                   project_type, remote_host, remote_port, remote_user, remote_path
            FROM projects
            WHERE isArchived = 0
        `).all() as ProjectRepositoryRow[];
    },

    /**
     * Archived rows are queried separately so archive-focused UIs can present
     * hidden workspaces without reintroducing them into the active sidebar list.
     */
    getArchivedProjectPaths(): ProjectRepositoryRow[] {
        const db = getConnection();
        return db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, group_id,
                   project_type, remote_host, remote_port, remote_user, remote_path
            FROM projects
            WHERE isArchived = 1
        `).all() as ProjectRepositoryRow[];
    },

    getCustomProjectName(projectPath: string): string | null {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT custom_project_name
            FROM projects
            WHERE project_path = ?
        `).get(normalizedProjectPath) as Pick<ProjectRepositoryRow, 'custom_project_name'> | undefined;

        return row?.custom_project_name ?? null;
    },

    updateCustomProjectName(projectPath: string, customProjectName: string | null): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            INSERT INTO projects (project_id, project_path, custom_project_name)
            VALUES (?, ?, ?)
            ON CONFLICT(project_path) DO UPDATE SET custom_project_name = excluded.custom_project_name
        `).run(randomUUID(), normalizedProjectPath, customProjectName);
    },

    updateCustomProjectNameById(projectId: string, customProjectName: string | null): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET custom_project_name = ?
            WHERE project_id = ?
        `).run(customProjectName, projectId);
    },

    updateProjectIsStarred(projectPath: string, isStarred: boolean): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            UPDATE projects
            SET isStarred = ?
            WHERE project_path = ?
        `).run(isStarred ? 1 : 0, normalizedProjectPath);
    },

    updateProjectIsStarredById(projectId: string, isStarred: boolean): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET isStarred = ?
            WHERE project_id = ?
        `).run(isStarred ? 1 : 0, projectId);
    },

    updateProjectIsArchived(projectPath: string, isArchived: boolean): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            UPDATE projects
            SET isArchived = ?
            WHERE project_path = ?
        `).run(isArchived ? 1 : 0, normalizedProjectPath);
    },

    updateProjectIsArchivedById(projectId: string, isArchived: boolean): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET isArchived = ?
            WHERE project_id = ?
        `).run(isArchived ? 1 : 0, projectId);
    },

    deleteProjectPath(projectPath: string): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            DELETE FROM projects
            WHERE project_path = ?
        `).run(normalizedProjectPath);
    },

    deleteProjectById(projectId: string): void {
        const db = getConnection();
        db.prepare(`
            DELETE FROM projects
            WHERE project_id = ?
        `).run(projectId);
    },
};
