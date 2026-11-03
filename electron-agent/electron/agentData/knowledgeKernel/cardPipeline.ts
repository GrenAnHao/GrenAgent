import { type GraphInput, type StageGraph } from './pipeline';
import { createHash } from 'node:crypto';
export function buildCardStageGraph(input: GraphInput): StageGraph {
 const hash=(id:string)=>createHash('sha256').update(JSON.stringify([input.inputHash,input.authorConstraints,id,undefined])).digest('hex');
 return {domain:'cards',...input,nodes:[{id:'prepare',phase:'prepare',kind:'prepare',deps:[],inputHash:hash('prepare')},{id:'plan',phase:'plan',kind:'plan',deps:['prepare'],inputHash:hash('plan')}],completed:[],total:null,definitions:[],expanded:[],leaves:[],outputHashes:{}};
}

