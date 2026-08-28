import Database from "better-sqlite3";
import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const DB_FILE = join(DATA_DIR, "heliosgen.db");
const LEGACY_DB_FILE = join(DATA_DIR, "guest-db.json");
const LEGACY_MIGRATION = "guest-json-v1";

export interface Generation {
  id: string;
  user_id: string | null;
  task_id: string;
  generation_type: string;
  status: string;
  prompt?: string;
  model?: string;
  aspect_ratio?: string;
  quality?: string;
  azure_resolution?: string;
  duration?: number;
  kling_mode?: string;
  sound?: boolean;
  reference_image_urls?: string[];
  image_url?: string;
  image_urls?: string[];
  video_url?: string;
  error_msg?: string;
  created_at: string;
  updated_at: string;
}

export interface Upload {
  id: string;
  user_id: string;
  r2_url: string;
  mime_type?: string | null;
  source: string;
  created_at: string;
}

export interface FolderRecord {
  id: string;
  user_id: string;
  name: string;
  parent_id: string | null;
  order_index: number;
  created_at: string;
  updated_at: string;
  color?: string | null;
}

export interface FolderItemRecord {
  folder_id: string;
  item_id: string;
  user_id: string;
  created_at: string;
}

interface LegacyGuestDb {
  generations?: Generation[];
  uploads?: Upload[];
  assetCache?: Record<string, { cdn_url: string; mime_type: string; byte_size: number }>;
  settings?: { kie_api_token?: string; azure_api_key?: string };
  folders?: FolderRecord[];
  folder_items?: FolderItemRecord[];
}

interface GenerationRow extends Omit<Generation, "sound" | "reference_image_urls" | "image_urls"> {
  sound: number | null;
  reference_image_urls: string | null;
  image_urls: string | null;
}

let instance: Database.Database | undefined;

function now(): string {
  return new Date().toISOString();
}

function optionalJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function parseStringArray(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function toGeneration(row: GenerationRow): Generation {
  return {
    ...row,
    sound: row.sound === null ? undefined : row.sound === 1,
    reference_image_urls: parseStringArray(row.reference_image_urls),
    image_urls: parseStringArray(row.image_urls),
  };
}

function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS generations (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      task_id TEXT NOT NULL UNIQUE,
      generation_type TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT,
      model TEXT,
      aspect_ratio TEXT,
      quality TEXT,
      azure_resolution TEXT,
      duration INTEGER,
      kling_mode TEXT,
      sound INTEGER,
      reference_image_urls TEXT,
      image_url TEXT,
      image_urls TEXT,
      video_url TEXT,
      error_msg TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS generations_gallery_idx
      ON generations (user_id, generation_type, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      r2_url TEXT NOT NULL,
      mime_type TEXT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS uploads_gallery_idx
      ON uploads (user_id, mime_type, created_at DESC);

    CREATE TABLE IF NOT EXISTS asset_cache (
      hash TEXT PRIMARY KEY,
      cdn_url TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      kie_api_token TEXT,
      azure_api_key TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_id TEXT,
      order_index INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      color TEXT
    );
    CREATE INDEX IF NOT EXISTS folders_user_order_idx
      ON folders (user_id, order_index);

    CREATE TABLE IF NOT EXISTS folder_items (
      folder_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (folder_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS folder_items_user_idx ON folder_items (user_id);

    CREATE TABLE IF NOT EXISTS spaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      is_public INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      messages TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function migrateLegacyJson(db: Database.Database): void {
  if (!existsSync(LEGACY_DB_FILE)) return;

  let legacy: LegacyGuestDb;
  try {
    const parsed = JSON.parse(readFileSync(LEGACY_DB_FILE, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("legacy database root must be an object");
    }
    legacy = parsed as LegacyGuestDb;
  } catch (error) {
    console.error(`[local-db] Skipping legacy migration for invalid ${LEGACY_DB_FILE}:`, error);
    db.prepare("INSERT OR IGNORE INTO migrations (name, applied_at) VALUES (?, ?)")
      .run(LEGACY_MIGRATION, now());
    return;
  }

  const migrate = db.transaction(() => {
    const migrated = db.prepare("SELECT 1 FROM migrations WHERE name = ?").get(LEGACY_MIGRATION);
    if (migrated) return false;

    const insertGenerationRow = db.prepare(`
      INSERT OR IGNORE INTO generations (
        id, user_id, task_id, generation_type, status, prompt, model, aspect_ratio,
        quality, azure_resolution, duration, kling_mode, sound, reference_image_urls,
        image_url, image_urls, video_url, error_msg, created_at, updated_at
      ) VALUES (
        @id, @user_id, @task_id, @generation_type, @status, @prompt, @model, @aspect_ratio,
        @quality, @azure_resolution, @duration, @kling_mode, @sound, @reference_image_urls,
        @image_url, @image_urls, @video_url, @error_msg, @created_at, @updated_at
      )
    `);
    for (const generation of legacy.generations ?? []) {
      insertGenerationRow.run(generationParams(generation));
    }

    const insertUploadRow = db.prepare(`
      INSERT OR IGNORE INTO uploads (id, user_id, r2_url, mime_type, source, created_at)
      VALUES (@id, @user_id, @r2_url, @mime_type, @source, @created_at)
    `);
    for (const upload of legacy.uploads ?? []) {
      insertUploadRow.run({ ...upload, mime_type: upload.mime_type ?? null });
    }

    const insertAssetRow = db.prepare(`
      INSERT OR IGNORE INTO asset_cache (hash, cdn_url, mime_type, byte_size, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const [hash, asset] of Object.entries(legacy.assetCache ?? {})) {
      insertAssetRow.run(hash, asset.cdn_url, asset.mime_type, asset.byte_size, now());
    }

    if (legacy.settings) {
      db.prepare(`
        INSERT INTO settings (id, kie_api_token, azure_api_key, updated_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kie_api_token = COALESCE(settings.kie_api_token, excluded.kie_api_token),
          azure_api_key = COALESCE(settings.azure_api_key, excluded.azure_api_key),
          updated_at = excluded.updated_at
      `).run(
        legacy.settings.kie_api_token ?? null,
        legacy.settings.azure_api_key ?? null,
        now(),
      );
    }

    const insertFolderRow = db.prepare(`
      INSERT OR IGNORE INTO folders (
        id, user_id, name, parent_id, order_index, created_at, updated_at, color
      ) VALUES (@id, @user_id, @name, @parent_id, @order_index, @created_at, @updated_at, @color)
    `);
    for (const folder of legacy.folders ?? []) {
      insertFolderRow.run({ ...folder, color: folder.color ?? null });
    }

    const insertFolderItemRow = db.prepare(`
      INSERT OR IGNORE INTO folder_items (folder_id, item_id, user_id, created_at)
      VALUES (@folder_id, @item_id, @user_id, @created_at)
    `);
    for (const item of legacy.folder_items ?? []) {
      insertFolderItemRow.run(item);
    }

    db.prepare("INSERT OR IGNORE INTO migrations (name, applied_at) VALUES (?, ?)")
      .run(LEGACY_MIGRATION, now());
    return true;
  });

  try {
    if (migrate.immediate()) {
      console.info(`[local-db] Migrated legacy data from ${LEGACY_DB_FILE}`);
    }
  } catch (error) {
    console.error(`[local-db] Skipping incompatible legacy data in ${LEGACY_DB_FILE}:`, error);
    db.prepare("INSERT OR IGNORE INTO migrations (name, applied_at) VALUES (?, ?)")
      .run(LEGACY_MIGRATION, now());
  }
}

function getDb(): Database.Database {
  if (instance) return instance;
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 30000");
  initializeSchema(db);
  migrateLegacyJson(db);
  instance = db;
  return db;
}

function generationParams(
  data: Omit<Generation, "id" | "created_at" | "updated_at"> | Generation,
): Record<string, string | number | null> {
  const createdAt = "created_at" in data ? data.created_at : now();
  const updatedAt = "updated_at" in data ? data.updated_at : createdAt;
  return {
    id: "id" in data ? data.id : randomUUID(),
    user_id: data.user_id,
    task_id: data.task_id,
    generation_type: data.generation_type,
    status: data.status,
    prompt: data.prompt ?? null,
    model: data.model ?? null,
    aspect_ratio: data.aspect_ratio ?? null,
    quality: data.quality ?? null,
    azure_resolution: data.azure_resolution ?? null,
    duration: data.duration ?? null,
    kling_mode: data.kling_mode ?? null,
    sound: data.sound === undefined ? null : data.sound ? 1 : 0,
    reference_image_urls: optionalJson(data.reference_image_urls),
    image_url: data.image_url ?? null,
    image_urls: optionalJson(data.image_urls),
    video_url: data.video_url ?? null,
    error_msg: data.error_msg ?? null,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

export function hashBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ── Generations ────────────────────────────────────────────────────────────

export function insertGeneration(data: Omit<Generation, "id" | "created_at" | "updated_at">): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO generations (
      id, user_id, task_id, generation_type, status, prompt, model, aspect_ratio,
      quality, azure_resolution, duration, kling_mode, sound, reference_image_urls,
      image_url, image_urls, video_url, error_msg, created_at, updated_at
    ) VALUES (
      @id, @user_id, @task_id, @generation_type, @status, @prompt, @model, @aspect_ratio,
      @quality, @azure_resolution, @duration, @kling_mode, @sound, @reference_image_urls,
      @image_url, @image_urls, @video_url, @error_msg, @created_at, @updated_at
    )
  `).run(generationParams(data));
}

export function updateGeneration(
  taskId: string,
  updates: Partial<Pick<Generation, "status" | "image_url" | "image_urls" | "video_url" | "error_msg">>,
): void {
  const assignments: string[] = [];
  const params: Record<string, string | null> = { task_id: taskId, updated_at: now() };
  for (const key of ["status", "image_url", "image_urls", "video_url", "error_msg"] as const) {
    if (!(key in updates) || updates[key] === undefined) continue;
    assignments.push(`${key} = @${key}`);
    const value = updates[key];
    params[key] = key === "image_urls" ? optionalJson(value) : (value ?? null) as string | null;
  }
  if (assignments.length === 0) return;
  assignments.push("updated_at = @updated_at");
  getDb().prepare(`UPDATE generations SET ${assignments.join(", ")} WHERE task_id = @task_id`).run(params);
}

export function recoverJob(
  taskId: string,
): Pick<Generation, "status" | "video_url" | "image_url" | "image_urls" | "error_msg"> | null {
  const row = getDb().prepare(`
    SELECT status, video_url, image_url, image_urls, error_msg
    FROM generations WHERE task_id = ?
  `).get(taskId) as Pick<GenerationRow, "status" | "video_url" | "image_url" | "image_urls" | "error_msg"> | undefined;
  if (!row) return null;
  return { ...row, image_urls: parseStringArray(row.image_urls) };
}

export function getGenerations(userId: string, type: "image" | "video"): Generation[] {
  const urlColumn = type === "video" ? "video_url" : "image_url";
  const rows = getDb().prepare(`
    SELECT * FROM generations
    WHERE user_id = ? AND generation_type = ? AND status = 'done' AND ${urlColumn} IS NOT NULL
    ORDER BY created_at DESC LIMIT 1000
  `).all(userId, type) as GenerationRow[];
  return rows.map(toGeneration);
}

export function deleteGeneration(id: string, userId: string): void {
  getDb().prepare("DELETE FROM generations WHERE id = ? AND user_id = ?").run(id, userId);
}

// ── Uploads ────────────────────────────────────────────────────────────────

export function insertUpload(data: Omit<Upload, "id" | "created_at">): void {
  getDb().prepare(`
    INSERT INTO uploads (id, user_id, r2_url, mime_type, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), data.user_id, data.r2_url, data.mime_type ?? null, data.source, now());
}

export function getUploads(userId: string, mimeTypePrefix: string): Upload[] {
  return getDb().prepare(`
    SELECT * FROM uploads
    WHERE user_id = ? AND mime_type LIKE ?
    ORDER BY created_at DESC LIMIT 1000
  `).all(userId, `${mimeTypePrefix}%`) as Upload[];
}

export function deleteUpload(id: string, userId: string): void {
  getDb().prepare("DELETE FROM uploads WHERE id = ? AND user_id = ?").run(id, userId);
}

// ── Asset Cache ────────────────────────────────────────────────────────────

export function lookupAssetHash(hash: string): string | null {
  const row = getDb().prepare("SELECT cdn_url FROM asset_cache WHERE hash = ?").get(hash) as
    | { cdn_url: string }
    | undefined;
  if (row) console.log("[local/asset-cache] HIT:", hash.slice(0, 8));
  return row?.cdn_url ?? null;
}

export function storeAssetHash(hash: string, cdnUrl: string, mimeType: string, byteSize: number): void {
  getDb().prepare(`
    INSERT INTO asset_cache (hash, cdn_url, mime_type, byte_size, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(hash) DO UPDATE SET
      cdn_url = excluded.cdn_url,
      mime_type = excluded.mime_type,
      byte_size = excluded.byte_size
  `).run(hash, cdnUrl, mimeType, byteSize, now());
}

// ── Settings ───────────────────────────────────────────────────────────────

function getSettings(): { kie_api_token: string | null; azure_api_key: string | null } | undefined {
  return getDb().prepare("SELECT kie_api_token, azure_api_key FROM settings WHERE id = 1").get() as
    | { kie_api_token: string | null; azure_api_key: string | null }
    | undefined;
}

function updateSetting(column: "kie_api_token" | "azure_api_key", value: string | null): void {
  getDb().prepare(`
    INSERT INTO settings (id, ${column}, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET ${column} = excluded.${column}, updated_at = excluded.updated_at
  `).run(value, now());
}

export function getKieApiToken(): string | null {
  const dbToken = getSettings()?.kie_api_token;
  if (dbToken) return dbToken;
  const envToken = process.env.KIE_API_KEY ?? "";
  return !envToken || envToken === "your_kie_api_key_here" ? null : envToken;
}

export function setKieApiToken(token: string): void {
  updateSetting("kie_api_token", token);
}

export function deleteKieApiToken(): void {
  updateSetting("kie_api_token", null);
}

export function getAzureApiKey(): string | null {
  return getSettings()?.azure_api_key || process.env.AZURE_API_KEY || null;
}

export function setAzureApiKey(key: string): void {
  updateSetting("azure_api_key", key);
}

export function deleteAzureApiKey(): void {
  updateSetting("azure_api_key", null);
}

// ── Folders ────────────────────────────────────────────────────────────────

export function getFolders(userId: string): FolderRecord[] {
  return getDb().prepare(`
    SELECT * FROM folders WHERE user_id = ? ORDER BY order_index ASC
  `).all(userId) as FolderRecord[];
}

export function insertFolder(data: Omit<FolderRecord, "created_at" | "updated_at">): FolderRecord {
  const timestamp = now();
  const record: FolderRecord = { ...data, created_at: timestamp, updated_at: timestamp };
  getDb().prepare(`
    INSERT INTO folders (id, user_id, name, parent_id, order_index, created_at, updated_at, color)
    VALUES (@id, @user_id, @name, @parent_id, @order_index, @created_at, @updated_at, @color)
  `).run({ ...record, color: record.color ?? null });
  return record;
}

export function updateFolder(
  id: string,
  userId: string,
  updates: Partial<Pick<FolderRecord, "name" | "parent_id" | "order_index" | "color">>,
): void {
  const assignments: string[] = [];
  const params: Record<string, string | number | null> = { id, user_id: userId, updated_at: now() };
  for (const key of ["name", "parent_id", "order_index", "color"] as const) {
    if (!(key in updates)) continue;
    assignments.push(`${key} = @${key}`);
    params[key] = updates[key] ?? null;
  }
  if (assignments.length === 0) return;
  assignments.push("updated_at = @updated_at");
  getDb().prepare(`
    UPDATE folders SET ${assignments.join(", ")} WHERE id = @id AND user_id = @user_id
  `).run(params);
}

export function deleteFolder(id: string, userId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM folder_items WHERE folder_id = ? AND user_id = ?").run(id, userId);
    db.prepare("DELETE FROM folders WHERE id = ? AND user_id = ?").run(id, userId);
  })();
}

// ── Folder Items ───────────────────────────────────────────────────────────

export function getFolderItems(userId: string): FolderItemRecord[] {
  return getDb().prepare("SELECT * FROM folder_items WHERE user_id = ?").all(userId) as FolderItemRecord[];
}

export function insertFolderItems(folderId: string, itemIds: string[], userId: string): void {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO folder_items (folder_id, item_id, user_id, created_at)
    VALUES (?, ?, ?, ?)
  `);
  db.transaction((ids: string[]) => {
    for (const itemId of ids) insert.run(folderId, itemId, userId, now());
  })(itemIds);
}

export function deleteFolderItems(folderId: string, itemIds: string[], userId: string): void {
  if (itemIds.length === 0) return;
  const db = getDb();
  const remove = db.prepare(`
    DELETE FROM folder_items WHERE folder_id = ? AND item_id = ? AND user_id = ?
  `);
  db.transaction((ids: string[]) => {
    for (const itemId of ids) remove.run(folderId, itemId, userId);
  })(itemIds);
}

// ── Spaces (local-only persistence) ──────────────────────────────────────────

export interface SpaceRecord {
  id: string;
  name: string;
  /** Arbitrary JSON payload (nodes/edges/nodeCounters/viewport/…). */
  data: unknown;
  is_public: boolean;
  created_at: string;
  updated_at: string;
}

interface SpaceRow {
  id: string;
  name: string;
  data: string;
  is_public: number;
  created_at: string;
  updated_at: string;
}

/** Validates + normalizes an untrusted space payload from the client. */
export function normalizeSpace(input: unknown): SpaceRecord | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.id !== "string" || !obj.id) return null;
  if (typeof obj.name !== "string") return null;
  const createdAt = typeof obj.created_at === "string" ? obj.created_at : now();
  return {
    id: obj.id,
    name: obj.name,
    data: obj.data ?? {},
    is_public: obj.is_public === true,
    created_at: createdAt,
    updated_at: typeof obj.updated_at === "string" ? obj.updated_at : createdAt,
  };
}

function toSpaceRecord(row: SpaceRow): SpaceRecord {
  let data: unknown = {};
  try { data = JSON.parse(row.data); } catch { /* keep {} */ }
  return {
    id: row.id,
    name: row.name,
    data,
    is_public: row.is_public === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getSpaces(): SpaceRecord[] {
  const rows = getDb().prepare(
    "SELECT * FROM spaces ORDER BY created_at ASC"
  ).all() as SpaceRow[];
  return rows.map(toSpaceRecord);
}

/** Upserts spaces in a single transaction. Invalid rows are skipped. */
export function upsertSpaces(spaces: unknown[]): void {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO spaces (id, name, data, is_public, created_at, updated_at)
    VALUES (@id, @name, @data, @is_public, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      data = excluded.data,
      is_public = excluded.is_public,
      updated_at = excluded.updated_at
    WHERE excluded.updated_at >= spaces.updated_at
  `);
  db.transaction((rows: SpaceRecord[]) => {
    for (const sp of rows) {
      upsert.run({
        id: sp.id,
        name: sp.name,
        data: JSON.stringify(sp.data ?? {}),
        is_public: sp.is_public ? 1 : 0,
        created_at: sp.created_at,
        updated_at: sp.updated_at,
      });
    }
  })(spaces.map(normalizeSpace).filter((s): s is SpaceRecord => s !== null));
}

/** Deletes every space whose id is not in the given set (empty set = delete all). */
export function deleteSpaces(ids: string[]): void {
  const uniqueIds = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
  if (uniqueIds.length === 0) return;
  const placeholders = uniqueIds.map(() => "?").join(",");
  getDb().prepare(`DELETE FROM spaces WHERE id IN (${placeholders})`).run(...uniqueIds);
}

export function deleteSpace(id: string): void {
  deleteSpaces([id]);
}

// ── Chat sessions (local-only persistence) ────────────────────────────────────

export interface ChatSessionRecord {
  id: string;
  title: string;
  /** JSON array of { role, content } messages. */
  messages: unknown;
  model: string;
  created_at: string;
  updated_at: string;
}

interface ChatSessionRow {
  id: string;
  title: string;
  messages: string;
  model: string;
  created_at: string;
  updated_at: string;
}

/** Validates + normalizes an untrusted chat session payload from the client. */
export function normalizeChatSession(input: unknown): ChatSessionRecord | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.id !== "string" || !obj.id) return null;
  if (typeof obj.title !== "string") return null;
  if (typeof obj.model !== "string") return null;
  const messages = Array.isArray(obj.messages)
    ? obj.messages.filter((m): m is { role: string; content: string } => {
        if (!m || typeof m !== "object") return false;
        const role = (m as { role?: unknown }).role;
        const content = (m as { content?: unknown }).content;
        return (role === "user" || role === "assistant") && typeof content === "string";
      })
    : [];
  const createdAt = typeof obj.created_at === "string" ? obj.created_at : now();
  return {
    id: obj.id,
    title: obj.title,
    messages,
    model: obj.model,
    created_at: createdAt,
    updated_at: typeof obj.updated_at === "string" ? obj.updated_at : createdAt,
  };
}

function toChatSessionRecord(row: ChatSessionRow): ChatSessionRecord {
  let messages: unknown = [];
  try { messages = JSON.parse(row.messages); } catch { /* keep [] */ }
  return {
    id: row.id,
    title: row.title,
    messages,
    model: row.model,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getChatSessions(): ChatSessionRecord[] {
  const rows = getDb().prepare(
    "SELECT * FROM chat_sessions ORDER BY updated_at DESC"
  ).all() as ChatSessionRow[];
  return rows.map(toChatSessionRecord);
}

export function upsertChatSession(session: unknown): void {
  const rec = normalizeChatSession(session);
  if (!rec) return;
  getDb().prepare(`
    INSERT INTO chat_sessions (id, title, messages, model, created_at, updated_at)
    VALUES (@id, @title, @messages, @model, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      messages = excluded.messages,
      model = excluded.model,
      updated_at = excluded.updated_at
  `).run({
    id: rec.id,
    title: rec.title,
    messages: JSON.stringify(rec.messages),
    model: rec.model,
    created_at: rec.created_at,
    updated_at: rec.updated_at,
  });
}

export function deleteChatSession(id: string): void {
  getDb().prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
}

// ── Generic non-secret app settings (key/value JSON) ──────────────────────────

export function getAppSettings(): Record<string, unknown> {
  const rows = getDb().prepare("SELECT key, value FROM app_settings").all() as
    | { key: string; value: string }[]
    | undefined;
  const out: Record<string, unknown> = {};
  for (const row of rows ?? []) {
    try { out[row.key] = JSON.parse(row.value); } catch { /* skip malformed */ }
  }
  return out;
}

export function getAppSetting(key: string): unknown {
  const row = getDb().prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (!row) return undefined;
  try { return JSON.parse(row.value); } catch { return undefined; }
}

/** Upserts a subset of settings in a single transaction. */
export function setAppSettings(settings: Record<string, unknown>): void {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  db.transaction((entries: [string, unknown][]) => {
    for (const [key, value] of entries) {
      upsert.run(key, JSON.stringify(value), now());
    }
  })(Object.entries(settings));
}
