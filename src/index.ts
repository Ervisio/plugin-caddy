/**
 * Entry of the Caddy plugin (SDK v3). The SDK and React are stored first: every component reads them through
 * getSdk() and the `react` shim.
 */
import { createElement } from 'react';
import { setReact } from '@ervisio/plugin-sdk/react';
import { setSdk, type PluginSDK } from './sdk';
import { registerAllStrings, t } from './i18n';
import { injectStyles } from './styles';
import { registerIcons } from './ui/icons';
import { App } from './shell/App';
import { SitesWidget } from './views/Widget';
import { EmptyState } from './kit';

function TooOld() {
  return createElement(EmptyState, { icon: 'alert', hue: 'svc', title: t('shell.oldSdk.title'), text: t('shell.oldSdk.text') });
}

export default function activate(sdk: PluginSDK): void {
  setSdk(sdk);
  setReact(sdk.react);
  registerAllStrings();
  injectStyles();
  registerIcons();
  const ok = sdk.version >= 3;
  sdk.registerPage('caddy', ok ? App : TooOld);
  sdk.registerWidget({ id: 'sites', render: ok ? SitesWidget : TooOld });
}
