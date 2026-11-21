import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sleepWidget } from '../src/phone-widgets.ts';
import { sleepShortcutToken } from '../src/shortcuts.ts';

test('sleep widget has one manual action, a limited key, and stable IDs for repeat imports', () => {
  const key = 'example-access-key-'.repeat(3);
  const first = sleepWidget('http://recorder.example:8788', key);
  const second = sleepWidget('http://recorder.example:8788', 'replacement-access-key-'.repeat(3));
  assert.equal(first.macroList.length, 1);
  const macro = first.macroList[0];
  assert.equal(macro.m_triggerList[0].m_classType, 'WidgetPressedTrigger');
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
