export type TaskEvent={type:'task.created'|'task.completed';taskId:string;revision:number};
export class EventBus {
 readonly history:TaskEvent[]=[];
 publish(event:TaskEvent){this.history.push({...event});}
}
