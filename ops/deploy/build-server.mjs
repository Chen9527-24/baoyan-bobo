import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
rmSync(resolve(root, 'dist/server'), { recursive: true, force: true });
execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', resolve(root, 'ops/deploy/tsconfig.server.json')], { cwd: root, stdio: 'inherit' });
const fixtures = resolve(root, 'dist/server/apps/server/fixtures');
mkdirSync(fixtures, { recursive: true });
cpSync(resolve(root, 'apps/server/fixtures/global-memories.json'), resolve(fixtures, 'global-memories.json'));

cpSync(resolve(root, 'apps/server/fixtures/child-calibration-samples.json'), resolve(fixtures, 'child-calibration-samples.json'));
