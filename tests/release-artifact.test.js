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
 fs.writeFileSync(path.join(dir,'.gitignore'),'.env\nnode_modules/\n.venv/\n/src/extensions/Scrapling/upstream/\n');
 fs.writeFileSync(path.join(dir,'.env.example'),'TOKEN=example\n');
 fs.writeFileSync(path.join(dir,'main.js'),'// release source\n');
 fs.mkdirSync(path.join(dir,'node_modules'));fs.writeFileSync(path.join(dir,'node_modules/unused'),'local dependency');
 for(const name of ['src/extensions/Scrapling/.venv/bin/python','src/extensions/Scrapling/upstream/source.py']) {
  fs.mkdirSync(path.dirname(path.join(dir,name)),{recursive:true});fs.writeFileSync(path.join(dir,name),'LOCAL_SCRAPLING_ARTIFACT');
 }
 git('add','.');
 const script=path.join(__dirname,'../scripts/package-release.cjs'), output=path.join(dir,'release.tgz');
 const run=tree=>execFileSync(process.execPath,[script,tree,output,'--source'],{cwd:dir,stdio:['pipe','pipe','pipe']}).toString();
 const result=JSON.parse(run(git('write-tree')));
 assert.equal(result.files,4);assert.ok(result.sourceBytes>0);assert.ok(result.archiveBytes<4096);
 const archive=gunzipSync(fs.readFileSync(output)).toString();
 assert.match(archive,/XFeeder-2.2.0\/main.js/);assert.match(archive,/\.env.example/);assert.ok(!archive.includes('local dependency'));assert.ok(!archive.includes('LOCAL_SCRAPLING_ARTIFACT'));
 for (const name of ['.env','.npmrc','.netrc','.git-credentials','.pypirc','.envrc','credentials.json','auth.json','secrets.json','private.pem','private.key','state.sqlite3','state.db-wal','src/extensions/Scrapling/.venv/bin/python','src/extensions/Scrapling/upstream/source.py']) {
  fs.mkdirSync(path.dirname(path.join(dir,name)),{recursive:true});
  fs.writeFileSync(path.join(dir,name),'PRIVATE_TEST_MARKER=fixture\n');git('add','-f',name);
  assert.throws(()=>run(git('write-tree')),error=>error.stderr.toString().includes(`Generated/private files tracked in release: ${name}`));
  git('rm','--cached','--',name);fs.unlinkSync(path.join(dir,name));
 }
});

test('runtime archive ships only runnable files and a generated empty config',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xfeeder-runtime-artifact-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',args,{cwd:dir,stdio:['pipe','pipe','pipe']}).toString().trim();
 git('init','--quiet');
 const write=(name,content)=>{fs.mkdirSync(path.dirname(path.join(dir,name)),{recursive:true});fs.writeFileSync(path.join(dir,name),content);};
 write('package.json',JSON.stringify({name:'xfeeder',version:'2.2.0',main:'main.js',scripts:{start:'node main.js',test:'node --test tests/*.test.js','release:archive':'node scripts/package-release.cjs','scrapling:install':'node scripts/install-scrapling.cjs'}}));
 for(const name of ['main.js','dashboard.js','package-lock.json','LICENSE','.env.example','config.json.example','scripts/install-scrapling.cjs','src/app/bootstrap.js','src/dashboard/public/index.html','src/extensions/Scrapling/browser_worker.py','src/extensions/Scrapling/requirements.lock.txt']) write(name,'RUNTIME '+name);
 for(const name of ['README.md','CHANGELOG.md','RELEASE_NOTES_2.2.0.md','tests/test.js','tests/fixtures/tls/localhost-test-key.pem','docs/guide.md','src/extensions/Scrapling/readme.md','scripts/benchmark-network.cjs']) write(name,'DEVELOPMENT_ONLY');
 write('.gitignore','config.json\n.env\nnode_modules/\n.venv/\n');
 write('config.json','PRIVATE_LOCAL_CONFIG');write('.env','PRIVATE_LOCAL_SECRET');
 write('node_modules/local.js','LOCAL_DEPENDENCY');write('src/extensions/Scrapling/.venv/local','LOCAL_PYTHON');
 git('add','.');
 const output=path.join(dir,'release.tgz'),script=path.join(__dirname,'../scripts/package-release.cjs');
 const result=JSON.parse(execFileSync(process.execPath,[script,git('write-tree'),output],{cwd:dir}));
 const tar=gunzipSync(fs.readFileSync(output)),members=new Map();
 for(let offset=0;offset<tar.length && tar[offset];){
  const name=tar.toString('utf8',offset,offset+100).replace(/\0.*$/s,'');
  const size=parseInt(tar.toString('ascii',offset+124,offset+136).replace(/\0/g,'').trim(),8)||0;
  if(tar[offset+156]===48) members.set(name.replace('XFeeder-2.2.0/',''),tar.subarray(offset+512,offset+512+size).toString());
  offset+=512+Math.ceil(size/512)*512;
 }
 assert.equal(result.kind,'runtime');assert.equal(result.files,members.size);
 for(const name of ['LICENSE','main.js','dashboard.js','package-lock.json','.env.example','config.json.example','scripts/install-scrapling.cjs','src/extensions/Scrapling/browser_worker.py','src/extensions/Scrapling/requirements.lock.txt','src/dashboard/public/index.html']) assert.ok(members.has(name),name);
 assert.deepEqual(JSON.parse(members.get('config.json')),{Settings:{Logs:false,DebugExpert:false},channels:{}});
 const pkg=JSON.parse(members.get('package.json'));
 assert.equal(pkg.main,'main.js');assert.equal(pkg.scripts.start,'node main.js');assert.ok(pkg.scripts['scrapling:install']);assert.equal(pkg.scripts.test,undefined);assert.equal(pkg.scripts['release:archive'],undefined);
 assert.doesNotMatch(tar.toString(),/DEVELOPMENT_ONLY|PRIVATE_LOCAL_|LOCAL_DEPENDENCY|LOCAL_PYTHON/);
 assert.ok(!members.has('.gitignore'));
 write('config.json','FORCED_PRIVATE_CONFIG');git('add','-f','config.json');
 assert.throws(()=>execFileSync(process.execPath,[script,git('write-tree'),output],{cwd:dir,stdio:'pipe'}),/Generated\/private files tracked/);
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
