import { useEffect, useRef, useState } from 'react';
import { FolderInput } from 'lucide-react';
import type { TFunction } from 'i18next';

import type { Project, ProjectGroup } from '../../../../types/app';

type SidebarProjectMoveMenuProps = {
  project: Project;
  groups: ProjectGroup[];
  onMoveToGroup: (projectId: string, groupId: string | null) => void;
  /** Tailwind size classes for the trigger button so it matches the surrounding action row. */
  triggerClassName: string;
  iconClassName: string;
  t: TFunction;
};

/**
 * Hover/tap entry point for assigning a project to a group. Acts as the
 * touch-friendly fallback for drag-and-drop: tap ⋯ → pick a group (or remove).
 */
export default function SidebarProjectMoveMenu({
  project,
  groups,
  onMoveToGroup,
  triggerClassName,
  iconClassName,
  t,
}: SidebarProjectMoveMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  if (groups.length === 0) {
    return null;
  }

  const currentGroupId = project.groupId ?? null;

  return (
    <div ref={containerRef} className="relative">
      <div
        className={triggerClassName}
        role="button"
        tabIndex={0}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((prev) => !prev);
        }}
        title={t('sidebar.moveToGroup', 'Move to group')}
      >
        <FolderInput className={iconClassName} />
      </div>

      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded-md border border-border bg-popover py-1 shadow-lg"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('sidebar.moveToGroup', 'Move to group')}
          </div>
          {groups.map((group) => {
            const isCurrent = group.group_id === currentGroupId;
            return (
              <button
                key={group.group_id}
                className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent disabled:opacity-50"
                disabled={isCurrent}
                onClick={(event) => {
                  event.stopPropagation();
                  onMoveToGroup(project.projectId, group.group_id);
                  setOpen(false);
                }}
              >
                <span className="truncate">{group.group_name}</span>
                {isCurrent && <span className="ml-2 text-primary">✓</span>}
              </button>
            );
          })}
          {currentGroupId && (
            <>
              <div className="my-1 border-t border-border" />
              <button
                className="w-full px-3 py-1.5 text-left text-xs text-red-500 hover:bg-accent"
                onClick={(event) => {
                  event.stopPropagation();
                  onMoveToGroup(project.projectId, null);
                  setOpen(false);
                }}
              >
                {t('sidebar.removeFromGroup', 'Remove from group')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
