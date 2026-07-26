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

const AXIS_LABEL_CLASS = 'speedometer__axis';
const AXIS_COMPLABEL_CLASS = 'speedometer__axis__comparison';
const EVENT_LABEL_CLASS = 'speedometer__event';
const EVENT_COMPLABEL_CLASS = 'speedometer__event__comparison';
const EVENT_MERGED_CLASS = 'speedometer--merged';
const SPEEDOMETER_ROW_CLASS = 'speedometer-row';
const DUCK_DOT_LIT_CLASS = 'speedometer__duck-dot--lit';

// Measured via edge-triggered console logging (duckpressed -> IsDucking delay): the crouch
// animation takes ~420ms to go down and ~220ms to stand back up.
const DUCK_DOWN_DURATION_MS = 420;
const DUCK_UP_DURATION_MS = 220;

// Crouch-indicator variants, selected live by the `duckstyle` convar (see autoexec.cfg).
// The order here is the convar's numeric value, so it must stay in sync with the
// `incrementvar duckstyle 0 3 1` range that cycles them in-game.
const enum DuckStyle {
	PIPS = 0,
	BAR = 1,
	CHEVRON = 2,
	GAUGE = 3
}
const DUCK_STYLE_COUNT = 4;

// The bar/chevron variants lerp their colour per-frame rather than switching classes, and
// SCSS vars aren't reachable from TS - so the endpoints are duplicated here. Yellow mirrors
// `$speedometer-color-default` (#ffee00) and green mirrors `$speedometer-color-increase`
// (#b3ff00); white has no SCSS counterpart, it's just the bar's neutral standing colour.
const DUCK_COLOR_WHITE: RgbaTuple = [255, 255, 255, 255];
const DUCK_COLOR_YELLOW: RgbaTuple = [255, 238, 0, 255];
const DUCK_COLOR_GREEN: RgbaTuple = [179, 255, 0, 255];

// Per-variant colour ramps, standing -> fully crouched. The bar reads as a neutral
// silhouette until the crouch is committed; the chevron keeps its original yellow ramp.
const DUCK_BAR_RAMP: readonly [RgbaTuple, RgbaTuple] = [DUCK_COLOR_WHITE, DUCK_COLOR_GREEN];
const DUCK_CHEVRON_RAMP: readonly [RgbaTuple, RgbaTuple] = [DUCK_COLOR_YELLOW, DUCK_COLOR_GREEN];

// The bar variant's silhouette height in px, standing -> fully crouched.
const DUCK_BAR_HEIGHT_STANDING = 12;
const DUCK_BAR_HEIGHT_CROUCHED = 5;

