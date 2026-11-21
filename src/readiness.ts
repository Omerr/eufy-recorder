import type { AutomationConfig, AutomationDevice, Presence } from './automation.ts';

export interface ReadinessCheck {
  name: string;
  status: 'ok' | 'failed' | 'attention';
  detail: string;
}

export async function checkReadiness(
  config: AutomationConfig, presence: Presence,
  checkDevice: (device: AutomationDevice, signal: AbortSignal) => Promise<string>, signal: AbortSignal,
) {
  const checkedAt = new Date().toISOString();
  const devices = await Promise.all(Object.entries(config.devices)
    .filter(([, device]) => device.type === 'yeelight' || device.type === 'yoto')
    .map(async ([name, device]): Promise<ReadinessCheck> => {
      try {
        const detail = await checkDevice(device, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
        return { name, status: 'ok', detail };
      } catch {
        return { name, status: 'failed', detail: device.type === 'yoto'
          ? 'No live player reply. Check power, Wi-Fi, internet, and Yoto login.'
          : 'No lamp reply. Check mains power, Wi-Fi, and LAN Control.' };
      }
    }));
  const state = presence.snapshot(config.presenceMaxAgeMinutes).state;
  const enabled = config.enabled && config.rules.some(rule => rule.enabled && rule.actions.some(action =>
    ['yeelight', 'yoto'].includes(config.devices[action.device]?.type)));
  const checks: ReadinessCheck[] = [
    { name: 'Recorder', status: 'ok', detail: 'Control service is running.' },
    ...devices,
    { name: 'Household presence', status: state === 'unknown' ? 'attention' : 'ok', detail: state === 'unknown'
      ? 'Unknown. Away-only responses are blocked.' : `${state}. Presence conditions still apply.` },
    { name: 'Automatic responses', status: enabled ? 'ok' : 'attention', detail: enabled
      ? 'Response rules enabled. Camera, time, presence, and cooldown conditions still apply.' : 'Light and music responses are paused.' },
  ];
  return {
    checkedAt, devicesReachable: devices.length > 0 && devices.every(check => check.status === 'ok'),
    ready: devices.length > 0 && checks.every(check => check.status === 'ok'), checks,
    note: 'This checks current connections. Use a camera recording test to verify capture and a playback test to verify audible sound.',
  };
}
