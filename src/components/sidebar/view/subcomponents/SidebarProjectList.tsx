import { useEffect, useState } from 'react';
import type { TFunction } from 'i18next';

import { cn } from '../../../../lib/utils';
import type { LoadingProgress, Project, ProjectSession, LLMProvider, ProjectGroup } from '../../../../types/app';
import type { MCPServerStatus, SessionWithProvider } from '../../types/types';
import { PROJECT_DND_MIME, isProjectDrag } from '../../utils/dnd';
import { getGroupColor, nextGroupColor } from '../../utils/groupColors';

import SidebarProjectItem from './SidebarProjectItem';
import SidebarProjectsState from './SidebarProjectsState';
import SidebarGroupHeader from './SidebarGroupHeader';

export type SidebarProjectListProps = {
  projects: Project[];
  filteredProjects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isLoading: boolean;
  loadingProgress: LoadingProgress | null;
  expandedProjects: Set<string>;
  editingProject: string | null;
  editingName: string;
  initialSessionsLoaded: Set<string>;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  deletingProjects: Set<string>;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  getProjectSessions: (project: Project) => SessionWithProvider[];
  onLoadMoreSessions: (projectId: string) => void;
  loadingMoreProjects: Set<string>;
  isProjectStarred: (projectName: string) => boolean;
  onEditingNameChange: (value: string) => void;
  onToggleProject: (projectName: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectName: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectName: string) => void;
  onDeleteProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: LLMProvider,
  ) => void;
  onNewSession: (project: Project) => void;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  // Group props
  groups: ProjectGroup[];
  expandedGroups: Set<string>;
  onToggleGroupExpanded: (groupId: string) => void;
  onCreateGroup: (name: string, color?: string | null) => Promise<ProjectGroup | null>;
  onRenameGroup: (groupId: string, name: string) => Promise<void>;
  onDeleteGroup: (groupId: string) => Promise<void>;
  onSetGroupColor: (groupId: string, color: string | null) => Promise<void>;
  onAssignProjectToGroup: (projectId: string, groupId: string | null) => Promise<boolean>;
  onRefreshProjects: () => void;
  t: TFunction;
};

function renderProjectItem(
  project: Project,
  props: SidebarProjectListProps,
  onMoveToGroup: (projectId: string, groupId: string | null) => void,
) {
  return (
    <SidebarProjectItem
      key={project.projectId}
      project={project}
      groups={props.groups}
      onMoveToGroup={onMoveToGroup}
      selectedProject={props.selectedProject}
      selectedSession={props.selectedSession}
      isExpanded={props.expandedProjects.has(project.projectId)}
      isDeleting={props.deletingProjects.has(project.projectId)}
      isStarred={props.isProjectStarred(project.projectId)}
      editingProject={props.editingProject}
      editingName={props.editingName}
      sessions={props.getProjectSessions(project)}
      initialSessionsLoaded={props.initialSessionsLoaded.has(project.projectId)}
      isLoadingMoreSessions={props.loadingMoreProjects.has(project.projectId)}
      currentTime={props.currentTime}
      editingSession={props.editingSession}
      editingSessionName={props.editingSessionName}
      tasksEnabled={props.tasksEnabled}
      mcpServerStatus={props.mcpServerStatus}
      onEditingNameChange={props.onEditingNameChange}
      onToggleProject={props.onToggleProject}
      onProjectSelect={props.onProjectSelect}
      onToggleStarProject={props.onToggleStarProject}
      onStartEditingProject={props.onStartEditingProject}
      onCancelEditingProject={props.onCancelEditingProject}
      onSaveProjectName={props.onSaveProjectName}
      onDeleteProject={props.onDeleteProject}
      onSessionSelect={props.onSessionSelect}
      onDeleteSession={props.onDeleteSession}
      onLoadMoreSessions={props.onLoadMoreSessions}
      onNewSession={props.onNewSession}
      onEditingSessionNameChange={props.onEditingSessionNameChange}
      onStartEditingSession={props.onStartEditingSession}
      onCancelEditingSession={props.onCancelEditingSession}
      onSaveEditingSession={props.onSaveEditingSession}
      t={props.t}
    />
  );
}

