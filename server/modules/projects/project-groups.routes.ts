import express from 'express';

import { projectGroupsDb } from '@/modules/database/index.js';
import { asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const router = express.Router();

/**
 * GET /api/projects/groups — List all project groups
 */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const groups = projectGroupsDb.getAllGroups();
    res.json(createApiSuccessResponse({ groups }));
  }),
);

/**
 * POST /api/projects/groups — Create a new project group
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name } = req.body as { name?: string };
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'Group name is required' });
      return;
    }

    const group = projectGroupsDb.createGroup(name);
    res.json(createApiSuccessResponse({ group }));
  }),
);

/**
 * PUT /api/projects/groups/:groupId — Rename a group
 */
router.put(
  '/:groupId',
  asyncHandler(async (req, res) => {
    const groupId = req.params.groupId as string;
    const { name } = req.body as { name?: string };
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'Group name is required' });
      return;
    }

    const existing = projectGroupsDb.getGroupById(groupId);
    if (!existing) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    projectGroupsDb.renameGroup(groupId, name);
    res.json(createApiSuccessResponse({ group: { ...existing, group_name: name.trim() } }));
  }),
);

/**
 * DELETE /api/projects/groups/:groupId — Delete a group (projects become ungrouped)
 */
router.delete(
  '/:groupId',
  asyncHandler(async (req, res) => {
    const groupId = req.params.groupId as string;
    const existing = projectGroupsDb.getGroupById(groupId);
    if (!existing) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    projectGroupsDb.deleteGroup(groupId);
    res.json(createApiSuccessResponse({ deleted: true }));
  }),
);

export default router;
