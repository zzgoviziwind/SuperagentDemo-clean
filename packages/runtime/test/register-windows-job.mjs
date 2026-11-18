import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';

const localPackage = new URL('../../windows-job/index.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@superagent/windows-job' && existsSync(new URL(localPackage))) return { url: localPackage, shortCircuit: true };
    return next(specifier, context);
  },
});
