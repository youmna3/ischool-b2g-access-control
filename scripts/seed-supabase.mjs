import { createClient } from '@supabase/supabase-js';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.');
if (!process.argv.includes('--legacy-only')) {
  throw new Error('Legacy documents seeding is no longer the complete import path. Run `npm run seed` to seed and normalize, or pass --legacy-only explicitly for recovery use.');
}

const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const seedRoot = path.resolve('data', 'seed');
const collections = await readdir(seedRoot, { withFileTypes: true });
let total = 0;

for (const collectionDir of collections.filter(entry => entry.isDirectory())) {
  const collection = collectionDir.name;
  const directory = path.join(seedRoot, collection);
  const files = (await readdir(directory)).filter(file => file.endsWith('.json'));
  for (let offset = 0; offset < files.length; offset += 100) {
    const batchFiles = files.slice(offset, offset + 100);
    const rows = await Promise.all(batchFiles.map(async file => {
      const data = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
      const id = String(data.id ?? path.basename(file, '.json'));
      delete data.id;
      return { collection, id, data };
    }));
    const { error } = await client.from('documents').upsert(rows, { onConflict: 'collection,id' });
    if (error) throw new Error(`${collection}: ${error.message}`);
    total += rows.length;
    process.stdout.write(`\rImported ${total} documents`);
  }
}
console.log(`\nLegacy backup seed complete: ${total} documents. Normalized tables remain the application source of truth.`);
