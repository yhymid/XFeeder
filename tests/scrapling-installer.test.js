"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { venvPaths } = require("../src/extensions/Scrapling/runtime-paths");
const { ScraplingDetector } = require("../src/extensions/Scrapling/detector");
const { prepare } = require("../scripts/install-scrapling.cjs");
const baseDir = "/a path/with spaces/Scrapling";
const info = (prefix, scrapling = "0.4.15", version = [3,14,7]) => ({
  prefix, basePrefix: "/system", version, scripts: [path.join(prefix, "bin")], scrapling,
});
function mockInstall({ existing = false, fail, py3 = info("/system"), py = null } = {}) {
  const local = venvPaths(baseDir), calls = [];
  let created = existing;
  const exists = file => created && [local.directory, local.python, local.scrapling].includes(file);
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (fail?.(command, args)) return { status: 1 };
    if (args[0] === "-c" && args[1].includes("sysconfig")) {
      const result = command === local.python && created ? info(local.directory) : command === "python3" ? py3 : command === "python" ? py : null;
      return result ? { status: 0, stdout: JSON.stringify(result) } : { status: 1 };
    }
    if (args[0] === "-m" && args[1] === "venv") created = true;
    return { status: 0 };
  };
  return { baseDir, run, exists, calls, local, log: () => {} };
}

test("virtualenv paths support Linux/macOS, Windows and spaces", () => {
  assert.equal(venvPaths(baseDir,"linux").python,baseDir+"/.venv/bin/python");
  assert.equal(venvPaths(baseDir,"darwin").scrapling,baseDir+"/.venv/bin/scrapling");
  const win=venvPaths("C:\\XFeeder Files\\Scrapling","win32");
  assert.equal(win.python,"C:\\XFeeder Files\\Scrapling\\.venv\\Scripts\\python.exe");
  assert.equal(win.scrapling,"C:\\XFeeder Files\\Scrapling\\.venv\\Scripts\\scrapling.exe");
});
test("installer creates venv then exclusively uses its executables and pinned lock", () => {
  const fixture=mockInstall();prepare(fixture);
  const steps=fixture.calls.filter(c=>c.args[0]!=="-c");
  assert.deepEqual(steps[0].args,["-m","venv",fixture.local.directory]);
  assert.equal(steps[0].command,"python3");
  assert.ok(steps.slice(1).every(c=>[fixture.local.python,fixture.local.scrapling].includes(c.command)));
  assert.ok(steps.some(c=>c.args.includes("--no-deps") && c.args.at(-1).endsWith("requirements.lock.txt")));
  for(const engine of ["playwright","patchright"])assert.ok(steps.some(c=>JSON.stringify(c.args)===JSON.stringify(["-m",engine,"install","chromium"])));
  assert.ok(fixture.calls.every(c=>c.options.shell===false));
});
test("installer falls back from incompatible python3 to compatible python",()=>{
  const f=mockInstall({py3:info("/system",null,[3,10,0]),py:info("/system")});prepare(f);
  assert.equal(f.calls.find(c=>c.args[1]==="venv").command,"python");
});
test("healthy reruns reuse venv; check mode never installs or creates anything",()=>{
  for(const check of [false,true]){
    const f=mockInstall({existing:true});prepare({...f,check});
    assert.ok(!f.calls.some(c=>c.args[1]==="venv"));
    assert.ok(f.calls.every(c=>[f.local.python,f.local.scrapling].includes(c.command)));
    if(check)assert.ok(!f.calls.some(c=>c.args.includes("install")));
  }
});
test("broken existing venv is preserved with explicit remediation",()=>{
  const f=mockInstall({existing:true,fail:(cmd,args)=>args[1]?.includes("sysconfig")});
  assert.throws(()=>prepare(f),/rename .* to a backup.*No environment was deleted/);
  assert.equal(f.calls.length,1);
});
test("missing Python, old Python and missing venv get actionable failures",()=>{
  assert.throws(()=>prepare(mockInstall({py3:null})),/Python not found/);
  for(const version of [[2,7,18],[3,7,17],[3,10,0]])assert.throws(()=>prepare(mockInstall({py3:info("/system",null,version)})),/Python is incompatible/);
  assert.throws(()=>prepare({...mockInstall(),check:true}),/Virtualenv: MISSING/);
});
for(const [label,predicate,message] of [
  ["venv",(_c,a)=>a[1]==="venv",/venv\/ensurepip/],
  ["pip",(_c,a)=>a[1]==="pip" && a[2]==="install",/Install pinned requirements failed/],
  ["browser install",(_c,a)=>a[1]==="playwright",/Install playwright Chromium failed/],
  ["import",(_c,a)=>a[1]?.includes('from scrapling import Selector'),/Verify Scrapling import and parser failed/],
  ["browser launch",(_c,a)=>a[1]?.includes('chromium.launch'),/Verify browser launch .* failed/],
])test(`installer stops on ${label} failure`,()=>{
  const f=mockInstall({fail:predicate});assert.throws(()=>prepare(f),message);
  assert.ok(predicate(f.calls.at(-1).command,f.calls.at(-1).args));
});
test("detector prefers local venv over globals and never executes shell strings",()=>{
  const local=venvPaths(baseDir),calls=[];
  const d=new ScraplingDetector(baseDir,{exists:p=>[local.python,local.scrapling].includes(p),run:(cmd,args,opts)=>{
    calls.push({cmd,args,opts});return args[1]?.includes("sysconfig") ? {status:0,stdout:JSON.stringify(info(local.directory))}:{status:0};
  }});
  assert.equal(d.pythonCmd,local.python);assert.equal(d.scraplingCmd,local.scrapling);assert.equal(d.hasSessions,true);assert.equal(d.available,true);
  assert.ok(calls.every(c=>[local.python,local.scrapling].includes(c.cmd) && c.opts.shell===false));
});
test("detector can use a paired global installation without local venv",()=>{
  const d=new ScraplingDetector(baseDir,{exists:p=>p==="/global/bin/scrapling",run:(cmd,args)=>args[1]?.includes("sysconfig")?{status:0,stdout:JSON.stringify(info("/global"))}:{status:0}});
  assert.equal(d.pythonCmd,"python3");assert.equal(d.scraplingCmd,"/global/bin/scrapling");assert.equal(d.available,true);
});
test("detector handles missing Scrapling/Python gracefully, without upstream",()=>{
  for(const result of [{status:1},{status:0,stdout:JSON.stringify(info('/system',null))}]){
    const calls=[];
    const d=new ScraplingDetector(baseDir,{exists:()=>false,run:(cmd,args)=>{calls.push([cmd,args]);return result;}});
    assert.equal(d.available,false);assert.equal(d.hasSessions,false);
    assert.ok(!JSON.stringify(calls).includes('upstream'));
  }
  for(const name of ['detector.js','runtime-paths.js','index.js','shell.js','cli.js','browser-worker.js','browser_worker.py']){
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../src/extensions/Scrapling',name),'utf8'),/upstream[\\/]/);
  }
});
test("Windows detector resolves the managed Scripts CLI",()=>{
  const dir="C:\\XFeeder Files\\Scrapling",local=venvPaths(dir,"win32");
  const d=new ScraplingDetector(dir,{platform:"win32",exists:p=>[local.python,local.scrapling].includes(p),run:(_cmd,args)=>args[1]?.includes('sysconfig')?{status:0,stdout:JSON.stringify({...info(local.directory),scripts:[path.win32.dirname(local.python)]})}:{status:0}});
  assert.equal(d.available,true);assert.equal(d.scraplingCmd,local.scrapling);
});
