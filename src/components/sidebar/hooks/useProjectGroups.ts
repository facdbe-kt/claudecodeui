import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { ProjectGroup } from '../../../types/app';

type ApiResponse<T> = {
  success: boolean;
  data: T;
};

export function useProjectGroups() {
  const [groups, setGroups] = useState<ProjectGroup[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('expandedProjectGroups');
      return stored ? new Set(JSON.parse(stored) as string[]) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });

  const fetchGroups = useCallback(async () => {
    try {
      const response = await authenticatedFetch('/api/projects/groups');
      if (!response.ok) return;
      const data = (await response.json()) as ApiResponse<{ groups: ProjectGroup[] }>;
      setGroups(data.data?.groups ?? []);
    } catch (error) {
      console.error('Error fetching project groups:', error);
    }
  }, []);

  useEffect(() => {
    void fetchGroups();
  }, [fetchGroups]);

  const createGroup = useCallback(async (name: string, color?: string | null): Promise<ProjectGroup | null> => {
    try {
      const response = await authenticatedFetch('/api/projects/groups', {
        method: 'POST',
        body: JSON.stringify({ name, color }),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as ApiResponse<{ group: ProjectGroup }>;
      const group = data.data?.group;
      if (group) {
        setGroups((prev) => [...prev, group]);
        // Auto-expand new group
        setExpandedGroups((prev) => {
          const next = new Set(Array.from(prev));
          next.add(group.group_id);
          try { localStorage.setItem('expandedProjectGroups', JSON.stringify(Array.from(next))); } catch { /* ignore */ }
          return next;
        });
      }
      return group ?? null;
    } catch (error) {
      console.error('Error creating group:', error);
      return null;
    }
  }, []);

  const renameGroup = useCallback(async (groupId: string, name: string) => {
    try {
      const response = await authenticatedFetch(`/api/projects/groups/${groupId}`, {
        method: 'PUT',
        body: JSON.stringify({ name }),
      });
      if (!response.ok) return;
      setGroups((prev) =>
        prev.map((g) => (g.group_id === groupId ? { ...g, group_name: name.trim() } : g)),
      );
    } catch (error) {
      console.error('Error renaming group:', error);
    }
  }, []);

  const setGroupColor = useCallback(async (groupId: string, color: string | null) => {
    try {
      const response = await authenticatedFetch(`/api/projects/groups/${groupId}/color`, {
        method: 'PUT',
        body: JSON.stringify({ color }),
      });
      if (!response.ok) return;
      setGroups((prev) =>
        prev.map((g) => (g.group_id === groupId ? { ...g, color } : g)),
      );
    } catch (error) {
      console.error('Error setting group color:', error);
    }
  }, []);

  const deleteGroup = useCallback(async (groupId: string) => {
    try {
      const response = await authenticatedFetch(`/api/projects/groups/${groupId}`, {
        method: 'DELETE',
      });
      if (!response.ok) return;
      setGroups((prev) => prev.filter((g) => g.group_id !== groupId));
    } catch (error) {
      console.error('Error deleting group:', error);
    }
  }, []);

  const assignProjectToGroup = useCallback(async (projectId: string, groupId: string | null) => {
    try {
      const response = await authenticatedFetch(`/api/projects/${projectId}/group`, {
        method: 'PUT',
        body: JSON.stringify({ groupId }),
      });
      return response.ok;
    } catch (error) {
      console.error('Error assigning project to group:', error);
      return false;
    }
  }, []);

  const toggleGroupExpanded = useCallback((groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(Array.from(prev));
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      try {
        localStorage.setItem('expandedProjectGroups', JSON.stringify(Array.from(next)));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  return {
    groups,
    expandedGroups,
    fetchGroups,
    createGroup,
    renameGroup,
    deleteGroup,
    setGroupColor,
    assignProjectToGroup,
    toggleGroupExpanded,
  };
}
