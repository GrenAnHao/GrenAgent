import {runKnowledgeStage} from '../../../electron-agent/electron/knowledgeProcess/stageRuntime';
import {DEFAULT_KNOWLEDGE_BUDGETS} from '../../../electron-agent/shared/knowledgeKernelContracts';
const model:any={id:'test',name:'test',api:'openai-completions',provider:'test',reasoning:false,input:['text'],contextWindow:10000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const request:any={version:1,taskId:'test',fence:{controllerEpoch:'epoch'},phase:'generate',itemId:'x',attempt:2,inputHash:'x',binding:{bindingId:'b',model},budget:DEFAULT_KNOWLEDGE_BUDGETS,input:{root:process.cwd(),manifest:[],systemPrompt:'JSON',userPrompt:'hi'}};
let calls=0;const out=await runKnowledgeStage(request,{reserve:async()=>{},finish:async()=>{},requestModel:async()=>{calls++;throw new Error('BUDGET_EXHAUSTED');}});
console.log(JSON.stringify({fakeLocalRequestCalls:calls,disposition:out.disposition,error:out.error}));
