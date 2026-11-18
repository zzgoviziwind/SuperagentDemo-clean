import { FakeCodex } from './fake-codex.ts';
import type { FakeCodexOptions, LocalCodexOptions, RestrictedCodexDriver } from './fake-codex.ts';

export type RestrictedCodexOptions =
  | ({ source: 'offline-codex-fixture' } & FakeCodexOptions)
  | ({ source: 'local-codex-app-server' } & LocalCodexOptions);

export async function openRestrictedCodex(options: RestrictedCodexOptions): Promise<RestrictedCodexDriver> {
  return options.source === 'offline-codex-fixture' ? FakeCodex.start(options) : FakeCodex.startLocal(options);
}
