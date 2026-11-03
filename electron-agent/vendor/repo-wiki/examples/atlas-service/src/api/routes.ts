import {TaskService} from '../domain/task-service.js';
/** Pure request adapter. No network or database is started on import. */
export function createRoutes(service=new TaskService()){
 return {
  list:()=>service.store.list(),
  create:(body:{title:string})=>service.create(body.title),
  complete:(id:string,body:{revision:number})=>service.complete(id,body.revision),
 };
}
