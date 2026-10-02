import { getSdk } from '../sdk';

/** Icons the app kit does not have. Use them by name (`<Icon name="route" />`) once activate() has run. */
export function registerIcons(): void {
  const reg = getSdk().ui.registerIcon as ((name: string, svg: string) => void) | undefined;
  if (!reg) return;
  reg('route', '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H15a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h6.5"/>');
  reg('folder', '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>');
  reg('redirect', '<path d="M4 18V12a5 5 0 0 1 5-5h11M16 3l4 4-4 4"/>');
  reg('php', '<ellipse cx="12" cy="12" rx="9.5" ry="6"/><path d="M7 14.5l1-5h1.6a1.3 1.3 0 0 1 0 2.6H7.6M11.5 13l.9-4.5M12 11h2.3l-.7 3M15.8 14.5l1-5h1.6a1.3 1.3 0 0 1 0 2.6h-2"/>');
  reg('cert', '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M7 8h10M7 11.5h5"/><circle cx="16" cy="17" r="2.5"/><path d="M14.5 19l-.5 2.5 2-1 2 1-.5-2.5"/>');
  reg('history', '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5M3.5 4v4.5H8"/><path d="M12 8v4l3 2"/>');
  reg('box', '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>');
  reg('pulse', '<path d="M3 12h4l3-8 4 16 3-8h4"/>');
  reg('blocks', '<path d="M8 6h12M8 12h12M8 18h8M4 6h.01M4 12h.01M4 18h.01"/>');
  reg('wand', '<path d="M4 20L15 9M14 4v2M19 9h2M17.5 5.5l1.5-1.5M10 6.5L11.5 5M17.5 12.5L19 14"/>');
}

export const KIND_ICON = { proxy: 'route', static: 'folder', php: 'php', redirect: 'redirect', custom: 'code' } as const;
export const KIND_HUE = { proxy: 'term', static: 'file', php: 'sw', redirect: 'log', custom: 'ov' } as const;
