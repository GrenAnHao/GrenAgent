import type {Task} from '../domain/task.js';
export class TaskStore {
 private records=new Map<string,Task>();
 get(id:string){const task=this.records.get(id);return task?{...task}:undefined;}
 save(task:Task,expectedRevision:number){const current=this.records.get(task.id);if((current?.revision??0)!==expectedRevision)throw new Error('Revision conflict');const next={...task,revision:expectedRevision+1};this.records.set(task.id,next);return {...next};}
 list(){return [...this.records.values()].map(task=>({...task}));}
}
