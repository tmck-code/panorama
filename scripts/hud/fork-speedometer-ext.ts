/**
 * FORK: additive extensions to the upstream speedometer, loaded as a second <include> in
 * layout/hud/speedometer.xml so it shares the MomHudSpeedometer panel context with speedometer.ts.
 *
 * Everything here reads the upstream SpeedometerHandler's public state; nothing monkeypatches upstream
 * methods. The few behaviours that live inside upstream method bodies (fast-fadeout class selection,
 * jump-velocity gating, zone speedometer body, EVENT_FLAT colour) remain as a minimal patch in
 * speedometer.ts and are marked with "FORK:" comments there.
 */
import { magnitude } from 'util/math';
import { RgbaTuple, tupleToRgbaString } from 'util/colors';
import { SpeedometerType } from 'common/speedometer';
import { TimerState } from 'common/timer';

const HIDDEN_CLASS = 'speedometer--hidden';
const FADEOUT_CLASS = 'speedometer--fadeout';
const FADEOUT_START_FAST_CLASS = 'speedometer--fade-start-fast';
const EVENT_MERGED_CLASS = 'speedometer--merged';
const SPEEDOMETER_ROW_CLASS = 'speedometer-row';

const DUCK_ICON_CLASS = 'fork-duck-icon';
const DUCK_BAR_FILL_CLASS = 'fork-duck-bar-fill';
const DUCK_SPACER_CLASS = 'fork-duck-spacer';

// Measured via edge-triggered console logging (duckpressed -> IsDucking delay): the crouch
// animation takes ~420ms to go down and ~220ms to stand back up.
const DUCK_DOWN_DURATION_MS = 420;
const DUCK_UP_DURATION_MS = 220;

// Once the stand-up animation completes, keep the (now fully-standing) bar on screen this
// long before hiding it, rather than disappearing the instant it reaches full height.
const DUCK_HIDE_DELAY_MS = 200;

// The bar's colour ramp, standing -> fully crouched. SCSS vars aren't reachable from TS,
// so these are duplicated here.
const DUCK_COLOR_WHITE: RgbaTuple = [255, 255, 255, 255];
const DUCK_COLOR_YELLOW: RgbaTuple = [255, 221, 0, 255];
const DUCK_BAR_RAMP: readonly [RgbaTuple, RgbaTuple] = [DUCK_COLOR_WHITE, DUCK_COLOR_YELLOW];

// The bar's silhouette height in px, standing -> fully crouched.
const DUCK_BAR_HEIGHT_STANDING = 18;
const DUCK_BAR_HEIGHT_CROUCHED = 7.5;

/** The subset of upstream's (unexported) Speedometer / SpeedometerHandler we rely on. */
interface UpstreamSpeedometer {
	type: SpeedometerType;
	speedometerPanel: Panel;
	speedometerLabel: Label;
	comparisonLabel: Label;
}

interface UpstreamSpeedometerHandler {
	container: Panel;
	speedometers: Map<SpeedometerType, UpstreamSpeedometer[]>;
	resetSpeedometerFadeouts(): void;
	updateZoneSpeedometers(speed: float): void;
}

function getUpstreamHandler(): UpstreamSpeedometerHandler | undefined {
	return $.GetContextObject()['SpeedometerHandler'] as UpstreamSpeedometerHandler | undefined;
}

class ForkSpeedometerExt {
	readonly handler: UpstreamSpeedometerHandler;

	/** Duck bar fill panel per overall-velocity speedometer, rebuilt whenever upstream rebuilds its panels. */
	duckBarFills: Panel[] = [];

	duckKeyPressed = false;
	duckKeyBindingSeen = false;

	// Drives the bar: interpolated 0 (standing) -> 1 (fully ducked) over real time, using the
	// measured crouch/stand durations, so it reads as a smooth gradient through the
	// transition rather than a binary flip.
	duckProgress = 0;
	duckAnimStartProgress = 0;
	duckAnimStartTime = 0;
	duckAnimTargetProgress = 0;
	duckAnimDurationMs = 0;

