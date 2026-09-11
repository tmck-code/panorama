/**
 * FORK: per-savestate-slot time anchors shared by fork-practice-timer.ts (reader/writer on create+load) and
 * fork-savestate-auto.ts (mirrors its own deletions so slot indices stay aligned with the game's list).
 *
 * Index == savestate slot index as reported by `OnSaveStateUpdate(count, current)`. Value == practice-timer
 * elapsed seconds at the moment that slot was created.
 */
const anchors: number[] = [];

export function anchorCount(): number {
	return anchors.length;
}

export function getAnchor(slot: number): number | undefined {
	return anchors[slot];
}

/** Slot `slot` was just created (the game appends, so `slot` should equal the old count). */
export function setAnchor(slot: number, seconds: number): void {
	anchors.length = slot;
	anchors[slot] = seconds;
}

export function clearAnchors(): void {
	anchors.length = 0;
}

/** Mirror fork-savestate-auto's own deletions: `slots` are indices in the current list (any order, deduped). */
export function removeAnchors(slots: number[]): void {
	for (const slot of [...slots].sort((a, b) => b - a)) {
		if (slot < anchors.length) anchors.splice(slot, 1);
	}
}

/** Best-effort handling of a deletion we did not make ourselves: assume the newest slots went. */
export function truncateAnchors(count: number): void {
	if (anchors.length > count) anchors.length = count;
}
