/**
 * Scout Bookmarks Controller (#487)
 *
 * Allows scouts to bookmark players for later follow-up.  Bookmark lists are
 * per-scout and return full player profile summaries (not bare ids) so the
 * response is consistent with the player list endpoint.
 */
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  getPlayerById,
  insertBookmark,
  deleteBookmark,
  getBookmarksByScout,
  getBookmarkedPlayersWithDetails,
  insertBookmarkFolder,
  getBookmarkFoldersByScout,
  getBookmarkFolderById,
  deleteBookmarkFolder,
  renameBookmarkFolder,
  moveBookmarksToRoot,
  countBookmarksInFolder,
  ScoutBookmarkRow,
  ScoutBookmarkFolderRow,
  PlayerRow,
} from '../db';
import { getTierMeta } from '../utils/tier';
import { logger } from '../utils/logger';

// ─── Validation ───────────────────────────────────────────────────────────────

export const addBookmarkSchema = z.object({
  playerId: z
    .string({ required_error: 'playerId is required' })
    .min(1, 'playerId is required'),
  folderId: z.number().int().optional().nullable(),
  note: z.string().max(2000).optional().nullable(),
}).strict();

export const createBookmarkFolderSchema = z.object({
  name: z
    .string({ required_error: 'name is required and must be a string' })
    .min(1, 'name is required and must be a string')
    .max(100),
}).strict();

export const renameBookmarkFolderSchema = createBookmarkFolderSchema;

// ─── Serialization (mirrors filterPlayers in playerController.ts) ─────────────