	// The bar is hidden by default and appears the instant the player starts crouching. Once
	// they stand back up and the animation settles, it lingers briefly before hiding again.
	duckBarVisible = false;
	duckHideAt: number | undefined = undefined;

	constructor(handler: UpstreamSpeedometerHandler) {
		this.handler = handler;

		// Zone-velocity speedometer: capture the player's speed at the start of every segment.
		// This fires once per segment/stage, unlike the timer state which only changes at the
		// start and end of the whole run (so it stayed on stage 1's value on staged maps).
		$.RegisterForUnhandledEvent('OnObservedTimerSegmentEffectiveStart', () => this.onSegmentEffectiveStart());
		// Still needed purely to clear a stale readout when the run isn't going.
		$.RegisterForUnhandledEvent('OnObservedTimerStateChange', () => this.onTimerStateChange());

		// Upstream rebuilds every speedometer panel on each of these; our listeners are registered after
		// upstream's (this module is included second) so they run once the new panels exist.
		for (const event of [
			'OnSpeedometerSettingsLoaded',
			'OnSpeedometerSettingsSaved',
			'OnRangeColorProfilesSaved'
		] as const) {
			$.RegisterForUnhandledEvent(event, (success: boolean) => this.onSpeedometersRebuilt(success));
		}

		// Per-frame tick, independent of upstream's OnSpeedometerUpdate handler.
		$.RegisterForUnhandledEvent('HudThink', () => this.updateDuckIndicator());

		// If upstream already built its panels before we got here (event fired before this module was
		// evaluated), decorate them now; otherwise the rebuild events above will do it.
		if (handler.speedometers.size > 0) this.onSpeedometersRebuilt(true);

		$.Msg(
			`fork-speedometer-ext: loaded (${handler.speedometers.size} speedometer type(s) already built, ` +
				`${this.duckBarFills.length} duck bar(s))`
		);
	}

	lastDecorateSummary = '';

	// Upstream rebuilds (RemoveAndDeleteChildren + fresh panels) on every settings load/save, which
	// the game fires in Loaded+Saved pairs whenever settings are written; each call here is cheap
	// (a few CreatePanel/SetParent calls) and only logs when the outcome changes.
	onSpeedometersRebuilt(success: boolean) {
		if (!success) return;
		this.createDuckIndicators();
		const merged = this.mergeJumpAndZoneRows();
		const summary = `${this.duckBarFills.length} duck bar(s), jump+zone row ${merged ? 'merged' : 'not merged'}`;
		if (summary !== this.lastDecorateSummary) {
			this.lastDecorateSummary = summary;
			$.Msg(`fork-speedometer-ext: decorated speedometers (${summary})`);
		}
	}

	// Crouch indicator DOM: [icon > fill] label [spacer] comparison, inside upstream's
	// flow-children: right .speedometer row. The spacer balances the icon's width so the label
	// stays centred. Only the live overall-velocity readout gets one (not event speedos, not energy).
	createDuckIndicators() {
		this.duckBarFills = [];
		const speedometers = this.handler.speedometers.get(SpeedometerType.OVERALL_VELOCITY) ?? [];
		for (const speedometer of speedometers) {
			const row = speedometer.speedometerPanel;
			// Idempotent: upstream recreates its panels on rebuild, but guard against being called twice
			// for the same panel (e.g. eager decoration followed by a late settings-loaded event).
			if (row.FindChildTraverse(DUCK_ICON_CLASS)) continue;

			// Class set explicitly rather than via CreatePanel's property bag, which is not reliably applied.
			const icon = $.CreatePanel('Panel', row, DUCK_ICON_CLASS);
			icon.AddClass(DUCK_ICON_CLASS);
			const fill = $.CreatePanel('Panel', icon, '');
			fill.AddClass(DUCK_BAR_FILL_CLASS);
			fill.AddClass(HIDDEN_CLASS);
			row.MoveChildBefore(icon, speedometer.speedometerLabel);

			const spacer = $.CreatePanel('Panel', row, '');
			spacer.AddClass(DUCK_SPACER_CLASS);
			row.MoveChildAfter(spacer, speedometer.speedometerLabel);

			this.duckBarFills.push(fill);
		}
	}

