// Run the proposed Checkly script in Chrome without changing the live check.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const dir=path.resolve('checkly-browser-test'),source=fs.readFileSync(path.resolve('scripts/monitoring/checkly-browser.spec.cjs'),'utf8');
fs.mkdirSync(dir,{recursive:true});
for(const [width,height] of [[1365,900],[390,844]]){
 const code=source.replace('{ width: 1365, height: 900 }','{ width: '+width+', height: '+height+' }');
 fs.writeFileSync(path.join(dir,'browser-'+width+'.spec.cjs'),code);
}
fs.writeFileSync(path.join(dir,'playwright.config.cjs'),"module.exports={testDir:__dirname,testMatch:'*.spec.cjs',workers:1,repeatEach:2,retries:0,reporter:[['line'],['json',{outputFile:'results.json'}]],outputDir:'test-results',use:{browserName:'chromium',channel:'chrome',trace:'on',screenshot:'on'}};\n");
const cli=require.resolve('@playwright/test/cli');
const run=spawnSync(process.execPath,[cli,'test','--config',path.join(dir,'playwright.config.cjs')],{cwd:dir,stdio:'inherit',env:process.env});
process.exitCode=run.status??1;

