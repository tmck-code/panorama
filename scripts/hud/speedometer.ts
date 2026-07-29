import { PanelHandler } from 'util/module-helpers';
import { magnitude } from 'util/math';
import { RgbaTuple, tupleToRgbaString } from 'util/colors';
import { SpeedometerColorType, SpeedometerType } from 'common/speedometer';
import { TimerState } from 'common/timer';

// arbitrary value to determine how much speed needs to change to be considered an increase/decrease
// adjusted by speedometer update delta time
const COLORIZE_DEADZONE = 2;

const HIDDEN_CLASS = 'speedometer--hidden';
const INCREASE_CLASS = 'speedometer--increase';
const DECREASE_CLASS = 'speedometer--decrease';
const FADEOUT_CLASS = 'speedometer--fadeout';
const FADEOUT_START_CLASS = 'speedometer--fade-start';
const FADEOUT_START_FAST_CLASS = 'speedometer--fade-start-fast';

const AXIS_LABEL_CLASS = 'speedometer__axis';
const AXIS_COMPLABEL_CLASS = 'speedometer__axis__comparison';
const EVENT_LABEL_CLASS = 'speedometer__event';
const EVENT_COMPLABEL_CLASS = 'speedometer__event__comparison';
const EVENT_MERGED_CLASS = 'speedometer--merged';
const SPEEDOMETER_ROW_CLASS = 'speedometer-row';

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

interface Range {
	min: number;
	max: number;
	color: rgbaColor;
}

type RuntimeSettings = SpeedometerSettingsAPI.Settings & { range_colors?: Range[] };

class Speedometer {
	type: SpeedometerType;
	speedometerPanel: Panel;
	speedometerLabel: Label;
	comparisonLabel: Label;
	duckIcon: Panel;
	duckIconSpacer: Panel;
	duckBarFill: Panel;
	settings: RuntimeSettings;
	prevVal: number;
	fadeoutEventHandle: number;

	constructor(type: SpeedometerType, speedometerPanel: Panel, settings: SpeedometerSettingsAPI.Settings) {
		this.type = type;
		this.speedometerPanel = speedometerPanel;
		this.speedometerLabel = speedometerPanel.FindChildInLayoutFile('SpeedometerLabel');
		this.comparisonLabel = speedometerPanel.FindChildInLayoutFile('SpeedometerComparisonLabel');
		this.duckIcon = speedometerPanel.FindChildInLayoutFile('SpeedometerDuckIcon');
		this.duckIconSpacer = speedometerPanel.FindChildInLayoutFile('SpeedometerIconSpacer');
		this.duckBarFill = speedometerPanel.FindChildInLayoutFile('SpeedometerDuckBarFill');
		this.settings = settings;
		this.prevVal = 0;

		// The duck indicator only tracks the player's actual crouch state, which is
		// only meaningful on the live overall-velocity readout (not event speedos).
		// The spacer balances the icon's width so the label stays centered either way.
		if (this.type !== SpeedometerType.OVERALL_VELOCITY) {
			this.duckIcon.AddClass(HIDDEN_CLASS);
			this.duckIconSpacer.AddClass(HIDDEN_CLASS);
		}

		this.speedometerLabel.AddClass(
			this.type === SpeedometerType.OVERALL_VELOCITY ? AXIS_LABEL_CLASS : EVENT_LABEL_CLASS
		);
		this.comparisonLabel.AddClass(
			this.type === SpeedometerType.OVERALL_VELOCITY ? AXIS_COMPLABEL_CLASS : EVENT_COMPLABEL_CLASS
		);

		this.comparisonLabel.SetHasClass(
			HIDDEN_CLASS,
			this.settings.color_type !== SpeedometerColorType.COMPARISON_SEP
		);

		// remove status classes
		this.speedometerPanel.RemoveClass(FADEOUT_START_CLASS);
		this.speedometerPanel.RemoveClass(FADEOUT_START_FAST_CLASS);
		this.speedometerPanel.RemoveClass(FADEOUT_CLASS);
		this.speedometerLabel.RemoveClass(DECREASE_CLASS);
		this.speedometerLabel.RemoveClass(INCREASE_CLASS);
		this.comparisonLabel.RemoveClass(DECREASE_CLASS);
		this.comparisonLabel.RemoveClass(INCREASE_CLASS);
	}
}

@PanelHandler()
class SpeedometerHandler {
	container = $<Panel>('#SpeedometersContainer');
	correctedColorizeDeadzone = 0;

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

	speedometers: Map<SpeedometerType, Array<Speedometer>> = new Map();

