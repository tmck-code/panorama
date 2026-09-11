/**
 * FORK: automatic "death recovery" savestates.
 *
 *  - While the timer is RUNNING (or after a "continue", see below), runs `mom_savestate_create` every
 *    AUTO_INTERVAL seconds. The loop stops the moment the timer leaves RUNNING (death, finish, restart...) or
 *    `player_death` fires, so the newest savestates are from just before the death.
 *  - Y (autoexec.cfg alias `fork_ss_recover`) sets the `fork_ss_recover` userinfo marker; this script sees it,
 *    deletes the auto savestates newer than the RECOVER_BACK-th most recent one (as far back as exists) and
 *    teleports to the newest remaining slot. Y can be repeated.
 *  - Browse mode: after a recover the mouse wheel is switched to savestate navigation (surf_mom.cfg alias
 *    `wheel_mode_nav`: wheel = `mom_savestate_next`/`prev`). Scrolling cycles through the slots; every load
 *    re-arms a CONTINUE_AFTER countdown. Staying on a slot for CONTINUE_AFTER seconds "continues" from there:
 *    the auto slots ahead of it become 'stale' (discarded later, no teleport), the wheel goes back to normal
 *    (`wheel_mode_normal`) and recording resumes from that slot even though the official timer is not RUNNING.
 *    The wheel is also reset when the timer primes (start of map) or a real run starts, and only then - a
 *    manual "," toggle is never fought.
 *
 * Slot lifecycle - every slot in the game's list is tracked as one of:
 *  - 'user': created by the player. Never touched by this script.
 *  - 'auto': created here during the current attempt (RUNNING or continued). Survives death/respawn (the
 *    timer priming in the start zone deletes nothing) so Y still works after a respawn.
 *  - 'stale': an 'auto' slot from a previous attempt, or one ahead of the slot a continue started from. Every
 *    'auto' becomes 'stale' the moment the timer enters RUNNING (the player chose a fresh run instead of Y).
 *    If nothing but stale slots exist they are deleted on the spot (`mom_savestate_delete_all`, no teleport);
 *    otherwise they are peeled off the tail when the timer next PRIMES in the start zone (followed by
 *    `mom_restart_track`, harmless there) or on the next Y.
 *
 * Deletion is tail-only: `mom_savestate_last` then `mom_savestate_delete` while the newest slot is doomed.
 * There is no "goto N" command and every navigation command teleports; visiting the front of the list would
 * put the player back in/next to the start zone (slot 0 is created 0.5s into the run), which re-arms and
 * starts a real run and retires everything. So doomed slots sitting below a kept slot are left behind and
 * picked up by a later purge; the player only ever lands on the newest remaining slot.
 *
 * Death comes from the raw engine game event `player_death` via GameInterfaceAPI.RegisterGameEventHandler -
 * panorama exposes no first-class alive state (and in practice mode the event does not fire at all, so
 * nothing new relies on it). Savestate count, current index and per-slot kind are tracked from
 * `OnSaveStateUpdate`; there is no getter for the list. Our own command batches are mirrored synchronously
 * and their later events matched off an expected-count queue.
 *
 * Disable at runtime with `setinfo fork_ss_off 1` (re-enable with 0; H toggles via autoexec.cfg); on by default.
 */
import { PanelHandler } from 'util/module-helpers';
import { TimerState } from 'common/timer';
import { clearAnchors, removeAnchors } from 'common/fork-practice-anchors';

const AUTO_INTERVAL = 0.5;
/** Which auto savestate Y recovers to, counted from the newest (1 = newest). */
const RECOVER_BACK = 4;
/** Seconds to sit on a slot in browse mode before recording continues from it. */
const CONTINUE_AFTER = 5;
/** Opt-out marker (`setinfo fork_ss_off 1`): a missing userinfo convar reads as 0, so absent == enabled. */
const DISABLE_CONVAR = 'fork_ss_off';
/** Set to 1 by the Y bind; cleared here once handled. */
const RECOVER_CONVAR = 'fork_ss_recover';
const CMD_CREATE = 'mom_savestate_create';
const CMD_DELETE_ALL = 'mom_savestate_delete_all';
const CMD_LAST = 'mom_savestate_last';
const CMD_DELETE = 'mom_savestate_delete';
const CMD_RESTART_TRACK = 'mom_restart_track';
/** surf_mom.cfg aliases (idempotent): wheel = savestate next/prev, or the normal yawspeed/load binding. */
const CMD_WHEEL_NAV = 'wheel_mode_nav';
const CMD_WHEEL_NORMAL = 'wheel_mode_normal';
const LOG = (msg: string) => $.Msg(`fork-savestate-auto: ${msg}`);

