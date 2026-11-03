import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskService} from '../src/domain/task-service.js';
test('task lifecycle emits only after successful persistence',()=>{const service=new TaskService(),task=service.create('Ship a wiki');const next=service.complete(task.id,task.revision);assert.equal(next.done,true);assert.equal(next.revision,2);assert.equal(service.events.history.length,2);});
test('stale revision never publishes a success event',()=>{const service=new TaskService(),task=service.create('Review evidence');assert.throws(()=>service.complete(task.id,0),/conflict/);assert.equal(service.events.history.length,1);assert.equal(service.store.get(task.id)?.done,false);});
test('invalid input and missing tasks are rejected',()=>{const service=new TaskService();assert.throws(()=>service.create('  '));assert.throws(()=>service.complete('missing',0));assert.deepEqual(service.store.list(),[]);});
