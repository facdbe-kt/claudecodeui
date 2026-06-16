import express from 'express';

import { projectGroupsDb } from '@/modules/database/index.js';
import { asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const router = express.Router();

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function normalizeColor(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

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
    const { name, color } = req.body as { name?: string; color?: string };
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'Group name is required' });
      return;
    }

    const group = projectGroupsDb.createGroup(name, normalizeColor(color));
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
 * PUT /api/projects/groups/:groupId/color — Set (or clear) a group's color
 * Body: { color: string | null } — color must be a #rrggbb hex string
 */
router.put(
  '/:groupId/color',
  asyncHandler(async (req, res) => {
    const groupId = req.params.groupId as string;
    const { color } = req.body as { color?: string | null };

    const existing = projectGroupsDb.getGroupById(groupId);
    if (!existing) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    const normalized = color === null ? null : normalizeColor(color);
    if (color !== null && normalized === null) {
      res.status(400).json({ error: 'Color must be a #rrggbb hex string or null' });
      return;
    }

    projectGroupsDb.setGroupColor(groupId, normalized);
    res.json(createApiSuccessResponse({ group: { ...existing, color: normalized } }));
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
