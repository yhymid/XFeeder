"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {gunzipSync}=require('node:zlib');
test('release archive includes tracked source/examples and refuses forced tracked secrets',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xfeeder-artifact-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',args,{cwd:dir,stdio:['pipe','pipe','pipe']}).toString().trim();
 git('init','--quiet');
 fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'xfeeder',version:'2.2.0'}));
 fs.writeFileSync(path.join(dir,'.gitignore'),'.env\nnode_modules/\n');
 fs.writeFileSync(path.join(dir,'.env.example'),'TOKEN=example\n');
 fs.writeFileSync(path.join(dir,'main.js'),'// release source\n');
 fs.mkdirSync(path.join(dir,'node_modules'));fs.writeFileSync(path.join(dir,'node_modules/unused'),'local dependency');
 git('add','.');
 const script=path.join(__dirname,'../scripts/package-release.cjs'), output=path.join(dir,'release.tgz');
 const run=tree=>execFileSync(process.execPath,[script,tree,output],{cwd:dir,stdio:['pipe','pipe','pipe']}).toString();
 const result=JSON.parse(run(git('write-tree')));
 assert.equal(result.files,4);assert.ok(result.sourceBytes>0);assert.ok(result.archiveBytes<4096);
 const archive=gunzipSync(fs.readFileSync(output)).toString();
 assert.match(archive,/XFeeder-2.2.0\/main.js/);assert.match(archive,/\.env.example/);assert.ok(!archive.includes('local dependency'));
 for (const name of ['.env','.npmrc','.netrc','.git-credentials','.pypirc','.envrc','credentials.json','auth.json','secrets.json','private.pem','private.key','state.sqlite3','state.db-wal']) {
  fs.writeFileSync(path.join(dir,name),'PRIVATE_TEST_MARKER=fixture\n');git('add','-f',name);
  assert.throws(()=>run(git('write-tree')),error=>error.stderr.toString().includes(`Generated/private files tracked in release: ${name}`));
  git('rm','--cached','--',name);fs.unlinkSync(path.join(dir,name));
 }
});

test('repository ignore rules protect local credentials and state without hiding source fixtures',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xfeeder-ignore-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 execFileSync('git',['init','--quiet'],{cwd:dir});
 fs.copyFileSync(path.join(__dirname,'../.gitignore'),path.join(dir,'.gitignore'));
 const ignored=name=>{
  try {execFileSync('git',['check-ignore','--no-index','-q',name],{cwd:dir});return true;}
  catch(error){if(error.status===1)return false;throw error;}
 };
 for(const name of ['.env','.env.local','config.json','cache.json','.npmrc','.netrc','.git-credentials','.pypirc','.envrc','.direnv/state','.aws/credentials','.ssh/id_ed25519','credentials.json','secrets.json','auth.json','local.sqlite','local.sqlite3-wal','local.db-journal','cookies.json','storage-state.json','browser-profiles/Default/Cookies','node_modules/module/index.js','src/extensions/Scrapling/.venv/bin/python','debug/terminal.txt','data.network-runtime.json','data.network-runtime.json.123.tmp','production.pem','production.key','tests/fixtures/tls/other-private.pem']) assert.equal(ignored(name),true,name);
 for(const name of ['.env.example','config.json.example','package-lock.json','debug/.gitkeep','src/extensions/Scrapling/browser_worker.py','tests/fixtures/tls/README.md','tests/fixtures/tls/localhost-test-cert.pem','tests/fixtures/tls/localhost-test-key.pem']) assert.equal(ignored(name),false,name);
});