type SlotKind = 'user' | 'auto' | 'stale';

@PanelHandler()
class ForkSavestateAutoHandler {
	dead = false;
	timerState: TimerState = TimerState.DISABLED;
	scheduleId: uuid | null = null;
	savestateCount = 0;
	/** Slot index the game last reported as current. */
	current = -1;
	/** Mirrors the game's savestate list: who owns each slot (see header). */
	kind: SlotKind[] = [];
	/** CMD_CREATEs issued whose OnSaveStateUpdate has not arrived yet. */
	pendingAuto = 0;
	/** Counts the game will report for OnSaveStateUpdate events caused by our own already-mirrored commands. */
	expectedCounts: number[] = [];
	/** True while the recover marker has been seen raised and not yet observed back at 0. */
	recoverLatched = false;
	/** Wheel is in savestate-nav mode after a recover; the continue countdown is armed. */
	browsing = false;
	continueId: uuid | null = null;
	/** Recording resumed from a browsed slot without the official timer RUNNING. */
	continued = false;
	lastEnabled: boolean | null = null;
	loggedDeath = false;

	constructor() {
		LOG('constructed');

		GameInterfaceAPI.RegisterGameEventHandler('player_death', () => this.onDeath());
		GameInterfaceAPI.RegisterGameEventHandler('player_spawn', () => (this.dead = false));

		$.RegisterForUnhandledEvent('OnObservedTimerStateChange', () => this.onTimerStateChange());
		$.RegisterForUnhandledEvent('OnSaveStateUpdate', (count, current) => this.onSaveStateUpdate(count, current));
		$.RegisterForUnhandledEvent('HudThink', () => this.pollRecover());
		$.RegisterForUnhandledEvent('LevelInitPostEntity', () => {
			this.dead = false;
			this.timerState = TimerState.DISABLED;
			this.savestateCount = 0;
			this.current = -1;
			this.kind.length = 0;
			this.pendingAuto = 0;
			this.expectedCounts.length = 0;
			this.browsing = false;
			this.continued = false;
			this.cancelContinue();
			this.stop();
		});
	}

	get enabled(): boolean {
		return GameInterfaceAPI.GetSettingInt(DISABLE_CONVAR) !== 1;
	}

	get running(): boolean {
		return this.timerState === TimerState.RUNNING;
	}

	slotsOf(...kinds: SlotKind[]): number[] {
		const slots: number[] = [];
		this.kind.forEach((k, i) => kinds.includes(k) && slots.push(i));
		return slots;
	}

	onDeath() {
		if (!this.loggedDeath) {
			LOG('player_death fired - stopping auto-savestates');
			this.loggedDeath = true;
		}
		this.dead = true;
		this.stop();
	}

	onSaveStateUpdate(count: number, current: number) {
		this.current = current;
		if (this.expectedCounts.length > 0) {
			if (this.expectedCounts[0] === count) {
				this.expectedCounts.shift();
				return;
			}
			// Out of step with our own batch: drop the queue and trust the game.
			this.expectedCounts.length = 0;
		}

		this.savestateCount = count;
		if (count > this.kind.length) {
			// Creation: the game appends, so `current` is the new slot.
			this.kind[current] = this.pendingAuto > 0 ? 'auto' : 'user';
			if (this.pendingAuto > 0) this.pendingAuto--;
			for (let i = 0; i < count; i++) this.kind[i] ??= 'user';
			this.kind.length = count;
		} else if (count < this.kind.length) {
			// External deletion we did not mirror: best-effort, assume the newest slots went.
			this.kind.length = count;
		} else if (this.browsing) {
			// Same count: a load (wheel next/prev or the game's own). Player is looking around; wait again.
			this.armContinue();
		}
	}

