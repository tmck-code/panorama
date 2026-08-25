/**
 * FORK: yaw speed / mouse sensitivity readout, a standalone HUD panel registered with the HUD customizer
 * so it can be moved, resized and recoloured in-game (persisted to the cfg/hud/*.kv3 preset).
 */
import { PanelHandler } from 'util/module-helpers';
import { CustomizerPropertyType, registerHUDCustomizerComponent } from 'common/hud-customizer';

const VALUE_CLASS = 'fork-yaw-speed-info__value';
const UNIT_CLASS = 'fork-yaw-speed-info__unit';
const SEPARATOR_CLASS = 'fork-yaw-speed-info__separator';

@PanelHandler()
class ForkYawSpeedInfoHandler {
	readonly panels = {
		cp: $.GetContextPanel<ForkYawSpeedInfo>(),
		label: $<Label>('#ForkYawSpeedInfoLabel')
	};

	lastText = '';
	/** Colour of the numeric values; defaults come from styles/fork/yaw-speed-info.scss. */
	valueColor: string | undefined;

	constructor() {
		$.Msg('fork-yaw-speed-info: constructed');
		// Tick directly rather than via the customizer's `unhandledEvents`: those are only wired once the
		// component registers successfully, and the readout must work even if registration is refused.
		$.RegisterForUnhandledEvent('HudThink', () => this.update());

		registerHUDCustomizerComponent(this.panels.cp, {
			name: 'Yaw / Sensitivity (fork)',
			resizeX: true,
			resizeY: false,
			// Not in the game-shipped cfg/hud/*_default.kv3, so supply the defaults here (1920x1080 units):
			// bottom-centre, 108px above the bottom edge, matching styles/fork/yaw-speed-info.scss.
			defaultLayout: {
				offsetX: 800,
				offsetY: 960,
				width: 320,
				dynamicStyles: { fontSize: 8, valueColor: 'rgba(200, 200, 200, 1)' }
			},
			postInit: () => $.Msg('fork-yaw-speed-info: registered with HUD customizer'),
			dynamicStyles: {
				fontSize: {
					name: $.Localize('#Customizer_FontSize'),
					type: CustomizerPropertyType.NUMBER_ENTRY,
					targetPanel: '.fork-yaw-speed-info__label',
					styleProperty: 'fontSize',
					valueFn: (value) => `${value}px`
				},
				valueColor: {
					name: $.Localize('#Customizer_FontColor'),
					type: CustomizerPropertyType.COLOR_PICKER,
					callbackFunc: (_, value) => {
						this.valueColor = value as string;
						this.lastText = '';
					}
				}
			}
		});
	}

	update() {
		const yawSpeed = GameInterfaceAPI.GetSettingFloat('cl_yawspeed');
		const sensitivity = GameInterfaceAPI.GetSettingFloat('sensitivity');
		const valueAttrs = this.valueColor
			? `class="${VALUE_CLASS}" color="${this.valueColor}"`
			: `class="${VALUE_CLASS}"`;
		const text =
			`<font ${valueAttrs}>${yawSpeed.toFixed(0)}</font> ` +
			`<font class="${UNIT_CLASS}">yaw</font>` +
			`<font class="${SEPARATOR_CLASS}"> | </font>` +
			`<font ${valueAttrs}>${sensitivity.toFixed(2)}</font> ` +
			`<font class="${UNIT_CLASS}">sens</font>`;
		if (text === this.lastText) return;
		if (this.lastText === '')
			$.Msg(`fork-yaw-speed-info: first update: ${yawSpeed.toFixed(0)} yaw | ${sensitivity.toFixed(2)} sens`);
		this.lastText = text;
		this.panels.label.text = text;
	}
}
