import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('src');
const extensions = new Set(['.js', '.jsx', '.mjs']);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return extensions.has(path.extname(entry.name)) ? [full] : [];
  });
}

for (const file of walk(root)) {
  const relative = path.relative(process.cwd(), file);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/[\u0400-\u04ff]/u.test(line)) {
      console.log(`${relative}:${index + 1}:${line}`);
    }
  });
}