	onTimerStateChange() {
		const { state } = MomentumTimerAPI.GetObservedTimerStatus();
		if (state === this.timerState) return;
		this.timerState = state;

		if (state === TimerState.PRIMED) {
			this.leaveBrowse('PRIMED');
			this.purgeStale('PRIMED');
		} else if (state === TimerState.RUNNING) {
			this.leaveBrowse('RUNNING');
			if (!this.enabled) return;
			this.retireAuto();
			this.start();
		} else if (!this.continued) {
			this.stop();
		}
	}

	/** Respawn or real run: browse/continue are over; reset the wheel only if we switched it. */
	leaveBrowse(reason: string) {
		if (this.browsing) {
			this.cmd(CMD_WHEEL_NORMAL);
			LOG(`${reason}: wheel back to normal`);
		}
		this.browsing = false;
		this.cancelContinue();
		if (this.continued) {
			this.continued = false;
			this.stop();
		}
	}

	armContinue() {
		this.cancelContinue();
		this.continueId = $.Schedule(CONTINUE_AFTER, () => this.onContinue());
	}

	cancelContinue() {
		if (this.continueId === null) return;
		$.CancelScheduled(this.continueId);
		this.continueId = null;
	}

	/** Countdown fired on a browsed slot: everything ahead of it is discarded (lazily) and recording resumes. */
	onContinue() {
		this.continueId = null;
		if (!this.browsing) return;
		let retired = 0;
		for (let i = this.current + 1; i < this.kind.length; i++) {
			if (this.kind[i] === 'auto') {
				this.kind[i] = 'stale';
				retired++;
			}
		}
		this.cmd(CMD_WHEEL_NORMAL);
		this.browsing = false;
		this.continued = true;
		this.start();
		LOG(
			`continue from slot ${this.current}: ${retired} auto slots ahead marked stale, recording resumed, wheel back to normal`
		);
	}

	/** New run: the previous attempt's auto slots become stale; drop them now only if that empties the list. */
	retireAuto() {
		const retired = this.slotsOf('auto');
		for (const i of retired) this.kind[i] = 'stale';
		const stale = this.slotsOf('stale');
		if (stale.length === 0) return;
		if (stale.length === this.kind.length) {
			this.deleteAll();
			LOG(`RUNNING: deleted all ${stale.length} savestates (all stale)`);
			return;
		}
		LOG(
			`RUNNING: ${stale.length} stale slots kept alongside ${this.kind.length - stale.length} user slots until next PRIMED/Y`
		);
	}

	/** Peel stale slots off the tail, leaving user and current-attempt auto slots alone. */
	purgeStale(reason: string) {
		const stale = this.slotsOf('stale');
		if (stale.length === 0) return;
		if (stale.length === this.kind.length) {
			this.deleteAll();
			LOG(`${reason}: deleted all ${stale.length} savestates (all stale)`);
			return;
		}
		const deleted = this.peelTail(new Set(stale));
		if (deleted.length > 0) this.cmd(CMD_RESTART_TRACK);
		LOG(
			`${reason}: deleted ${deleted.length} stale savestates from the tail, ${stale.length - deleted.length} stale left behind below kept slots, ${this.kind.length} remain`
		);
	}

	cmd(c: string) {
		GameInterfaceAPI.ConsoleCommand(c);
	}

	deleteAll() {
		this.cmd(CMD_DELETE_ALL);
		this.expectedCounts.push(0);
		clearAnchors();
		this.kind.length = 0;
		this.savestateCount = 0;
	}