	// Lay the zone-start-velocity readout out beside the jump-speed readout's row, so the
	// starting velocity appears next to the jump speed number instead of on its own line.
	// Each keeps its own fade/visibility state (they appear at different times: jump speed
	// on jumping, zone velocity only once the timer starts), only their position is shared.
	mergeJumpAndZoneRows(): boolean {
		const [jumpSpeedometer] = this.handler.speedometers.get(SpeedometerType.JUMP_VELOCITY) ?? [];
		const [zoneSpeedometer] = this.handler.speedometers.get(SpeedometerType.ZONE_VELOCITY) ?? [];
		if (!jumpSpeedometer || !zoneSpeedometer) return false;

		const row = jumpSpeedometer.speedometerPanel.GetParent();
		row.AddClass(SPEEDOMETER_ROW_CLASS);
		zoneSpeedometer.speedometerPanel.AddClass(EVENT_MERGED_CLASS);
		if (zoneSpeedometer.speedometerPanel.GetParent() !== row) zoneSpeedometer.speedometerPanel.SetParent(row);
		return true;
	}

	// Crouch indicator: a silhouette bar that shrinks and changes colour as the player
	// crouches, hidden while standing. The duck key is bound (in autoexec.cfg) to flip the
	// `duckpressed` userinfo convar, giving an immediate key signal on BOTH edges - unlike
	// IsDucking(), which stays true for the whole stand-up animation and so would make the
	// uncrouch visibly lag the player model.
	// `duckpressed` reads 0 both when the convar is missing and when the key is up, so we
	// can't probe for it directly; instead we latch the first time we see it at 1 and from
	// then on trust it alone. Until then (and forever, for users without the cfg) we fall
	// back to the delayed crouch state.
	updateDuckIndicator() {
		if (this.duckBarFills.length === 0) return;

		const keyPressed = GameInterfaceAPI.GetSettingInt('duckpressed') === 1;
		if (keyPressed) this.duckKeyBindingSeen = true;
		const ducking = this.duckKeyBindingSeen ? keyPressed : MomentumPlayerAPI.IsDucking();

		const now = Date.now();
		if (ducking !== this.duckKeyPressed) {
			this.duckKeyPressed = ducking;
			this.duckAnimStartProgress = this.duckProgress;
			this.duckAnimStartTime = now;
			this.duckAnimTargetProgress = ducking ? 1 : 0;
			this.duckAnimDurationMs = ducking ? DUCK_DOWN_DURATION_MS : DUCK_UP_DURATION_MS;

			// Appear immediately (at full standing size) the instant a crouch starts; cancel
			// any pending hide from a previous stand-up.
			if (ducking) {
				this.duckBarVisible = true;
				this.duckHideAt = undefined;
			}
		}

		const elapsedMs = now - this.duckAnimStartTime;
		const t = this.duckAnimDurationMs > 0 ? Math.min(1, elapsedMs / this.duckAnimDurationMs) : 1;
		this.duckProgress = this.duckAnimStartProgress + (this.duckAnimTargetProgress - this.duckAnimStartProgress) * t;

		// Once the stand-up animation has fully settled, start (or continue) the delay before
		// hiding the bar.
		if (!ducking && t >= 1) {
			if (this.duckHideAt === undefined) this.duckHideAt = now + DUCK_HIDE_DELAY_MS;
			if (this.duckBarVisible && now >= this.duckHideAt) {
				this.duckBarVisible = false;
				this.duckHideAt = undefined;
			}
		}

		const height =
			DUCK_BAR_HEIGHT_STANDING - this.duckProgress * (DUCK_BAR_HEIGHT_STANDING - DUCK_BAR_HEIGHT_CROUCHED);
		const color = this.duckProgressColor(DUCK_BAR_RAMP);

		for (const fill of this.duckBarFills) {
			fill.style.height = `${height}px`;
			fill.style.backgroundColor = color;
			fill.SetHasClass(HIDDEN_CLASS, !this.duckBarVisible);
		}
	}

