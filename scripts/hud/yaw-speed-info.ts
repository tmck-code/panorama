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
		this.yawSpeedLabel.text =
			`<font class="speedometer__yawspeed__value">${yawSpeed.toFixed(0)}</font> ` +
			'<font class="speedometer__yawspeed__unit">yaw</font>' +
			'<font class="speedometer__yawspeed__separator"> | </font>' +
			`<font class="speedometer__yawspeed__value">${sensitivity.toFixed(2)}</font> ` +
			'<font class="speedometer__yawspeed__unit">sens</font>';
	}
}