// The chevron variant's rotation in degrees, pointing up (standing) -> down (crouched).
const DUCK_CHEVRON_ROTATION_STANDING = 225;
const DUCK_CHEVRON_ROTATION_CROUCHED = 45;

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
	yawSpeedLabel: Label;
	duckIcon: Panel;
	duckIconSpacer: Panel;
	duckStandDot: Panel;
	duckProgressDot: Panel;
	duckFullDot: Panel;
	// Root panel of each crouch-indicator variant, indexed by DuckStyle so the handler can
	// show exactly one of them without a switch per frame.
	duckVariants: Panel[];
	duckBarFill: Panel;
	duckChevronArrow: Panel;
	duckGaugeFill: Panel;
	settings: RuntimeSettings;
	prevVal: number;
	fadeoutEventHandle: number;

	constructor(type: SpeedometerType, speedometerPanel: Panel, settings: SpeedometerSettingsAPI.Settings) {
		this.type = type;
		this.speedometerPanel = speedometerPanel;
		this.speedometerLabel = speedometerPanel.FindChildInLayoutFile('SpeedometerLabel');
		this.comparisonLabel = speedometerPanel.FindChildInLayoutFile('SpeedometerComparisonLabel');
		this.yawSpeedLabel = speedometerPanel.FindChildInLayoutFile('SpeedometerYawSpeedLabel');
		this.duckIcon = speedometerPanel.FindChildInLayoutFile('SpeedometerDuckIcon');
		this.duckIconSpacer = speedometerPanel.FindChildInLayoutFile('SpeedometerIconSpacer');
		this.duckStandDot = speedometerPanel.FindChildInLayoutFile('SpeedometerDuckStandDot');
		this.duckProgressDot = speedometerPanel.FindChildInLayoutFile('SpeedometerDuckProgressDot');
		this.duckFullDot = speedometerPanel.FindChildInLayoutFile('SpeedometerDuckFullDot');
		this.duckVariants = [
			speedometerPanel.FindChildInLayoutFile('SpeedometerDuckPips'),
			speedometerPanel.FindChildInLayoutFile('SpeedometerDuckBar'),
			speedometerPanel.FindChildInLayoutFile('SpeedometerDuckChevron'),
			speedometerPanel.FindChildInLayoutFile('SpeedometerDuckGauge')
		];
		this.duckBarFill = speedometerPanel.FindChildInLayoutFile('SpeedometerDuckBarFill');
		this.duckChevronArrow = speedometerPanel.FindChildInLayoutFile('SpeedometerDuckChevronArrow');
		this.duckGaugeFill = speedometerPanel.FindChildInLayoutFile('SpeedometerDuckGaugeFill');
		this.settings = settings;
		this.prevVal = 0;

		// Start on the default variant; the handler swaps in the convar's choice on the
		// first tick after these panels are built.
		for (const [index, variant] of this.duckVariants.entries()) {
			variant.SetHasClass(HIDDEN_CLASS, index !== DuckStyle.PIPS);
		}

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

	// Drives the middle "in progress" dot: interpolated 0 (standing) -> 1 (fully ducked) over
	// real time, using the measured crouch/stand durations, so it reads as a smooth gradient
	// through the transition rather than a binary flip.
	duckKeyPressed = false;
	duckProgress = 0;
	duckAnimStartProgress = 0;
	duckAnimStartTime = 0;
	duckAnimTargetProgress = 0;
	duckAnimDurationMs = 0;

	// Last `duckstyle` value we applied show/hide classes for. Starts invalid so the first
	// tick (and every rebuild of the speedometer panels) reapplies them.
	duckStyle: DuckStyle | -1 = -1;

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

	// Crouch indicator, drawn in one of four interchangeable styles (see DuckStyle). The duck
	// key is bound (in autoexec.cfg) to flip the `duckpressed` userinfo convar, giving an
	// immediate key-press signal; OR'd with the (delayed) crouch state so it still works
	// without the cfg and stays lit through the stand-up transition.
	updateDuckIndicator() {
		const speedometers = this.speedometers.get(SpeedometerType.OVERALL_VELOCITY);
		if (!speedometers) return;

		const keyPressed = GameInterfaceAPI.GetSettingInt('duckpressed') === 1;
		const ducking = keyPressed || MomentumPlayerAPI.IsDucking();

		const now = Date.now();
		if (ducking !== this.duckKeyPressed) {
			this.duckKeyPressed = ducking;
			this.duckAnimStartProgress = this.duckProgress;
			this.duckAnimStartTime = now;
			this.duckAnimTargetProgress = ducking ? 1 : 0;
			this.duckAnimDurationMs = ducking ? DUCK_DOWN_DURATION_MS : DUCK_UP_DURATION_MS;
		}

		const elapsedMs = now - this.duckAnimStartTime;
		const t = this.duckAnimDurationMs > 0 ? Math.min(1, elapsedMs / this.duckAnimDurationMs) : 1;
		this.duckProgress = this.duckAnimStartProgress + (this.duckAnimTargetProgress - this.duckAnimStartProgress) * t;

		// Polled rather than listened to (this already runs every tick), but the show/hide
		// classes are only reapplied when the selection actually changes.
		const style = this.readDuckStyle();
		const styleChanged = style !== this.duckStyle;
		this.duckStyle = style;

		for (const speedometer of speedometers) {
			if (styleChanged) {
				for (const [index, variant] of speedometer.duckVariants.entries()) {
					variant.SetHasClass(HIDDEN_CLASS, index !== style);
				}
			}

			// Only the visible variant is worth updating; the hidden ones are re-synced on
			// the tick they're switched back in.
			switch (style) {
				case DuckStyle.PIPS: {
					speedometer.duckStandDot.SetHasClass(DUCK_DOT_LIT_CLASS, !ducking);
					speedometer.duckFullDot.SetHasClass(DUCK_DOT_LIT_CLASS, ducking);
					speedometer.duckProgressDot.style.opacity = (0.15 + this.duckProgress * 0.85).toString();
					break;
				}
				case DuckStyle.BAR: {
					const height =
						DUCK_BAR_HEIGHT_STANDING -
						this.duckProgress * (DUCK_BAR_HEIGHT_STANDING - DUCK_BAR_HEIGHT_CROUCHED);
					speedometer.duckBarFill.style.height = `${height}px`;
					speedometer.duckBarFill.style.backgroundColor = this.duckProgressColor(DUCK_BAR_RAMP);
					break;
				}
				case DuckStyle.CHEVRON: {
					const rotation =
						DUCK_CHEVRON_ROTATION_STANDING -
						this.duckProgress * (DUCK_CHEVRON_ROTATION_STANDING - DUCK_CHEVRON_ROTATION_CROUCHED);
					const color = this.duckProgressColor(DUCK_CHEVRON_RAMP);
					speedometer.duckChevronArrow.style.transform = `rotateZ(${rotation}deg)`;
					// Only the two borders that form the arrowhead are set in SCSS, so both
					// need recolouring - there's no single colour property to drive here.
					speedometer.duckChevronArrow.style.borderRightColor = color;
					speedometer.duckChevronArrow.style.borderBottomColor = color;
					break;
				}
				case DuckStyle.GAUGE: {
					speedometer.duckGaugeFill.style.height = `${this.duckProgress * 100}%`;
					break;
				}
			}
		}
	}

	// Guards a missing or out-of-range convar back to the default variant, since setinfo
	// values are user-editable and `incrementvar` bounds aren't enforced on manual sets.
	readDuckStyle(): DuckStyle {
		const value = GameInterfaceAPI.GetSettingInt('duckstyle');
		if (!Number.isInteger(value) || value < 0 || value >= DUCK_STYLE_COUNT) return DuckStyle.PIPS;
		return value as DuckStyle;
	}

	// Colour for the variants that morph a single element, lerped straight from duckProgress.
	// The ramp is passed in because each variant has its own standing/crouched endpoints.
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
			speedometer.speedometerPanel.AddClass(FADEOUT_START_CLASS);
			speedometer.speedometerPanel.TriggerClass(FADEOUT_CLASS);
		}
	}

	// Overall velocity speedometers shouldn't fade out as they constantly update
	canSpeedometerTypeFadeOut(type: SpeedometerType): boolean {
		return type !== SpeedometerType.OVERALL_VELOCITY;
	}

	updateYawSpeedDisplay() {
		const yawSpeed = GameInterfaceAPI.GetSettingFloat('cl_yawspeed');
		const sensitivity = GameInterfaceAPI.GetSettingFloat('sensitivity');
		const speedometers = this.speedometers.get(SpeedometerType.OVERALL_VELOCITY);
		if (!speedometers) return;

		for (const speedometer of speedometers) {
			speedometer.yawSpeedLabel.text = `${yawSpeed.toFixed(0)} | ${sensitivity.toFixed(2)}`;
		}
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

		// Panels are rebuilt below, so the cached duck style no longer describes them.
		this.duckStyle = -1;

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