	// Bar colour, lerped straight from duckProgress across the ramp's standing/crouched endpoints.
	duckProgressColor([standing, crouched]: readonly [RgbaTuple, RgbaTuple]): string {
		const lerped = standing.map((channel, index) =>
			Math.round(channel + (crouched[index] - channel) * this.duckProgress)
		) as RgbaTuple;
		return tupleToRgbaString(lerped);
	}

	// Capture the player's speed at the start of each segment (stage/major checkpoint). The
	// segment itself records an effectiveStartVelocity, but that field doesn't come through the
	// splits serialisation as the `{x, y, z}` vec3 the typings promise, so sample the live
	// velocity instead - this event fires at the segment start, so it's the same moment.
	onSegmentEffectiveStart() {
		const speed = magnitude(MomentumPlayerAPI.GetVelocity());
		const zoneCount = this.handler.speedometers.get(SpeedometerType.ZONE_VELOCITY)?.length ?? 0;
		$.Msg(`fork-speedometer-ext: segment effective start, speed ${Math.round(speed)}, ${zoneCount} zone speedo(s)`);
		this.handler.updateZoneSpeedometers(speed);
		// Jump velocity is only ever relevant leading up to a segment start; sync its fadeout
		// with the zone velocity that just appeared so the two fade out together instead of the
		// jump number disappearing first.
		this.syncJumpFadeoutWithZone();
	}

	// Reset the readout whenever the run isn't actively going so a stale number doesn't linger.
	onTimerStateChange() {
		const { state } = MomentumTimerAPI.GetObservedTimerStatus();
		$.Msg(`fork-speedometer-ext: timer state -> ${TimerState[state]}`);
		if (state === TimerState.DISABLED || state === TimerState.PRIMED) {
			this.handler.resetSpeedometerFadeouts();
		}
	}

	// Restart the jump speedometer's fadeout timer in lockstep with the zone/start velocity
	// readout, so once the run starts they fade out together rather than the jump number (which
	// appeared earlier) fading first.
	syncJumpFadeoutWithZone() {
		const [jumpSpeedometer] = this.handler.speedometers.get(SpeedometerType.JUMP_VELOCITY) ?? [];
		if (!jumpSpeedometer) return;

		jumpSpeedometer.speedometerPanel.AddClass(FADEOUT_START_FAST_CLASS);
		jumpSpeedometer.speedometerPanel.TriggerClass(FADEOUT_CLASS);
	}
}

// Install once per panel context. Include order within <scripts> should put speedometer.ts first, but if
// upstream's handler isn't there yet, retry each frame (bounded) rather than giving up.
function installForkSpeedometerExt(attempt = 0): boolean {
	const contextObject = $.GetContextObject();
	if ('ForkSpeedometerExt' in contextObject) return true;

	const upstreamHandler = getUpstreamHandler();
	if (upstreamHandler) {
		contextObject['ForkSpeedometerExt'] = new ForkSpeedometerExt(upstreamHandler);
		return true;
	}

	if (attempt >= 300) {
		$.Warning('fork-speedometer-ext: SpeedometerHandler never appeared in panel context; fork extensions disabled');
		return false;
	}
	if (attempt === 0) $.Msg('fork-speedometer-ext: SpeedometerHandler not ready yet, deferring to HudThink');
	const handle = $.RegisterForUnhandledEvent('HudThink', () => {
		$.UnregisterForUnhandledEvent('HudThink', handle);
		installForkSpeedometerExt(attempt + 1);
	});
	return false;
}

installForkSpeedometerExt();
