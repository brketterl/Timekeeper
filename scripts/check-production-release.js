import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root=resolve(process.argv[2]||'.');
const blockedFiles=['public/staging-refresh.js','server/staging-refresh.js','test/staging-refresh.test.js'];
const violations=blockedFiles.filter(file=>existsSync(join(root,file)));
const marker=/staging-refresh|STAGING_DATA_REFRESH_ENABLED|\bstagingRefresh\b|prepareStagingRefresh|prepareStagingImport|loadStagingRefreshPanel/;
for(const directory of ['public','server','e2e']){
 const path=join(root,directory);if(!existsSync(path))continue;
 for(const entry of readdirSync(path,{withFileTypes:true})){
  if(!entry.isFile()||!entry.name.endsWith('.js')&&!entry.name.endsWith('.html'))continue;
  const file=directory+'/'+entry.name;
  if(marker.test(readFileSync(join(root,file),'utf8'))&&!violations.includes(file))violations.push(file);
 }
}
if(violations.length){
 console.error('Production release contains the staging-only data refresh enhancement:\n'+violations.map(file=>' - '+file).join('\n'));
 console.error('Prepare a release branch from main with approved product changes only. Do not merge staging wholesale.');
 process.exitCode=1;
}else console.log('Production release excludes staging-only data refresh tooling.');