function serializePlayer(row: PlayerRow): Record<string, unknown> {
  const { tierName, tierDescription } = getTierMeta(row.progress_level as number);
  return {
    player_id: row.player_id,
    wallet: row.wallet,
    position: row.position,
    region: row.region,
    metadataUri: row.metadata_uri,
    progress_level: row.progress_level,
    created_at: row.created_at,
    tierName,
    tierDescription,
  };
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * POST /api/scouts/:wallet/bookmarks
 *
 * Bookmark a player with optional folder and note.  Idempotent — bookmarking an
 * already-bookmarked player returns 200 without creating a duplicate row.
 * Body: { playerId: string, folderId?: number, note?: string }
 * Returns 404 when the player does not exist in the local database.
 */
export async function addBookmark(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { playerId, folderId, note } = req.body;

  if (!playerId) {
    res.status(400).json({ success: false, error: 'playerId is required' });
    return;
  }

  // Verify the player exists
  const player = await getPlayerById(playerId);
  if (!player) {
    res.status(404).json({ success: false, error: 'Player not found' });
    return;
  }

  // If folderId is provided, verify it belongs to the scout
  if (folderId !== undefined && folderId !== null) {
    const folder = await getBookmarkFolderById(folderId, req.params.wallet as string);
    if (!folder) {
      res.status(404).json({ success: false, error: 'Folder not found' });
      return;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const inserted = await insertBookmark({
    scout_wallet: req.params.wallet as string,
    player_id: playerId,
    folder_id: folderId,
    note: note || null,
    created_at: now,
  });

  if (inserted) {
    logger.info({ scout: req.params.wallet as string, playerId, folderId, action: 'bookmark_added' });
  }

  res.status(200).json({
    success: true,
    data: {
      scout_wallet: req.params.wallet as string,
      player_id: playerId,
      folder_id: folderId || null,
      note: note || null,
      created_at: now,
    },
  });
}

/**
 * DELETE /api/scouts/:wallet/bookmarks/:playerId
 *
 * Remove a bookmark.  Returns 404 when the bookmark does not exist.
 */
export async function removeBookmark(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const {playerId} = req.params as {playerId: string};
  const removed = await deleteBookmark(req.params.wallet as string, playerId);

  if (!removed) {
    res.status(404).json({ success: false, error: 'Bookmark not found' });
    return;
  }

  logger.info({ scout: req.params.wallet as string, playerId, action: 'bookmark_removed' });

  res.json({ success: true, data: { removed: true, player_id: playerId } });
}

/**
 * GET /api/scouts/:wallet/bookmarks
 *
 * List all bookmarked players for the authenticated scout.
 * Supports ?folderId= query parameter to filter by folder.
 * Returns full player profile summaries (same shape as the player list endpoint).
 *
 * Uses a single JOIN query (getBookmarkedPlayersWithDetails) instead of
 * N separate getPlayerById() calls, so query count stays O(1) regardless
 * of how many players the scout has bookmarked.
 */
export async function listBookmarks(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const folderId = req.query.folderId ? parseInt(req.query.folderId as string, 10) : undefined;

  // Single JOIN query — replaces the previous per-bookmark getPlayerById() loop.
  const rows = await getBookmarkedPlayersWithDetails(req.params.wallet as string, folderId);

  const enriched = rows.map((row) => ({
    ...serializePlayer(row),
    bookmarked_at: row.bookmarked_at,
    folder_id: row.bookmark_folder_id,
    note: row.bookmark_note,
  }));

  res.json({ success: true, data: enriched });
}

// ─── Bookmark folder handlers ─────────────────────────────────────────────────────

/**
 * POST /api/scouts/:wallet/bookmark-folders
 *
 * Create a new bookmark folder for the authenticated scout.
 * Body: { name: string }
 */
export async function createBookmarkFolder(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { name } = req.body;

  if (!name || typeof name !== 'string') {
    res.status(400).json({ success: false, error: 'name is required and must be a string' });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const folderId = await insertBookmarkFolder({
    scout_wallet: req.params.wallet as string,
    name,
    created_at: now,
  });

  logger.info({ scout: req.params.wallet as string, folderId, name, action: 'folder_created' });

  res.status(201).json({
    success: true,
    data: {
      id: folderId,
      scout_wallet: req.params.wallet as string,
      name,
      created_at: now,
    },
  });
}

/**
 * GET /api/scouts/:wallet/bookmark-folders
 *
 * List all bookmark folders for the authenticated scout with bookmark counts.
 */
export async function listBookmarkFolders(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const folders: ScoutBookmarkFolderRow[] = await getBookmarkFoldersByScout(req.params.wallet as string);

  // Enrich with bookmark counts
  const enriched = await Promise.all(
    folders.map(async (f) => ({
      ...f,
      bookmark_count: await countBookmarksInFolder(f.id),
    })),
  );

  res.json({ success: true, data: enriched });
}

/**
 * DELETE /api/scouts/:wallet/bookmark-folders/:folderId
 *
 * Delete a bookmark folder. Bookmarks in the folder are moved to root (folder_id set to NULL).
 * Returns 404 when the folder does not exist or belongs to another scout.
 */
export async function deleteBookmarkFolderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const {folderId} = req.params as {folderId: string};
  const folderIdNum = parseInt(folderId, 10);

  if (isNaN(folderIdNum)) {
    res.status(400).json({ success: false, error: 'Invalid folderId' });
    return;
  }

  // Verify folder exists and belongs to scout
  const folder = await getBookmarkFolderById(folderIdNum, req.params.wallet as string);
  if (!folder) {
    res.status(404).json({ success: false, error: 'Folder not found' });
    return;
  }

  // Move bookmarks to root before deleting folder
  await moveBookmarksToRoot(folderIdNum, req.params.wallet as string);

  // Delete the folder
  const deleted = await deleteBookmarkFolder(folderIdNum, req.params.wallet as string);

  if (!deleted) {
    res.status(404).json({ success: false, error: 'Folder not found' });
    return;
  }

  logger.info({ scout: req.params.wallet as string, folderId: folderIdNum, action: 'folder_deleted' });

  res.json({ success: true, data: { deleted: true, folder_id: folderIdNum } });
}

/**
 * PATCH /api/scouts/:wallet/bookmark-folders/:folderId
 *
 * Rename a bookmark folder owned by the authenticated scout.
 * Body: { name: string }
 * Returns 200 with the updated folder, 404 when the folder does not exist or
 * belongs to another scout, and 409 when another folder owned by the scout
 * already uses the requested name.
 */
export async function renameBookmarkFolderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { folderId } = req.params as { folderId: string };
  const folderIdNum = parseInt(folderId, 10);

  if (isNaN(folderIdNum)) {
    res.status(400).json({ success: false, error: 'Invalid folderId' });
    return;
  }

  const { name } = req.body;
  if (!name || typeof name !== 'string') {
    res.status(400).json({ success: false, error: 'name is required and must be a string' });
    return;
  }

  const wallet = req.params.wallet as string;
  const folder = await getBookmarkFolderById(folderIdNum, wallet);
  if (!folder) {
    res.status(404).json({ success: false, error: 'Folder not found' });
    return;
  }

  const existingFolders = await getBookmarkFoldersByScout(wallet);
  if (
    Array.isArray(existingFolders) &&
    existingFolders.some((f) => f.id !== folderIdNum && f.name === name)
  ) {
    res.status(409).json({
      success: false,
      error: 'A bookmark folder with this name already exists',
      code: 'CONFLICT',
    });
    return;
  }

  try {
    const updated = await renameBookmarkFolder(folderIdNum, wallet, name);
    if (!updated) {
      res.status(404).json({ success: false, error: 'Folder not found' });
      return;
    }
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (
      code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      code === 'SQLITE_CONSTRAINT' ||
      code === '23505' ||
      /unique|duplicate|conflict/i.test(message)
    ) {
      res.status(409).json({
        success: false,
        error: 'A bookmark folder with this name already exists',
        code: 'CONFLICT',
      });
      return;
    }
    next(err);
    return;
  }

  logger.info({ scout: wallet, folderId: folderIdNum, name, action: 'folder_renamed' });

  res.status(200).json({
    success: true,
    data: {
      id: folder.id ?? folderIdNum,
      scout_wallet: folder.scout_wallet ?? wallet,
      name,
      created_at: folder.created_at,
    },
  });
}

