import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { CatalogTitle } from './types.ts';

interface QueryableDatabase {
  prepare(sql: string): { all(): Array<Record<string, unknown>> };
  close(): void;
}

function openReadOnly(file: string): QueryableDatabase {
  try {
    return new DatabaseSync(file, { readOnly: true, timeout: 100 });
  } catch {
    // Read-only immutable mode avoids creating locks beside Codex's live files.
    // ponytail: immutable snapshots can lag an active WAL; direct read is always tried first.
    return new DatabaseSync(`${pathToFileURL(file).href}?immutable=1`, { readOnly: true });
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function rowsFromThreads(db: QueryableDatabase): CatalogTitle[] {
  const rows = db.prepare('SELECT id, title, updated_at, rollout_path FROM threads').all();
  return rows.flatMap((row) => {
    const sessionId = text(row.id);
    const title = text(row.title);
    return sessionId && title
      ? [{ sessionId, title, updatedAt: number(row.updated_at), rolloutPath: text(row.rollout_path), source: 'provider_catalog' as const }]
      : [];
  });
}

function rowsFromLocalCatalog(db: QueryableDatabase): CatalogTitle[] {
  const rows = db
    .prepare('SELECT thread_id, display_title, source_updated_at, source_detail FROM local_thread_catalog WHERE missing_candidate = 0')
    .all();
  return rows.flatMap((row) => {
    const sessionId = text(row.thread_id);
    const title = text(row.display_title);
    return sessionId && title
      ? [{ sessionId, title, updatedAt: number(row.source_updated_at), rolloutPath: text(row.source_detail), source: 'provider_catalog' as const }]
      : [];
  });
}

function readCatalogFile(file: string): CatalogTitle[] {
  const db = openReadOnly(file);
  try {
    try {
      return rowsFromThreads(db);
    } catch {
      return rowsFromLocalCatalog(db);
    }
  } finally {
    db.close();
  }
}

export function readCodexCatalog(catalogDirectories: string | string[]): { titles: CatalogTitle[]; errors: string[] } {
  const directories = Array.isArray(catalogDirectories) ? catalogDirectories : [catalogDirectories];
  const files: string[] = [];
  const titles: CatalogTitle[] = [];
  const errors: string[] = [];

  for (const catalogDir of directories) {
    try {
      if (!existsSync(catalogDir)) continue;
      const entries = readdirSync(catalogDir);
      for (const file of entries) {
        if (/^(state_.*\.sqlite|codex.*\.db)$/.test(file)) {
          files.push(join(catalogDir, file));
        }
      }
    } catch (err) {
      errors.push(`${catalogDir}: ${err instanceof Error ? err.message : 'unreadable directory'}`);
    }
  }

  for (const file of files) {
    try {
      titles.push(...readCatalogFile(file));
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : 'unreadable catalog'}`);
    }
  }

  return { titles, errors };
}
