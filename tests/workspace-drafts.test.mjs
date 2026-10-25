import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceDrafts, draftStorageKey } from '../web/workspace-drafts.js';

const project = (version, files = [{ path:'client/main.lua', content:'return 1' }]) => ({ id:'project', version, files });

test('generated source changes and deletions retain local draft text and its original base', () => {
  const drafts = new SourceDrafts();
  drafts.edit(project(1), 'client/main.lua', 'return 2');
  const generated = project(2, [{ path:'README.md', content:'Generated resource' }]);
  assert.deepEqual(drafts.paths(generated), ['README.md','client/main.lua']);
  assert.equal(drafts.get('client/main.lua'), 'return 2');
  assert.equal(drafts.conflicts(generated,'client/main.lua'), true);
  assert.deepEqual(drafts.record('client/main.lua'), { content:'return 2', baseContent:'return 1', baseVersion:1 });
  drafts.edit(generated,'client/main.lua','return 3');
  assert.equal(drafts.record('client/main.lua').baseContent,'return 1');
  assert.equal(drafts.conflicts(generated,'client/main.lua'),true);
});

test('metadata and unrelated source revisions do not conflict with unchanged original file content', () => {
  const drafts = new SourceDrafts();
  drafts.edit(project(4),'client/main.lua','return 2');
  assert.equal(drafts.conflicts(project(9),'client/main.lua'),false);
  assert.equal(drafts.record('client/main.lua').baseVersion,4);
  assert.equal(drafts.conflicts(project(10,[{path:'client/main.lua',content:'return 3'}]),'client/main.lua'),true);
});

test('source input during an in-flight save remains dirty against the acknowledged saved text', () => {
  const drafts = new SourceDrafts();
  drafts.edit(project(1),'client/main.lua','return 2');
  drafts.edit(project(1),'client/main.lua','return 3');
  const saved = project(2,[{path:'client/main.lua',content:'return 2'}]);
  drafts.saved(saved,'client/main.lua','return 2');
  assert.equal(drafts.get('client/main.lua'),'return 3');
  assert.equal(drafts.conflicts(saved,'client/main.lua'),false);
  drafts.saved(project(3,[{path:'client/main.lua',content:'return 3'}]),'client/main.lua','return 3');
  assert.equal(drafts.size,0);
});

test('browser recovery restores draft-only files, selected tab and original bases across a completed build', () => {
  const drafts = new SourceDrafts();
  drafts.edit(project(1),'client/main.lua','return 2');
  const raw=drafts.serialize('account-a','project',['client/main.lua'],'client/main.lua');
  const recovered=new SourceDrafts();
  assert.deepEqual(recovered.restore(raw,'account-a','project'),{tabs:['client/main.lua'],selected:'client/main.lua'});
  assert.deepEqual(recovered.record('client/main.lua'),drafts.record('client/main.lua'));
  assert.equal(recovered.conflicts(project(2,[]),'client/main.lua'),true);
  assert.notEqual(draftStorageKey('account-a','project'),draftStorageKey('account-b','project'));
});

test('malformed or cross-account recovery never replaces current in-memory drafts', () => {
  const drafts=new SourceDrafts();
  drafts.edit(project(1),'client/main.lua','return 2');
  const raw=drafts.serialize('account-a','project',[],'client/main.lua');
  for(const invalid of ['{', 'x'.repeat(1048577), raw.replace('account-a','account-b'), raw.replace('client/main.lua','../../secret')]) {
    assert.throws(()=>drafts.restore(invalid,'account-a','project'));
    assert.equal(drafts.get('client/main.lua'),'return 2');
  }
});

test('typing the current saved source deliberately resolves a draft without preserving a false difference', () => {
  const drafts=new SourceDrafts();
  drafts.edit(project(1),'client/main.lua','return 2');
  const saved=project(2,[{path:'client/main.lua',content:'return 3'}]);
  drafts.edit(saved,'client/main.lua','return 3');
  assert.equal(drafts.size,0);
  drafts.edit(project(3,[]),'client/main.lua','');
  assert.equal(drafts.has('client/main.lua'),true);
});


test('unsupported recovery size is rejected before storage without deleting any in-memory source', () => {
  const drafts = new SourceDrafts();
  const files = Array.from({length:16}, (_,index) => ({path:`file-${index}.lua`,content:'a'.repeat(40000)}));
  for(const file of files) drafts.edit(project(1,files),file.path,'b'.repeat(40000));
  assert.throws(()=>drafts.serialize('account-a','project',[],null),/Invalid draft recovery/);
  assert.equal(drafts.size,16);
  assert.equal(drafts.get('file-0.lua'),'b'.repeat(40000));
  const one = new SourceDrafts();
  one.edit(project(1),'client/main.lua','a'.repeat(131073));
  assert.throws(()=>one.serialize('account-a','project',[],'client/main.lua'),/Invalid draft recovery source/);
  assert.equal(one.get('client/main.lua').length,131073);
});
