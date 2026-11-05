// Must be imported before anything from ../src so uploads go to a throwaway directory.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.AMS_UPLOADS ??= mkdtempSync(join(tmpdir(), 'ams-test-uploads-'));