export default function SidebarProjectList(props: SidebarProjectListProps) {
  const {
    projects,
    filteredProjects,
    selectedProject,
    isLoading,
    loadingProgress,
    groups,
    expandedGroups,
    onToggleGroupExpanded,
    onCreateGroup,
    onRenameGroup,
    onDeleteGroup,
    onSetGroupColor,
    onAssignProjectToGroup,
    onRefreshProjects,
    t,
  } = props;

  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [isUngroupedDragOver, setIsUngroupedDragOver] = useState(false);

  const state = (
    <SidebarProjectsState
      isLoading={isLoading}
      loadingProgress={loadingProgress}
      projectsCount={projects.length}
      filteredProjectsCount={filteredProjects.length}
      t={t}
    />
  );

  useEffect(() => {
    let baseTitle = 'CloudCLI UI';
    const displayName = selectedProject?.displayName?.trim();
    if (displayName) {
      baseTitle = `${displayName} - ${baseTitle}`;
    }
    document.title = baseTitle;
  }, [selectedProject]);

  const showProjects = !isLoading && projects.length > 0 && filteredProjects.length > 0;

  if (!showProjects) {
    return <div className="pb-safe-area-inset-bottom md:space-y-1">{state}</div>;
  }

  // Split projects into grouped and ungrouped
  const groupedProjects = new Map<string, Project[]>();
  const ungroupedProjects: Project[] = [];

  for (const project of filteredProjects) {
    if (project.groupId) {
      const existing = groupedProjects.get(project.groupId) || [];
      existing.push(project);
      groupedProjects.set(project.groupId, existing);
    } else {
      ungroupedProjects.push(project);
    }
  }

  // Sort groups by sort_order
  const sortedGroups = [...groups].sort((a, b) => a.sort_order - b.sort_order);

  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) return;
    // Rotate through the palette so each new group gets a distinct default color.
    await onCreateGroup(newGroupName.trim(), nextGroupColor(groups.length));
    setNewGroupName('');
    setShowCreateGroup(false);
  };

  const handleMoveToGroup = async (projectId: string, groupId: string | null) => {
    const success = await onAssignProjectToGroup(projectId, groupId);
    if (success) {
      onRefreshProjects();
    }
  };

  return (
    <div className="pb-safe-area-inset-bottom md:space-y-1">
      {/* Create group button */}
      <div className="mb-1 px-2">
        {showCreateGroup ? (
          <div className="flex items-center gap-1">
            <input
              type="text"
              className="flex-1 rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:border-primary focus:outline-none"
              placeholder={t('sidebar.newGroupPlaceholder', 'Group name...')}
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreateGroup();
                if (e.key === 'Escape') { setShowCreateGroup(false); setNewGroupName(''); }
              }}
              autoFocus
            />
            <button
              className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90"
              onClick={() => void handleCreateGroup()}
            >
              ✓
            </button>
            <button
              className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground hover:bg-muted/80"
              onClick={() => { setShowCreateGroup(false); setNewGroupName(''); }}
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            onClick={() => setShowCreateGroup(true)}
          >
            <span className="text-sm leading-none">+</span>
            <span>{t('sidebar.createGroup', 'New Group')}</span>
          </button>
        )}
      </div>

      {/* Render groups */}
      {sortedGroups.map((group) => {
        const groupProjects = groupedProjects.get(group.group_id) || [];
        const isExpanded = expandedGroups.has(group.group_id);

        return (
          <div key={group.group_id} className="mb-0.5">
            <SidebarGroupHeader
              group={group}
              isExpanded={isExpanded}
              projectCount={groupProjects.length}
              onToggle={() => onToggleGroupExpanded(group.group_id)}
              onRename={(name) => void onRenameGroup(group.group_id, name)}
              onDelete={() => void onDeleteGroup(group.group_id)}
              onSetColor={(color) => void onSetGroupColor(group.group_id, color)}
              onDropProject={(projectId) => void handleMoveToGroup(projectId, group.group_id)}
            />
            {isExpanded && (
              <div
                className="ml-2 border-l-2 pl-1"
                style={{ borderColor: getGroupColor(group.color) }}
              >
                {groupProjects.length === 0 ? (
                  <div className="px-2 py-1 text-xs italic text-muted-foreground">
                    {t('sidebar.emptyGroup', 'No projects')}
                  </div>
                ) : (
                  groupProjects.map((project) => renderProjectItem(project, props, handleMoveToGroup))
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Render ungrouped projects — also a drop target for removing a project from its group */}
      <div
        className={cn(
          'rounded transition-colors',
          isUngroupedDragOver && groups.length > 0 && 'bg-blue-600/10 ring-1 ring-blue-500/40',
        )}
        onDragOver={(event) => {
          if (groups.length === 0 || !isProjectDrag(event.dataTransfer.types)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          if (!isUngroupedDragOver) setIsUngroupedDragOver(true);
        }}
        onDragLeave={() => setIsUngroupedDragOver(false)}
        onDrop={(event) => {
          if (groups.length === 0 || !isProjectDrag(event.dataTransfer.types)) return;
          event.preventDefault();
          setIsUngroupedDragOver(false);
          const projectId = event.dataTransfer.getData(PROJECT_DND_MIME);
          if (projectId) void handleMoveToGroup(projectId, null);
        }}
      >
        {isUngroupedDragOver && groups.length > 0 && (
          <div className="px-2 py-1 text-xs italic text-blue-400">
            {t('sidebar.dropToUngroup', 'Drop here to remove from group')}
          </div>
        )}
        {ungroupedProjects.map((project) => renderProjectItem(project, props, handleMoveToGroup))}
      </div>
    </div>
  );
}
