import { useState } from 'react';
import { ChevronRight, MoreHorizontal } from 'lucide-react';

import { cn } from '../../../../lib/utils';
import type { ProjectGroup } from '../../../../types/app';
import { PROJECT_DND_MIME, isProjectDrag } from '../../utils/dnd';
import { GROUP_COLORS, getGroupColor } from '../../utils/groupColors';

type SidebarGroupHeaderProps = {
  group: ProjectGroup;
  isExpanded: boolean;
  projectCount: number;
  onToggle: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onSetColor: (color: string) => void;
  onDropProject: (projectId: string) => void;
};

export default function SidebarGroupHeader({
  group,
  isExpanded,
  projectCount,
  onToggle,
  onRename,
  onDelete,
  onSetColor,
  onDropProject,
}: SidebarGroupHeaderProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(group.group_name);
  const [showMenu, setShowMenu] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const color = getGroupColor(group.color);

  const handleRename = () => {
    if (editName.trim() && editName.trim() !== group.group_name) {
      onRename(editName.trim());
    }
    setIsEditing(false);
  };

  return (
    <div className="group relative">
      <div
        className={cn(
          'flex items-center gap-1.5 rounded px-2 py-1.5 cursor-pointer hover:bg-accent',
          isDragOver && 'bg-primary/15 ring-1 ring-primary',
        )}
        onClick={onToggle}
        onDragOver={(event) => {
          if (!isProjectDrag(event.dataTransfer.types)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          if (!isDragOver) setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(event) => {
          if (!isProjectDrag(event.dataTransfer.types)) return;
          event.preventDefault();
          setIsDragOver(false);
          const projectId = event.dataTransfer.getData(PROJECT_DND_MIME);
          if (projectId) onDropProject(projectId);
        }}
      >
        <ChevronRight
          className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform"
          style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
        />
        <span
          className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        {isEditing ? (
          <input
            type="text"
            className="flex-1 rounded border border-border bg-background px-1 py-0.5 text-sm text-foreground focus:border-primary focus:outline-none"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') { setIsEditing(false); setEditName(group.group_name); }
            }}
            onClick={(e) => e.stopPropagation()}
            onBlur={handleRename}
            autoFocus
          />
        ) : (
          <>
            <span className="flex-1 truncate text-sm font-semibold text-foreground">
              {group.group_name}
            </span>
            <span className="flex-shrink-0 rounded-full bg-muted px-1.5 text-[10px] font-medium leading-5 text-muted-foreground">
              {projectCount}
            </span>
          </>
        )}
        {/* Action menu trigger */}
        <button
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100"
          onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </div>

      {/* Dropdown menu */}
      {showMenu && (
        <div
          className="absolute right-2 top-full z-50 mt-0.5 min-w-[160px] rounded-md border border-border bg-popover py-1 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="w-full px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent"
            onClick={() => {
              setIsEditing(true);
              setEditName(group.group_name);
              setShowMenu(false);
            }}
          >
            Rename
          </button>

          <div className="my-1 border-t border-border" />
          <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Color
          </div>
          <div className="grid grid-cols-5 gap-1.5 px-3 py-1.5">
            {GROUP_COLORS.map((swatch) => {
              const isCurrent = swatch === color;
              return (
                <button
                  key={swatch}
                  className={cn(
                    'h-5 w-5 rounded-full transition-transform hover:scale-110',
                    isCurrent && 'ring-2 ring-foreground ring-offset-1 ring-offset-popover',
                  )}
                  style={{ backgroundColor: swatch }}
                  title={swatch}
                  onClick={() => {
                    onSetColor(swatch);
                    setShowMenu(false);
                  }}
                />
              );
            })}
          </div>

          <div className="my-1 border-t border-border" />
          <button
            className="w-full px-3 py-1.5 text-left text-xs text-red-500 hover:bg-accent"
            onClick={() => {
              onDelete();
              setShowMenu(false);
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