	constructor() {
		$.RegisterEventHandler('OnExplosiveHitSpeedUpdate', this.container, (velocity: vec3) =>
			this.updateSpeedometersOfType(SpeedometerType.EXPLOSION_VELOCITY, velocity)
		);
		$.RegisterEventHandler('OnJumpSpeedUpdate', this.container, (speed: float) =>
			this.updateSpeedometersOfType(SpeedometerType.JUMP_VELOCITY, speed)
		);
		$.RegisterEventHandler('OnRampBoardSpeedUpdate', this.container, (velocity: vec3) =>
			this.updateSpeedometersOfType(SpeedometerType.RAMP_VELOCITY, velocity)
		);
		$.RegisterEventHandler('OnRampLeaveSpeedUpdate', this.container, (velocity: vec3) =>
			this.updateSpeedometersOfType(SpeedometerType.RAMP_VELOCITY, velocity)
		);
		$.RegisterEventHandler('OnSpeedometerUpdate', this.container, (deltaTime: float) =>
			this.onSpeedometerUpdate(deltaTime)
		);

		// Zone-velocity speedometer: capture the player's speed at the start of every segment.
		// This fires once per segment/stage, unlike the timer state which only changes at the
		// start and end of the whole run (so it stayed on stage 1's value on staged maps).
		$.RegisterForUnhandledEvent('OnObservedTimerSegmentEffectiveStart', () => this.onSegmentEffectiveStart());
		// Still needed purely to clear a stale readout when the run isn't going.
		$.RegisterForUnhandledEvent('OnObservedTimerStateChange', () => this.onTimerStateChange());

		// color profiles load before speedo settings, so listening to just the speedo settings load event should be enough
		$.RegisterForUnhandledEvent('OnSpeedometerSettingsLoaded', (succ: boolean) => this.onSettingsUpdate(succ));
		// do want to register when color profiles are saved though as that can happen independently
		$.RegisterForUnhandledEvent('OnSpeedometerSettingsSaved', (succ: boolean) => this.onSettingsUpdate(succ));
		$.RegisterForUnhandledEvent('OnRangeColorProfilesSaved', (succ: boolean) => this.onSettingsUpdate(succ));
	}

	registerFadeoutEventHandlers() {
		for (const [type, speedometers] of this.speedometers) {
			if (!this.canSpeedometerTypeFadeOut(type)) continue;

			for (const speedometer of speedometers) {
				speedometer.fadeoutEventHandle = $.RegisterEventHandler(
					'PropertyTransitionEnd',
					speedometer.speedometerPanel,
					(_, propertyName) => {
						if (propertyName !== 'opacity') return;

						// reset previous value on fadeout
						speedometer.prevVal = 0;
					}
				);
			}
		}
	}

	unregisterFadeoutEventHandlers() {
		for (const [type, speedometers] of this.speedometers) {
			if (!this.canSpeedometerTypeFadeOut(type)) continue;

			for (const speedometer of speedometers) {
				if (!speedometer.fadeoutEventHandle) continue;

				$.UnregisterEventHandler(
					'PropertyTransitionEnd',
					speedometer.speedometerPanel,
					speedometer.fadeoutEventHandle
				);
			}
		}
	}

	onSpeedometerUpdate(deltaTime: float) {
		const velocity = MomentumPlayerAPI.GetVelocity();

		this.correctedColorizeDeadzone = deltaTime * COLORIZE_DEADZONE;
		this.updateSpeedometersOfType(SpeedometerType.OVERALL_VELOCITY, velocity);
		this.updateYawSpeedDisplay();
		this.updateDuckIndicator();
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
		const speedometers = this.speedometers.get(SpeedometerType.OVERALL_VELOCITY);
		if (!speedometers) return;

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

		for (const speedometer of speedometers) {
			speedometer.duckBarFill.style.height = `${height}px`;
			speedometer.duckBarFill.style.backgroundColor = color;
			speedometer.duckBarFill.SetHasClass(HIDDEN_CLASS, !this.duckBarVisible);
		}
	}

