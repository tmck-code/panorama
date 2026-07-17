import { PanelHandler } from 'util/module-helpers';
import { tupleToRgbaString } from 'util/colors';
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
const DUCKED_CLASS = 'speedometer__duck-icon--ducked';

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
		this.settings = settings;
		this.prevVal = 0;

		// The duck indicator only tracks the player's actual crouch state, which is
		// only meaningful on the live overall-velocity readout (not event speedos).
		if (this.type !== SpeedometerType.OVERALL_VELOCITY) {
			this.duckIcon.AddClass(HIDDEN_CLASS);
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
	prevTimerState: TimerState = TimerState.DISABLED;

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

		// Zone-velocity speedometer: capture the player's speed the instant the run timer
		// starts (transitions into RUNNING).
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

	// Lights the crouch glyph while the player is ducking. The duck key is bound (in
	// autoexec.cfg) to flip the `duckpressed` userinfo convar, giving an immediate
	// key-press signal; OR'd with the (delayed) crouch state so it still works without
	// the cfg and stays lit through the stand-up transition.
	updateDuckIndicator() {
		const speedometers = this.speedometers.get(SpeedometerType.OVERALL_VELOCITY);
		if (!speedometers) return;

		const keyPressed = GameInterfaceAPI.GetSettingInt('duckpressed') === 1;
		const ducking = keyPressed || MomentumPlayerAPI.IsDucking();

		for (const speedometer of speedometers) {
			speedometer.duckIcon.SetHasClass(DUCKED_CLASS, ducking);
		}
	}

	// Capture the player's speed the moment the timer starts running, and reset the readout
	// whenever the run isn't actively going so a stale number doesn't linger.
	onTimerStateChange() {
		const { state } = MomentumTimerAPI.GetObservedTimerStatus();

		if (state === TimerState.RUNNING && this.prevTimerState !== TimerState.RUNNING) {
			const v = MomentumPlayerAPI.GetVelocity();
			const speed = Math.sqrt(v.x ** 2 + v.y ** 2 + v.z ** 2);
			this.updateZoneSpeedometers(speed);
		} else if (state === TimerState.DISABLED || state === TimerState.PRIMED) {
			this.resetSpeedometerFadeouts();
		}

		this.prevTimerState = state;
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

		this.registerFadeoutEventHandlers();
	}
}
