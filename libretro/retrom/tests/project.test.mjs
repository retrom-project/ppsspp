import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mountProject, projectMembers} from '../ppsspp-project.mjs';

function archive() {
  const names = ['launcher.pbp', 'assets/data.bin', 'progress.bin'], data = [Buffer.from([0,80,66,80,1]), Buffer.alloc(1024*1024,73), Buffer.from([4,5])];
  const local = [], central = []; let offset = 0;
  names.forEach((name, i) => {
    const path = Buffer.from(name), header = Buffer.alloc(30), entry = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt32LE(data[i].length,18); header.writeUInt32LE(data[i].length,22); header.writeUInt16LE(path.length,26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt32LE(data[i].length,20); entry.writeUInt32LE(data[i].length,24); entry.writeUInt16LE(path.length,28); entry.writeUInt32LE(offset,42);
    local.push(header,path,data[i]); central.push(entry,path); offset += 30+path.length+data[i].length;
  });
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(names.length,8); end.writeUInt16LE(names.length,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  const bytes = Buffer.concat([...local,directory,end]), reads = [];
  return {bytes, reads, source: {sha256:'a'.repeat(64),sizeBytes:bytes.length}, reader:{readInto(position,output){reads.push({position,length:output.length});output.set(bytes.subarray(position,position+output.length));return output.length;},close(){}}};
}
function filesystem() {
  const nodes = new Map();
  return {nodes, analyzePath:path=>({exists:nodes.has(path)}), mkdirTree(){}, ErrnoError:class extends Error{},
    lookupPath:path=>({node:nodes.get(path)}),
    createDataFile(parent,name){
      const node={contents:new Uint8Array(),usedBytes:0,node_ops:{getattr:n=>({size:n.usedBytes}),setattr(n,a){if(a.size!==undefined){n.contents=n.contents.slice(0,a.size);n.usedBytes=a.size;}}},
        stream_ops:{read(s,out,off,len,pos){const n=Math.min(len,s.node.usedBytes-pos);out.set(s.node.contents.subarray(pos,pos+n),off);return n;},
          write(s,bytes,off,len,pos){const next=new Uint8Array(Math.max(s.node.usedBytes,pos+len));next.set(s.node.contents);next.set(bytes.subarray(off,off+len),pos);s.node.contents=next;s.node.usedBytes=next.length;return len;}}};
      nodes.set(parent+'/'+name,node);
    }};
}
test('PBP companions use one bounded Range source and preserve nested paths',()=>{
  const a=archive(), FS=filesystem(), root='/save/PSP/GAME/content/';
  assert.equal(mountProject(FS,a.source,a.reader,'launcher.pbp'),root+'launcher.pbp');
  assert.ok(a.reads.reduce((n,r)=>n+r.length,0)<70000);
  const node=FS.nodes.get(root+'assets/data.bin'), bytes=new Uint8Array(7);
  assert.equal(node.node_ops.getattr(node).size,1024*1024);
  assert.equal(node.stream_ops.read({node},bytes,1,5,998),5);assert.deepEqual([...bytes],[0,73,73,73,73,73,0]);
  assert.equal(node.contents.length,0);assert.ok(a.reads.every(r=>r.length<=262144));
});
test('initial resources become native progress only after a write and restored files take precedence',()=>{
  const a=archive(), FS=filesystem(), path='/save/PSP/GAME/content/progress.bin';
  mountProject(FS,a.source,a.reader,'launcher.pbp');
  const node=FS.nodes.get(path);assert.equal(node.retromImmutable,true);
  node.stream_ops.write({node},new Uint8Array([9]),0,1,1,false);
  assert.equal(node.retromImmutable,false);assert.deepEqual([...node.contents],[4,9]);
  mountProject(FS,a.source,a.reader,'launcher.pbp');assert.deepEqual([...FS.nodes.get(path).contents],[4,9]);
});
test('package mounts reject unsafe names, duplicate entries, compression and invalid boot files',()=>{
  for(const mutate of [a=>{a.bytes.writeUInt16LE(8,a.bytes.length-22-46-'progress.bin'.length+10);},
    a=>{a.bytes[30]=46;},a=>{a.bytes[30+'launcher.pbp'.length]=1;}]){
    const a=archive();mutate(a);assert.throws(()=>mountProject(filesystem(),a.source,a.reader,'launcher.pbp'));
  }
  const a=archive();assert.throws(()=>projectMembers({...a.source,sizeBytes:20},a.reader));
  assert.throws(()=>mountProject(filesystem(),a.source,a.reader,'../launcher.pbp'));
});
