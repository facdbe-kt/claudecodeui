import { useState } from 'react';

import type { ProjectGroup } from '../../../../types/app';

type SidebarGroupHeaderProps = {
  group: ProjectGroup;
  isExpanded: boolean;
  projectCount: number;
  onToggle: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
};

export default function SidebarGroupHeader({
  group,
  isExpanded,
  projectCount,
  onToggle,
  onRename,
  onDelete,
}: SidebarGroupHeaderProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(group.group_name);
  const [showMenu, setShowMenu] = useState(false);

  const handleRename = () => {
    if (editName.trim() && editName.trim() !== group.group_name) {
      onRename(editName.trim());
    }
    setIsEditing(false);
  };

  return (
    <div className="group relative">
      <div
        className="flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-gray-800 rounded text-sm"
        onClick={onToggle}
      >
        <span className="text-gray-400 text-xs transition-transform" style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
          ▶
        </span>
        {isEditing ? (
          <input
            type="text"
            className="flex-1 text-xs px-1 py-0.5 rounded bg-gray-700 text-gray-200 border border-gray-600 focus:outline-none focus:border-blue-500"
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
            <span className="text-gray-300 font-medium text-xs truncate flex-1">
              {group.group_name}
            </span>
            <span className="text-gray-500 text-xs">
              {projectCount}
            </span>
          </>
        )}
        {/* Action menu trigger */}
        <button
          className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-gray-200 text-xs px-1"
          onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
        >
          ⋯
        </button>
      </div>

      {/* Dropdown menu */}
      {showMenu && (
        <div className="absolute right-2 top-full z-50 mt-0.5 bg-gray-800 border border-gray-700 rounded shadow-lg py-1 min-w-[100px]">
          <button
            className="w-full text-left text-xs px-3 py-1.5 text-gray-300 hover:bg-gray-700"
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
            className="w-full text-left text-xs px-3 py-1.5 text-red-400 hover:bg-gray-700"
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
