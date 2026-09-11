/**
 * FORK: practice timer - keeps timing across savestate loads.
 *
 * The official timer zeroes whenever a savestate is loaded (`mom_savestate` / fork-savestate-auto recover),
 * so in savestate practice there is no sense of "how long has this attempt taken". This label keeps its own
 * clock (MomentumMovementAPI.GetCurrentTime, ticked on HudThink) and stores an anchor per savestate slot:
 *
 *  - Slot created (count goes up in `OnSaveStateUpdate`): anchor = official runTime if the official timer is
 *    RUNNING, else our current elapsed.
 *  - Slot loaded (count unchanged): elapsed = anchor for `current`; the clock keeps running from there, so
 *    every load of the same savestate resumes from the same time.
 *  - Official timer enters RUNNING: reset to 0 and run (mirrors the real timer). FINISHED: finish.
 *  - In practice/savestate mode the official timer never FINISHES, zone events never reach Panorama and
 *    there is no player-origin API (all verified in-game), so the stop is manual: a userinfo marker
 *    `fork_pt_stop` (same mechanism as `fork_ss_recover`) is polled on HudThink. Running -> finish; already
 *    finished -> resume counting from the frozen total. Add to autoexec.cfg:
 *        alias "fork_pt_stop" "setinfo fork_pt_stop 1"
 *        bind "<key>" "fork_pt_stop"
 *        setinfo fork_pt_stop 0
 *  - Finished: clock freezes showing the total (green, `--finished` class) until the stop key, the next
 *    savestate load, official RUNNING, or map change.
 *  - LevelInitPostEntity: reset and hide.
 *  - `setinfo fork_pt_off 1` hides the whole element (0 shows it again; J toggles via autoexec.cfg).
 *
 * Anchors live in common/fork-practice-anchors.ts; fork-savestate-auto.ts mirrors its deletions there.
 */
import { PanelHandler } from 'util/module-helpers';
import { TimerState } from 'common/timer';
import { clearAnchors, getAnchor, setAnchor, truncateAnchors } from 'common/fork-practice-anchors';

const HIDDEN_CLASS = 'fork-practice-timer--hidden';
const FINISHED_CLASS = 'fork-practice-timer--finished';
/** Set to 1 by the stop-key bind (autoexec.cfg alias `fork_pt_stop`); cleared here once handled. */
const STOP_CONVAR = 'fork_pt_stop';
/** Hide switch (`setinfo fork_pt_off 1`); a missing userinfo convar reads as 0, so absent == shown. */
const OFF_CONVAR = 'fork_pt_off';
const OFF_CLASS = 'fork-practice-timer--off';
const LOG = (msg: string) => $.Msg(`fork-practice-timer: ${msg}`);

@PanelHandler()
class ForkPracticeTimerHandler {
	readonly panels = {
		cp: $.GetContextPanel<ForkPracticeTimer>()!
	};

	/** Elapsed seconds frozen at the last start/stop; live value adds time since `startedAt` while running. */
	elapsed = 0;
	startedAt: number | null = null;
	savestateCount = 0;
	finished = false;
	/** True while the stop marker has been seen raised and not yet observed back at 0. */
	stopLatched = false;

	constructor() {
		LOG('constructed');
		this.panels.cp.SetDialogVariableFloat('practice_time', 0);
		this.panels.cp.AddClass(HIDDEN_CLASS);

		$.RegisterForUnhandledEvent('HudThink', () => {
			this.render();
			this.pollStopKey();
			this.panels.cp.SetHasClass(OFF_CLASS, GameInterfaceAPI.GetSettingInt(OFF_CONVAR) === 1);
		});
		$.RegisterForUnhandledEvent('OnObservedTimerStateChange', () => this.onTimerStateChange());
		$.RegisterForUnhandledEvent('OnObservedTimerCheckpointProgressed', () => this.onCheckpoint());
		$.RegisterForUnhandledEvent('OnSaveStateUpdate', (count, current) => this.onSaveStateUpdate(count, current));
		$.RegisterForUnhandledEvent('LevelInitPostEntity', () => {
			this.reset();
			this.savestateCount = 0;
			clearAnchors();
			this.panels.cp.AddClass(HIDDEN_CLASS);
		});
	}

	get now(): number {
		return this.startedAt === null
			? this.elapsed
			: this.elapsed + MomentumMovementAPI.GetCurrentTime() - this.startedAt;
	}

	run(from: number) {
		this.elapsed = from;
		this.startedAt = MomentumMovementAPI.GetCurrentTime();
		this.finished = false;
		this.panels.cp.RemoveClass(HIDDEN_CLASS);
		this.panels.cp.RemoveClass(FINISHED_CLASS);
	}

	/** Freeze the clock at the total and show it in the finished style. */
	finish(source: string) {
		if (this.startedAt === null || this.finished) return;
		this.stop();
		this.finished = true;
		this.panels.cp.AddClass(FINISHED_CLASS);
		this.panels.cp.SetDialogVariableFloat('practice_time', this.elapsed);
		LOG(`finished via ${source}: total ${this.elapsed.toFixed(2)}s`);
	}

	stop() {
		this.elapsed = this.now;
		this.startedAt = null;
	}

	reset() {
		this.elapsed = 0;
		this.startedAt = null;
		this.finished = false;
		this.panels.cp.RemoveClass(FINISHED_CLASS);
	}

	render() {
		if (this.startedAt !== null) this.panels.cp.SetDialogVariableFloat('practice_time', this.now);
	}

	onTimerStateChange() {
		const { state } = MomentumTimerAPI.GetObservedTimerStatus();
		if (state === TimerState.RUNNING) {
			this.run(0);
		} else if (state === TimerState.FINISHED) {
			this.finish('OnObservedTimerStateChange FINISHED');
		}
	}

	onCheckpoint() {
		const { majorNum, minorNum, segmentsCount, segmentCheckpointsCount } =
			MomentumTimerAPI.GetObservedTimerStatus();
		LOG(`checkpoint progressed: ${majorNum}/${segmentsCount} ${minorNum}/${segmentCheckpointsCount}`);
	}

	/** Stop key sets `fork_pt_stop 1`; handle it once and clear it. Running -> finish; finished -> resume. */
	pollStopKey() {
		// Edge-triggered: the `setinfo 0` reset lands asynchronously, so the marker reads 1 for several frames.
		const raised = GameInterfaceAPI.GetSettingInt(STOP_CONVAR) === 1;
		if (!raised) {
			this.stopLatched = false;
			return;
		}
		if (this.stopLatched) return;
		this.stopLatched = true;
		GameInterfaceAPI.ConsoleCommand(`setinfo ${STOP_CONVAR} 0`);
		if (this.finished) {
			this.run(this.elapsed);
			LOG(`resumed via key from ${this.elapsed.toFixed(2)}s`);
		} else if (this.startedAt !== null) {
			this.finish('key');
		}
	}

	onSaveStateUpdate(count: number, current: number) {
		const prev = this.savestateCount;
		this.savestateCount = count;

		if (count > prev) {
			// Created. Anchor to the real run time while the official timer is live, else our own clock.
			const { state, runTime } = MomentumTimerAPI.GetObservedTimerStatus();
			const anchor = state === TimerState.RUNNING ? runTime : this.now;
			setAnchor(current, anchor);
			return;
		}
		if (count < prev) {
			truncateAnchors(count);
			return;
		}
		if (count === 0) return;

		// Same count: a load (or an index step). Resume from that slot's anchor.
		const anchor = getAnchor(current);
		if (anchor === undefined) {
			LOG(`load: no anchor for slot ${current}`);
			return;
		}
		this.run(anchor);
	}
}
