import type { ErrorInfo } from '../api/run';
import { t } from '../i18n';
import { Button, EmptyState } from '../kit';

/** A failed load, said plainly, with a way to try again. */
export function ErrorBox({ error, onRetry }: { error: ErrorInfo; onRetry?(): void }) {
  const title = t(`err.${error.kind}`);
  return (
    <EmptyState
      icon={error.kind === 'admin' ? 'lock' : 'alert'}
      hue="svc"
      title={title}
      text={error.message}
      action={onRetry ? <Button icon="refresh" onClick={onRetry}>{t('common.retry')}</Button> : undefined}
    />
  );
}
