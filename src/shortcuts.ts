import { createHmac } from 'node:crypto';

/** A widget can start sleep music without getting access to cameras or settings. */
export function sleepShortcutToken(automationToken: string): string {
  return createHmac('sha256', automationToken).update('eufy-recorder:shortcut:sleep-music:v1').digest('base64url');
}
