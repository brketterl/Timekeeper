import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

// Render runs npm test before deploying production. Keep this independent of GitHub merge settings.
const productionTarget=[process.env.APP_ORIGIN,process.env.RENDER_EXTERNAL_URL].some(value=>{
 try{return new URL(value).hostname==='timekeeper-sbzu.onrender.com'}catch{return false}
});
test('production deployment excludes staging-only refresh tooling',{skip:!productionTarget},()=>{
 const result=spawnSync(process.execPath,['scripts/check-production-release.js'],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr||result.stdout);
});
