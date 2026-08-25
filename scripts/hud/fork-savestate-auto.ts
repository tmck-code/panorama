/**
 * FORK: automatic "death recovery" savestates.
 *
 *  - While the timer is RUNNING, runs `mom_savestate_create` every AUTO_INTERVAL seconds.
 *  - The loop stops the moment the timer leaves RUNNING (death, finish, restart...) or `player_death` fires,
 *    so the newest savestates are from just before the death.
 *  - Y (autoexec.cfg alias `fork_ss_recover`) sets the `fork_ss_recover` userinfo marker; this script sees it,
 *    teleports to the RECOVER_BACK-th most recent savestate (as far back as exists), keeping it plus the
 *    RECOVER_KEEP older ones and deleting the rest. Y can be repeated.
 *  - Savestates are only ever deleted when a new run starts legitimately (timer enters RUNNING).
 *
 * Death comes from the raw engine game event `player_death` via GameInterfaceAPI.RegisterGameEventHandler -
 * panorama exposes no first-class alive state. Savestate count is cached from `OnSaveStateUpdate`; there is no
 * getter.
 *
 * Disable at runtime with `setinfo fork_ss_off 1` (re-enable with 0; H toggles via autoexec.cfg); on by default.
 */
import { PanelHandler } from 'util/module-helpers';
import { TimerState } from 'common/timer';

const AUTO_INTERVAL = 0.5;
/** Which savestate Y recovers to, counted from the newest (1 = newest). */
const RECOVER_BACK = 4;
/** How many savestates older than the recovery target are preserved. */
const RECOVER_KEEP = 20;
/** Opt-out marker (`setinfo fork_ss_off 1`): a missing userinfo convar reads as 0, so absent == enabled. */
const DISABLE_CONVAR = 'fork_ss_off';
/** Set to 1 by the Y bind; cleared here once handled. */
const RECOVER_CONVAR = 'fork_ss_recover';
const CMD_CREATE = 'mom_savestate_create';
const CMD_DELETE_ALL = 'mom_savestate_delete_all';
const CMD_LAST = 'mom_savestate_last';
const CMD_FIRST = 'mom_savestate_first';
const CMD_DELETE = 'mom_savestate_delete';
const LOG = (msg: string) => $.Msg(`fork-savestate-auto: ${msg}`);

@PanelHandler()
class ForkSavestateAutoHandler {
	dead = false;
	running = false;
	scheduleId: uuid | null = null;
	savestateCount = 0;
	lastEnabled: boolean | null = null;
	loggedDeath = false;

	constructor() {
		LOG('constructed');

		GameInterfaceAPI.RegisterGameEventHandler('player_death', () => this.onDeath());
		GameInterfaceAPI.RegisterGameEventHandler('player_spawn', () => (this.dead = false));

		$.RegisterForUnhandledEvent('OnObservedTimerStateChange', () => this.onTimerStateChange());
		$.RegisterForUnhandledEvent('OnSaveStateUpdate', (count) => (this.savestateCount = count));
		$.RegisterForUnhandledEvent('HudThink', () => this.pollRecover());
		$.RegisterForUnhandledEvent('LevelInitPostEntity', () => {
			this.dead = false;
			this.running = false;
			this.savestateCount = 0;
			this.stop();
		});
	}

	get enabled(): boolean {
		return GameInterfaceAPI.GetSettingInt(DISABLE_CONVAR) !== 1;
	}

	onDeath() {
		if (!this.loggedDeath) {
			LOG('player_death fired - stopping auto-savestates');
			this.loggedDeath = true;
		}
		this.dead = true;
		this.stop();
	}

	onTimerStateChange() {
		const { state } = MomentumTimerAPI.GetObservedTimerStatus();
		const running = state === TimerState.RUNNING;
		if (running === this.running) return;
		this.running = running;

		if (running) {
			if (!this.enabled) return;
			// New run: discard everything from the previous attempt, then start recording.
			GameInterfaceAPI.ConsoleCommand(CMD_DELETE_ALL);
			this.start();
		} else {
			this.stop();
		}
	}

	/**
	 * Y bind sets `fork_ss_recover 1`; handle it once and clear it.
	 *
	 * Trims the list to [RECOVER_KEEP older ..., target] where target is the RECOVER_BACK-th newest, then
	 * teleports to target. `mom_savestate_delete` removes the current index without teleporting and, when
	 * the current one is the newest, steps the index back - so deleting from `last` peels newest-first,
	 * and deleting from `first` peels oldest-first. Everything runs within one frame.
	 */
	pollRecover() {
		if (GameInterfaceAPI.GetSettingInt(RECOVER_CONVAR) !== 1) return;
		GameInterfaceAPI.ConsoleCommand(`setinfo ${RECOVER_CONVAR} 0`);
		this.stop();

		let count = this.savestateCount;
		if (count === 0) {
			LOG('recover: no savestates');
			return;
		}

		// 1. Drop the newer-than-target savestates (the ones from just before death).
		const newer = Math.min(RECOVER_BACK, count) - 1;
		if (newer > 0) {
			GameInterfaceAPI.ConsoleCommand(CMD_LAST);
			for (let i = 0; i < newer; i++) GameInterfaceAPI.ConsoleCommand(CMD_DELETE);
			count -= newer;
		}

		// 2. Drop anything older than the RECOVER_KEEP we preserve before the target.
		const older = count - 1 - RECOVER_KEEP;
		if (older > 0) {
			GameInterfaceAPI.ConsoleCommand(CMD_FIRST);
			for (let i = 0; i < older; i++) GameInterfaceAPI.ConsoleCommand(CMD_DELETE);
			count -= older;
		}

		// 3. Target is now the newest; go there.
		GameInterfaceAPI.ConsoleCommand(CMD_LAST);
		this.savestateCount = count;
		LOG(`recover: dropped ${newer} newer / ${Math.max(older, 0)} older, ${count} kept, at newest`);
		// Savestates are intentionally kept: Y can be pressed again after another death. They are only
		// deleted when the next run starts (see onTimerStateChange).
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
		if (this.dead || !this.running) return;
		const enabled = this.enabled;
		if (enabled !== this.lastEnabled) {
			LOG(enabled ? 'enabled' : 'disabled');
			this.lastEnabled = enabled;
		}
		if (enabled) GameInterfaceAPI.ConsoleCommand(CMD_CREATE);
		this.start();
	}
}
