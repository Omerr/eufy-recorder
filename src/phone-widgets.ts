import { createHash } from 'node:crypto';
import { sleepShortcutToken } from './shortcuts.ts';

/** A standalone MacroDroid import containing only the sleep playback widget. */
export function sleepWidget(apiOrigin: string, automationToken: string) {
  const origin = new URL(apiOrigin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || automationToken.length < 32) {
    throw new Error('A private API origin and automation access key are required.');
  }
  // Stable IDs let a repeated import update the existing macro on either phone.
  const id = (role: string) => createHash('sha256').update(`eufy-recorder:sleep-widget:v1:${role}`).digest().readUIntBE(0, 6);
  const item = (type: string, role: string) => ({ m_classType: type, m_SIGUID: id(role), m_constraintList: [],
    m_isDisabled: false, m_isOrCondition: false, m_comment: '', disableLogging: true });
  return {
    exportFormat: 2, exportAppVersion: 601000005, timestamp: Date.now(), variables: [],
    macroList: [{
      m_GUID: id('macro'), m_name: 'Yoto - Sleep music', m_category: 'Yoto controls', m_enabled: true,
      m_completed: true, m_excludeLog: true, m_isOrCondition: false, m_headingColor: 0, loggingLevel: 0,
      m_description: 'Play the Sleep playlist on the household Yoto. Keeps the player volume and switches from other playback. Requires Tailscale and the Windows recorder service.',
      m_descriptionOpen: false, localVariables: [], localVariableSeparators: [], localVarsAlphabetical: false,
      breakpoints: [], exportedActionBlocks: [], exportedSharedScenes: [], isFavourite: false, isActionBlock: false,
      isExtra: false, aiGenerated: 0, lastEditedTimestamp: Date.now(), disabledTimestamp: 0, forceEvenIfNotEnabledTimestamp: 0,
      m_constraintList: [],
      m_triggerList: [{ ...item('WidgetPressedTrigger', 'trigger'), m_imageId: 0, m_widgetLabel: 'Sleep music',
        m_widgetType: 0, iconText: '☾', iconTintEnabled: false, tintColor: -1 }],
      m_actionList: [{ ...item('HttpRequestAction', 'action'), requestConfig: {
        urlToOpen: new URL('/api/shortcuts/sleep', origin).href, requestType: 1, contentType: 'application/json',
        contentBodySource: 0, contentBodyText: '{}',
        headerParams: [{ paramName: 'Authorization', paramValue: `Bearer ${sleepShortcutToken(automationToken)}` }],
        queryParams: [], allowAnyCertificate: false, followRedirects: false, blockNextAction: true,
        requestTimeOutSeconds: 35, maxTotalDurationSeconds: 35, prettifyJson: false,
        basicAuthEnabled: false, basicAuthUsername: '', basicAuthPassword: '', proxyEnabled: false,
        proxyHost: '', proxyPort: 8080, proxyType: 0, clientCertEnabled: false, clientCertPassword: '',
        clientCertKeyStoreDisplayName: '', clientCertKeyStoreUri: '', allFilesAccessPath: '',
        contentBodyDynamicFileName: '', contentBodyFileDisplayName: '', contentBodyFileUri: '',
        contentBodyFolderDisplayName: '', contentBodyFolderUri: '', localFileUri: '', useLocalFileUri: false,
        useAllFilesAccess: false, useStaticContentBodyFile: true, saveResponseType: 0,
        saveReturnCodeToVariable: false, saveReturnHeadersToVariable: false, saveResponseAllFilesAccessPath: '',
        saveResponseFileName: '', saveResponseFolderPathDisplayName: '', saveResponseFolderPathUri: '',
        saveResponseUseAllFilesAccess: false,
      } }],
    }],
  };
}
