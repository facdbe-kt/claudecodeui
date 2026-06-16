import { useState } from 'react';

import { cn } from '../../../../lib/utils';
import type { ProjectGroup } from '../../../../types/app';
import { PROJECT_DND_MIME, isProjectDrag } from '../../utils/dnd';

type SidebarGroupHeaderProps = {
  group: ProjectGroup;
  isExpanded: boolean;
  projectCount: number;
  onToggle: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onDropProject: (projectId: string) => void;
};

export default function SidebarGroupHeader({
  group,
  isExpanded,
  projectCount,
  onToggle,
  onRename,
  onDelete,
  onDropProject,
}: SidebarGroupHeaderProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(group.group_name);
  const [showMenu, setShowMenu] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

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
          'flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-gray-800 rounded text-sm',
          isDragOver && 'bg-blue-600/30 ring-1 ring-blue-500',
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
        <span className="text-xs text-gray-400 transition-transform" style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
          ▶
        </span>
        {isEditing ? (
          <input
            type="text"
            className="flex-1 rounded border border-gray-600 bg-gray-700 px-1 py-0.5 text-xs text-gray-200 focus:border-blue-500 focus:outline-none"
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
            <span className="flex-1 truncate text-xs font-medium text-gray-300">
              {group.group_name}
            </span>
            <span className="text-xs text-gray-500">
              {projectCount}
            </span>
          </>
        )}
        {/* Action menu trigger */}
        <button
          className="px-1 text-xs text-gray-400 opacity-0 hover:text-gray-200 group-hover:opacity-100"
          onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
        >
          ⋯
        </button>
      </div>

      {/* Dropdown menu */}
      {showMenu && (
        <div className="absolute right-2 top-full z-50 mt-0.5 min-w-[100px] rounded border border-gray-700 bg-gray-800 py-1 shadow-lg">
          <button
            className="w-full px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-700"
            onClick={(e) => {
              e.stopPropagation();
              setIsEditing(true);
              setEditName(group.group_name);
              setShowMenu(false);
            }}
          >
            Rename
          </button>
          <button
            className="w-full px-3 py-1.5 text-left text-xs text-red-400 hover:bg-gray-700"
            onClick={(e) => {
              e.stopPropagation();
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
