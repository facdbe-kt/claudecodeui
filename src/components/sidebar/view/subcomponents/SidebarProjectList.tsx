import { useEffect, useState } from 'react';
import type { TFunction } from 'i18next';

import type { LoadingProgress, Project, ProjectSession, LLMProvider, ProjectGroup } from '../../../../types/app';
import type { MCPServerStatus, SessionWithProvider } from '../../types/types';

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
  onCreateGroup: (name: string) => Promise<ProjectGroup | null>;
  onRenameGroup: (groupId: string, name: string) => Promise<void>;
  onDeleteGroup: (groupId: string) => Promise<void>;
  onAssignProjectToGroup: (projectId: string, groupId: string | null) => Promise<boolean>;
  onRefreshProjects: () => void;
  t: TFunction;
};

function renderProjectItem(
  project: Project,
  props: SidebarProjectListProps,
) {
  return (
    <SidebarProjectItem
      key={project.projectId}
      project={project}
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
    onAssignProjectToGroup,
    onRefreshProjects,
    t,
  } = props;

  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');

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
    await onCreateGroup(newGroupName.trim());
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
      <div className="px-2 mb-1">
        {showCreateGroup ? (
          <div className="flex items-center gap-1">
            <input
              type="text"
              className="flex-1 text-xs px-2 py-1 rounded bg-gray-700 text-gray-200 border border-gray-600 focus:outline-none focus:border-blue-500"
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
              className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
              onClick={() => void handleCreateGroup()}
            >
              ✓
            </button>
            <button
              className="text-xs px-2 py-1 rounded bg-gray-600 text-gray-300 hover:bg-gray-500"
              onClick={() => { setShowCreateGroup(false); setNewGroupName(''); }}
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1"
            onClick={() => setShowCreateGroup(true)}
          >
            <span>+</span>
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
            />
            {isExpanded && (
              <div className="ml-2 border-l border-gray-700 pl-1">
                {groupProjects.length === 0 ? (
                  <div className="text-xs text-gray-500 px-2 py-1 italic">
                    {t('sidebar.emptyGroup', 'No projects')}
                  </div>
                ) : (
                  groupProjects.map((project) => renderProjectItem(project, props))
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Render ungrouped projects */}
      {ungroupedProjects.map((project) => renderProjectItem(project, props))}

      {/* Context menu for moving projects to groups is handled via right-click on SidebarProjectItem */}
      {/* This is a minimal inline approach — right-click menu is a future enhancement */}
    </div>
  );
}
