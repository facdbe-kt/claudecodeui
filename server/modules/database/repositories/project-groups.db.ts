import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

export type ProjectGroupRow = {
  group_id: string;
  group_name: string;
  sort_order: number;
  color: string | null;
};

export const projectGroupsDb = {
  createGroup(groupName: string, color: string | null = null): ProjectGroupRow {
    const db = getConnection();
    const groupId = randomUUID();
    const maxOrder = db.prepare(`
      SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order
      FROM project_groups
    `).get() as { next_order: number };

    db.prepare(`
      INSERT INTO project_groups (group_id, group_name, sort_order, color)
      VALUES (?, ?, ?, ?)
    `).run(groupId, groupName.trim(), maxOrder.next_order, color);

    return { group_id: groupId, group_name: groupName.trim(), sort_order: maxOrder.next_order, color };
  },

  getAllGroups(): ProjectGroupRow[] {
    const db = getConnection();
    return db.prepare(`
      SELECT group_id, group_name, sort_order, color
      FROM project_groups
      ORDER BY sort_order ASC
    `).all() as ProjectGroupRow[];
  },

  getGroupById(groupId: string): ProjectGroupRow | null {
    const db = getConnection();
    const row = db.prepare(`
      SELECT group_id, group_name, sort_order, color
      FROM project_groups
      WHERE group_id = ?
    `).get(groupId) as ProjectGroupRow | undefined;

    return row ?? null;
  },

  renameGroup(groupId: string, newName: string): void {
    const db = getConnection();
    db.prepare(`
      UPDATE project_groups
      SET group_name = ?
      WHERE group_id = ?
    `).run(newName.trim(), groupId);
  },

  setGroupColor(groupId: string, color: string | null): void {
    const db = getConnection();
    db.prepare(`
      UPDATE project_groups
      SET color = ?
      WHERE group_id = ?
    `).run(color, groupId);
  },

  deleteGroup(groupId: string): void {
    const db = getConnection();
    // Unassign all projects in this group first
    db.prepare(`
      UPDATE projects
      SET group_id = NULL
      WHERE group_id = ?
    `).run(groupId);

    db.prepare(`
      DELETE FROM project_groups
      WHERE group_id = ?
    `).run(groupId);
  },

  assignProjectToGroup(projectId: string, groupId: string | null): void {
    const db = getConnection();
    db.prepare(`
      UPDATE projects
      SET group_id = ?
      WHERE project_id = ?
    `).run(groupId, projectId);
  },

  getProjectsByGroup(groupId: string): string[] {
    const db = getConnection();
    const rows = db.prepare(`
      SELECT project_id
      FROM projects
      WHERE group_id = ?
    `).all(groupId) as Array<{ project_id: string }>;

    return rows.map(r => r.project_id);
  },
};
