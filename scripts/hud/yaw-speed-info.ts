import { PanelHandler } from 'util/module-helpers';

// Bridges the yaw speed/sensitivity readout from MomHudSpeedometer's isolated script context
// (speedometer.ts, which computes the values) to the static label declared in hud.xml. A plain
// $() lookup can't cross custom control script boundaries, so speedometer.ts dispatches a global
// event instead, which this handler (loaded by hud.xml itself, the same document as the label)
// listens for.
@PanelHandler()
class YawSpeedInfoHandler {
	yawSpeedLabel = $<Label>('#SpeedometerYawSpeedLabel');

	constructor() {
		$.RegisterForUnhandledEvent('OnYawSpeedInfoUpdate', (yawSpeed: float, sensitivity: float) =>
			this.onYawSpeedInfoUpdate(yawSpeed, sensitivity)
		);
	}

	onYawSpeedInfoUpdate(yawSpeed: float, sensitivity: float) {
		this.yawSpeedLabel.text = `${yawSpeed.toFixed(0)} | ${sensitivity.toFixed(2)}`;
	}
}