	/**
	 * Tail-only deletion: go to the newest slot (teleports there), then delete while the newest remaining
	 * slot is in `doomed`. Stops at the first kept slot; doomed slots below it are left for a later purge.
	 * Mirrors `kind`/anchors synchronously and queues the expected event counts. Returns the deleted indices.
	 */
	peelTail(doomed: Set<number>): number[] {
		const deleted: number[] = [];
		if (this.kind.length === 0) return deleted;
		this.cmd(CMD_LAST);
		this.expectedCounts.push(this.kind.length);
		while (this.kind.length > 0 && doomed.has(this.kind.length - 1)) {
			const idx = this.kind.length - 1;
			this.cmd(CMD_DELETE);
			this.kind.length = idx;
			this.expectedCounts.push(idx);
			deleted.push(idx);
		}
		removeAnchors(deleted);
		this.savestateCount = this.kind.length;
		return deleted;
	}

	/**
	 * Y bind sets `fork_ss_recover 1`; handle it once and clear it.
	 *
	 * Target is the RECOVER_BACK-th newest 'auto' slot. Doomed = auto slots newer than target plus every
	 * 'stale' slot; they are peeled off the tail and the player lands on the newest remaining slot (the target
	 * when nothing kept sits above it). User slots are untouched. No auto slots: nothing is deleted.
	 * A successful landing enters browse mode (wheel = savestate nav, continue countdown armed).
	 */
	pollRecover() {
		// Edge-triggered: the `setinfo 0` reset is applied asynchronously, so the marker still reads 1 for
		// several HudThinks after one press. Handle only the 0 -> 1 transition.
		const raised = GameInterfaceAPI.GetSettingInt(RECOVER_CONVAR) === 1;
		if (!raised) {
			this.recoverLatched = false;
			return;
		}
		if (this.recoverLatched) return;
		this.recoverLatched = true;
		this.cmd(`setinfo ${RECOVER_CONVAR} 0`);
		this.stop();
		this.continued = false;

		const autoIdx = this.slotsOf('auto');
		if (autoIdx.length === 0) {
			LOG('recover: no auto savestates');
			return;
		}

		const targetPos = Math.max(autoIdx.length - RECOVER_BACK, 0);
		const target = autoIdx[targetPos];
		const newer = autoIdx.slice(targetPos + 1);
		const stale = this.slotsOf('stale');
		const doomed = new Set([...newer, ...stale]);

		if (doomed.size === 0) {
			if (target !== this.kind.length - 1) {
				LOG(
					`recover: target slot ${target} not reachable without visiting other slots; landing on newest ${this.kind.length - 1}`
				);
			}
			this.cmd(CMD_LAST);
			this.expectedCounts.push(this.kind.length);
			this.enterBrowse();
			return;
		}

		const deleted = this.peelTail(doomed);
		this.cmd(CMD_LAST);
		this.expectedCounts.push(this.kind.length);
		const landed = this.kind.length - 1;
		LOG(
			`recover: deleted ${deleted.length} (${newer.length} newer auto + ${stale.length} stale doomed, ${doomed.size - deleted.length} left behind), ${this.kind.length} remain, landed on ${landed}${landed === target ? ' (target)' : ` (target was ${target})`}`
		);
		this.enterBrowse();
		// Savestates are intentionally kept: Y can be pressed again after another death. Auto ones are retired
		// only when the timer next enters RUNNING (see retireAuto) or a continue leaves them behind.
	}

	/** Landed after a recover: wheel becomes savestate nav and the continue countdown starts. */
	enterBrowse() {
		this.current = this.kind.length - 1;
		if (!this.browsing) this.cmd(CMD_WHEEL_NAV);
		this.browsing = true;
		this.armContinue();
	}

	start() {
		if (this.scheduleId !== null) return;
		this.scheduleId = $.Schedule(AUTO_INTERVAL, () => this.tick());
	}

	stop() {
		if (this.scheduleId === null) return;
		$.CancelScheduled(this.scheduleId);
		this.scheduleId = null;
	}

	tick() {
		this.scheduleId = null;
		if (this.dead || !(this.running || this.continued)) return;
		const enabled = this.enabled;
		if (enabled !== this.lastEnabled) {
			LOG(enabled ? 'enabled' : 'disabled');
			this.lastEnabled = enabled;
		}
		if (enabled) {
			this.cmd(CMD_CREATE);
			this.pendingAuto++;
		}
		this.start();
	}
}
