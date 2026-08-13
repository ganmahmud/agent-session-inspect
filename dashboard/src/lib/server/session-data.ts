import { join } from 'node:path';
import { readCodexCatalog } from '../../../../src/catalog.ts';
import { scanCodex } from '../../../../src/codex.ts';
import { readCodexSessionDetail } from '../../../../src/detail.ts';
import type { ScanResult, SessionDetail, SessionInventory, ReplyActivity, TokenSummary } from '../../../../src/types.ts';
export type { SessionDetail, SessionInventory, ReplyActivity, TokenSummary };

const codexHome = process.env.CODEX_HOME || join(process.env.HOME || '', '.codex');
const sessionPath = process.env.ASI_SESSIONS_PATH || join(codexHome, 'sessions');
const catalogPaths = [codexHome, join(codexHome, 'sqlite')];

let cached: { createdAt: number; result: ScanResult } | undefined;

/** In-memory store for imported session data (ephemeral — lost on server restart). */
const importedSessions = new Map<string, SessionDetail>();

export async function sessionInventory(): Promise<ScanResult> {
	if (cached && Date.now() - cached.createdAt < 2_000) return cached.result;
	const catalog = readCodexCatalog(catalogPaths);
	const result = await scanCodex(sessionPath, { catalogTitles: catalog.titles, catalogErrors: catalog.errors });
	cached = { createdAt: Date.now(), result };
	return result;
}

export async function sessionDetail(id: string): Promise<SessionDetail | undefined> {
	// Check imported sessions first
	const imported = importedSessions.get(id);
	if (imported) return imported;

	const result = await sessionInventory();
	const session = result.sessions.find((item) => item.id === id);
	return session ? readCodexSessionDetail(session) : undefined;
}

/** Store an imported session in the in-memory map and return its inventory entry. */
export function importSession(detail: SessionDetail): SessionInventory {
	importedSessions.set(detail.id, detail);
	// Synthesize a SessionInventory from the full detail for the sidebar
	const inv = { ...detail } as Record<string, unknown>;
	delete inv.conversation;
	delete inv.usage;
	delete inv.debug;
	if (!inv.token || !(inv.token as TokenSummary).last) {
		inv.token = detail.token;
	}
	return inv as unknown as SessionInventory;
}

/** Return all imported session inventory entries. */
export function getImportedSessionIds(): string[] {
	return Array.from(importedSessions.keys());
}

/** Remove an imported session from memory. */
export function deleteImportedSession(id: string): boolean {
	return importedSessions.delete(id);
}
