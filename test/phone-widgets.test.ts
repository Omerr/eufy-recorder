import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sleepWidget } from '../src/phone-widgets.ts';
import { sleepShortcutToken, validateSleepLan } from '../src/shortcuts.ts';

test('sleep widget has one manual action, a limited key, and stable IDs for repeat imports', () => {
  const key = 'example-access-key-'.repeat(3);
  const first = sleepWidget('http://recorder.example:8788', key);
  const second = sleepWidget('http://recorder.example:8788', 'replacement-access-key-'.repeat(3));
  assert.equal(first.macroList.length, 1);
  const macro = first.macroList[0];
  assert.equal(macro.m_triggerList[0].m_classType, 'WidgetPressedTrigger');
  // MacroDroid's colored buttons activate every macro registered to that color.
  // Type 4 is a custom widget, selected by macro when placed on the launcher.
  assert.equal(macro.m_triggerList[0].m_widgetType, 4);
  assert.equal(macro.m_triggerList[0].m_widgetLabel, 'Sleep music');
  assert.deepEqual(macro.m_constraintList, []);
  assert.equal(macro.m_GUID, second.macroList[0].m_GUID);
  assert.equal(macro.m_GUID, sleepWidget('http://replacement.example:8788', key).macroList[0].m_GUID);
  assert.equal(macro.m_actionList[0].m_SIGUID, second.macroList[0].m_actionList[0].m_SIGUID);
  const request = macro.m_actionList[0].requestConfig;
  assert.equal(request.requestType, 1);
  assert.equal(request.urlToOpen, 'http://recorder.example:8788/api/shortcuts/sleep');
  assert.equal(request.contentBodyText, '{}');
  assert.equal(request.headerParams[0].paramValue, 'Bearer ' + sleepShortcutToken(key));
  assert.equal(JSON.stringify(first).includes(key), false);
  assert.throws(() => sleepWidget('https://example:secret@recorder.example', key), /private API/);
});

test('home Wi-Fi widget needs no VPN and LAN binding rejects public or wildcard addresses', () => {
  const widget = sleepWidget('http://recorder.example:8789', 'example-access-key-'.repeat(3), true);
  assert.match(widget.macroList[0].m_description, /home Wi-Fi/);
  assert.doesNotMatch(widget.macroList[0].m_description, /Tailscale/);
  validateSleepLan({ host: '127.0.0.1', port: 8789 });
  validateSleepLan({ host: [192, 168, 1, 2].join('.'), port: 8789 });
  assert.throws(() => validateSleepLan({ host: '0.0.0.0', port: 8789 }), /specific private/);
  assert.throws(() => validateSleepLan({ host: '203.0.113.10', port: 8789 }), /specific private/);
});
