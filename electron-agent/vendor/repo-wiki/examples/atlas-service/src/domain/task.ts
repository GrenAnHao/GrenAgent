export interface Task { id:string; title:string; done:boolean; revision:number }
export function validateTitle(title:string){if(!title.trim()||title.length>160)throw new Error('Title must contain 1–160 characters');return title.trim();}