	// Bar colour, lerped straight from duckProgress across the ramp's standing/crouched
	// endpoints.
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
		this.updateZoneSpeedometers(magnitude(MomentumPlayerAPI.GetVelocity()));
	}

	// Reset the readout whenever the run isn't actively going so a stale number doesn't linger.
	onTimerStateChange() {
		const { state } = MomentumTimerAPI.GetObservedTimerStatus();

		if (state === TimerState.DISABLED || state === TimerState.PRIMED) {
			this.resetSpeedometerFadeouts();
		}
	}

	resetSpeedometerFadeouts() {
		for (const [type, speedometers] of this.speedometers) {
			if (!this.canSpeedometerTypeFadeOut(type)) continue;

			for (const speedometer of speedometers) this.resetSpeedometerFadeout(speedometer);
		}
	}

	resetSpeedometerFadeout(speedometer: Speedometer) {
		// forcibly fade out immediately
		speedometer.speedometerPanel.RemoveClass(FADEOUT_START_CLASS);
		speedometer.speedometerPanel.RemoveClass(FADEOUT_START_FAST_CLASS);
		speedometer.speedometerPanel.TriggerClass(FADEOUT_CLASS);
		speedometer.prevVal = 0;
	}

	getSpeedFromVelocity({ x, y, z }: vec3, settings: SpeedometerSettingsAPI.Settings): float {
		const [xEnabled, yEnabled, zEnabled] = settings.enabled_axes;
		// @ts-expect-error - fastest way to do this, using type coercion (false = 0, true = 1)
		const numAxes = xEnabled + yEnabled + zEnabled;

		if (numAxes > 1) {
			let squaredParts = 0;
			if (xEnabled) squaredParts += x ** 2;
			if (yEnabled) squaredParts += y ** 2;
			if (zEnabled) squaredParts += z ** 2;
			return Math.sqrt(squaredParts);
		} else if (numAxes === 1) {
			if (xEnabled) return Math.abs(x);
			if (yEnabled) return Math.abs(y);
			if (zEnabled) return Math.abs(z);
		} else {
			$.Warning('Speedometer with no enabled axes found');
			return 0;
		}
	}

	// Display the given 3D speed on all zone-velocity speedometers. The absolute 3D magnitude
	// is shown regardless of each speedometer's enabled-axes setting, and no comparison diff
	// is shown (the engine doesn't expose a per-zone comparison velocity here).
	updateZoneSpeedometers(speed: float) {
		const speedometers = this.speedometers.get(SpeedometerType.ZONE_VELOCITY);
		if (!speedometers) return;

		for (const speedometer of speedometers) {
			this.updateSpeedometer(SpeedometerType.ZONE_VELOCITY, speedometer, speed, false);
		}
	}

	updateSpeedometersOfType(type: SpeedometerType, velocity: vec3 | number) {
		const speedometers = this.speedometers.get(type);
		if (!speedometers) return;

		for (const speedometer of speedometers) {
			// HACK: last jump speedometer type don't have full velocity vector, and so the velocity they pass in is actually speed
			// Refactor runstats to fix
			const speed =
				type === SpeedometerType.JUMP_VELOCITY
					? (velocity as number)
					: this.getSpeedFromVelocity(velocity as vec3, speedometer.settings);

			this.updateSpeedometer(type, speedometer, speed);
		}
	}

	updateSpeedometer(
		type: SpeedometerType,
		speedometer: Speedometer,
		speed: float,
		hasComparison = true,
		customdiff?: number
	) {
		const colorType = speedometer.settings.color_type;

		const separateComparison = colorType === SpeedometerColorType.COMPARISON_SEP;
		const speedometerHasComparison = colorType === SpeedometerColorType.COMPARISON || separateComparison;

		if (hasComparison && speedometerHasComparison) {
			const diff = customdiff ?? speed - speedometer.prevVal;

			const labelToColor = separateComparison ? speedometer.comparisonLabel : speedometer.speedometerLabel;
			let diffSymbol: string;
			if (diff - this.correctedColorizeDeadzone > 0) {
				labelToColor.AddClass(INCREASE_CLASS);
				labelToColor.RemoveClass(DECREASE_CLASS);
				diffSymbol = '+';
			} else if (diff + this.correctedColorizeDeadzone < 0) {
				labelToColor.AddClass(DECREASE_CLASS);
				labelToColor.RemoveClass(INCREASE_CLASS);
				diffSymbol = '-';
			} else {
				labelToColor.RemoveClass(INCREASE_CLASS);
				labelToColor.RemoveClass(DECREASE_CLASS);
				diffSymbol = '';
			}

			if (separateComparison) {
				speedometer.comparisonLabel.text = `${diffSymbol}${Math.round(Math.abs(diff))}`;
				speedometer.speedometerLabel.RemoveClass(INCREASE_CLASS);
				speedometer.speedometerLabel.RemoveClass(DECREASE_CLASS);
			}

			speedometer.prevVal = speed;
		} else {
			speedometer.speedometerLabel.RemoveClass(INCREASE_CLASS);
			speedometer.speedometerLabel.RemoveClass(DECREASE_CLASS);

			const rangeList = speedometer.settings.range_colors;
			if (colorType === SpeedometerColorType.RANGE && rangeList) {
				let found = false;
				for (const range of rangeList) {
					if (speed >= range.min && speed <= range.max) {
						speedometer.speedometerLabel.style.color = range.color;
						found = true;
					}
				}
				// backup to white
				if (!found) speedometer.speedometerLabel.style.color = 'rgba(255, 255, 255, 1)';
			}
		}

		speedometer.speedometerLabel.text = Math.round(speed);

		if (this.canSpeedometerTypeFadeOut(type)) {
			speedometer.speedometerPanel.AddClass(
				this.canSpeedometerTypeFadeOutFast(type) ? FADEOUT_START_FAST_CLASS : FADEOUT_START_CLASS
			);
			speedometer.speedometerPanel.TriggerClass(FADEOUT_CLASS);
		}
	}

	// Overall velocity speedometers shouldn't fade out as they constantly update
	canSpeedometerTypeFadeOut(type: SpeedometerType): boolean {
		return type !== SpeedometerType.OVERALL_VELOCITY;
	}

	// Jump/start velocity are one-off readouts for a single jump/segment, so they should
	// only stick around briefly rather than lingering like the other event speedometers.
	canSpeedometerTypeFadeOutFast(type: SpeedometerType): boolean {
		return type === SpeedometerType.JUMP_VELOCITY || type === SpeedometerType.ZONE_VELOCITY;
	}

	updateYawSpeedDisplay() {
		const yawSpeed = GameInterfaceAPI.GetSettingFloat('cl_yawspeed');
		const sensitivity = GameInterfaceAPI.GetSettingFloat('sensitivity');
		$.DispatchEvent('OnYawSpeedInfoUpdate', yawSpeed, sensitivity);
	}

	appendRangeColorProfileInfo(
		speedoData: RuntimeSettings,
		colorProfData: SpeedometerSettingsAPI.ColorProfile[]
	): Range {
		if (speedoData.color_type !== SpeedometerColorType.RANGE) return;

		const colorProf = speedoData.range_color_profile;
		if (!colorProf) return;

		const foundProfile = colorProfData.find((profile) => colorProf === profile.profile_name);
		if (!foundProfile) return;

		const ranges = foundProfile.profile_ranges;
		if (!ranges) return;

		speedoData.range_colors = ranges.map((range) => ({
			min: range.min,
			max: range.max,
			color: tupleToRgbaString(range.color)
		}));
	}

	onSettingsUpdate(success: boolean) {
		if (!success) {
			$.Warning('Failed to load speedometer settings from speedometer!');
			return;
		}

		const settings = SpeedometerSettingsAPI.GetCurrentGamemodeSettings();
		if (!settings) return;

		const colorProfiles = SpeedometerSettingsAPI.GetColorProfiles();
		if (!colorProfiles) return;

		this.unregisterFadeoutEventHandlers();
		this.container.RemoveAndDeleteChildren();

		this.speedometers = new Map();
		for (const speedo of settings) {
			const speedoType = speedo.type;
			if (speedoType == null) continue;

			this.appendRangeColorProfileInfo(speedo, colorProfiles);

			const newPanel = $.CreatePanel('Panel', this.container, '');
			newPanel.LoadLayoutSnippet('speedometer-entry');

			const speedometerContainer = newPanel.FindChildInLayoutFile<Panel>('SpeedometerContainer');

			const speedoObject = new Speedometer(speedoType, speedometerContainer, speedo);

			const speedometersArray = this.speedometers.get(speedoType) ?? [];
			speedometersArray.push(speedoObject);
			this.speedometers.set(speedoType, speedometersArray);
		}

		// Lay the zone-start-velocity readout out beside the jump-speed readout's row, so the
		// starting velocity appears next to the jump speed number instead of on its own line.
		// Each keeps its own fade/visibility state (they appear at different times: jump speed
		// on jumping, zone velocity only once the timer starts), only their position is shared.
		const [jumpSpeedometer] = this.speedometers.get(SpeedometerType.JUMP_VELOCITY) ?? [];
		const [zoneSpeedometer] = this.speedometers.get(SpeedometerType.ZONE_VELOCITY) ?? [];
		if (jumpSpeedometer && zoneSpeedometer) {
			const row = jumpSpeedometer.speedometerPanel.GetParent();
			row.AddClass(SPEEDOMETER_ROW_CLASS);
			zoneSpeedometer.speedometerPanel.AddClass(EVENT_MERGED_CLASS);
			zoneSpeedometer.speedometerPanel.SetParent(row);
		}

		this.registerFadeoutEventHandlers();
	}
}
