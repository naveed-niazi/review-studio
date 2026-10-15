import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Preserve notices for dependencies included in the frontend bundle, including fonts.
export function bundleLicenses() {
  return {
    name: 'bundle-third-party-notices',
    generateBundle() {
      const packages = new Map();
      for (const moduleId of this.getModuleIds()) {
        if (!moduleId.includes('/node_modules/') || moduleId.startsWith('\0')) continue;
        let directory = path.dirname(moduleId.split('?')[0]);
        while (
          directory !== path.dirname(directory) &&
          !existsSync(path.join(directory, 'package.json'))
        )
          directory = path.dirname(directory);
        if (!existsSync(path.join(directory, 'package.json'))) continue;
        const info = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
        if (!info.name || packages.has(info.name)) continue;
        const notices = readdirSync(directory).filter((name) =>
          /^(?:licen[sc]e|copying|notice)(?:\.[\w-]+)?$/i.test(name),
        );
        if (!notices.length) throw new Error(`Missing bundled dependency license: ${info.name}`);
        packages.set(
          info.name,
          `${info.name} ${info.version}\n${notices.map((name) => readFileSync(path.join(directory, name), 'utf8')).join('\n\n')}`,
        );
      }
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_LICENSES.txt',
        source: [...packages.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, notice]) => notice)
          .join('\n\n----------------------------------------\n\n'),
      });
    },
  };
}
