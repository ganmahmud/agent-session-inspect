import { join } from 'node:path';
import { readCodexCatalog } from '../../../../src/catalog.ts';
import { scanCodex } from '../../../../src/codex.ts';
import { readCodexSessionDetail } from '../../../../src/detail.ts';
import type { ScanResult, SessionDetail } from '../../../../src/types.ts';

const codexHome = process.env.CODEX_HOME || join(process.env.HOME || '', '.codex');
const sessionPath = process.env.ASI_SESSIONS_PATH || join(codexHome, 'sessions');
const catalogPaths = [codexHome, join(codexHome, 'sqlite')];

let cached: { createdAt: number; result: ScanResult } | undefined;

export async function sessionInventory(): Promise<ScanResult> {
	if (cached && Date.now() - cached.createdAt < 2_000) return cached.result;
	const catalog = readCodexCatalog(catalogPaths);
	const result = await scanCodex(sessionPath, { catalogTitles: catalog.titles, catalogErrors: catalog.errors });
	cached = { createdAt: Date.now(), result };
	return result;
}

export async function sessionDetail(id: string): Promise<SessionDetail | undefined> {
	const result = await sessionInventory();
	const session = result.sessions.find((item) => item.id === id);
	return session ? readCodexSessionDetail(session) : undefined;
}
