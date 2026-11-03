import {randomUUID} from 'node:crypto';
import {validateTitle} from './task.js';
import {TaskStore} from '../storage/task-store.js';
import {EventBus} from '../events/event-bus.js';
export class TaskService {
 constructor(readonly store=new TaskStore(),readonly events=new EventBus()){}
 create(title:string){const task=this.store.save({id:randomUUID(),title:validateTitle(title),done:false,revision:0},0);this.events.publish({type:'task.created',taskId:task.id,revision:task.revision});return task;}
 complete(id:string,revision:number){const current=this.store.get(id);if(!current)throw new Error('Task not found');const task=this.store.save({...current,done:true},revision);this.events.publish({type:'task.completed',taskId:id,revision:task.revision});return task;}
}
