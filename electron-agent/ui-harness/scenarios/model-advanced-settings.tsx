import { useState } from 'react';
import { App } from 'antd';
import { ProvidersSettings } from '../../src/features/settings/ProvidersSettings';
import { exposeActions,exposeData,installBridge,track } from '../stubs';
let saved=JSON.stringify({futureDocument:{keep:true},providers:{
 googlefixture:{name:'Google fixture',api:'google-generative-ai',models:[{id:'gemini-fixture',inputLimits:{maxRequestBytes:100,images:{maxPerRequest:2}}}]},
 unsupported:{name:'Unsupported fixture',api:'custom-api',models:[{id:'unknown',inputLimits:{images:{maxPerRequest:2}}}]},
 openai:{futureProvider:'keep',modelOverrides:{'gpt-5':{compat:{supportsFastMode:true},future:{keep:1}}},models:[{id:'replacement',api:'openai-completions',future:'replacement',samplingParams:{top_p:0.2}}]},
 relay:{name:'Relay',api:'anthropic-messages',baseUrl:'https://fixture.invalid/v1',futureProvider:{keep:1},models:[{id:'org/A',api:'openai-completions',reasoning:true,thinkingLevelMap:{low:'low',high:'high'},compat:{supportsFastMode:true},cost:{input:1,output:2,cacheRead:0.1,cacheWrite:1,tiers:[{inputTokensAbove:100000,input:2,output:3,cacheRead:1,cacheWrite:2}]},samplingParams:{top_p:0},inputLimits:{images:{resize:{future:9}}},futureModel:'keep'}]}
}});
let failSave=false,partial=false,remount=()=>{};
const catalog=[{provider:'openai',id:'gpt-5',name:'GPT 5',api:'openai-responses',promptCache:{short:300,long:3600},inputLimits:{images:{maxPerRequest:4}},contextWindow:200000},{provider:'openai',id:'replacement',api:'openai-completions'}];
installBridge({subscribe:async()=>()=>{},invoke:async(command:string,args:Record<string,unknown>)=>{
 switch(command){case'get_provider_config':return{modelsJson:saved,authJson:'{}',agentDir:'/fixture-agent'};case'get_settings':return{};case'list_models_global':return{ok:true,models:catalog};case'list_builtin_models':return catalog.filter(model=>model.provider===args.provider);case'get_provider_credentials':return[];case'get_provider_oauth_capabilities':return[];
 case'set_provider_config':if(failSave)throw new Error('夹具：磁盘不可写');saved=String(args.modelsJson);exposeData({savedModelsJson:saved});track('save');return{refreshed:['good'],failed:partial?[{workspace:'bad',error:'夹具：刷新失败'}]:[]};
 case'refresh_model_registry':track('refresh-only');return{refreshed:['good','bad'],failed:[]};default:throw new Error(`Unexpected command ${command}`);
 }
}});
exposeActions({remount:()=>remount(),failSave:(value:boolean)=>{failSave=value;},partial:(value:boolean)=>{partial=value;}});
export default function Scenario(){const [epoch,setEpoch]=useState(0);remount=()=>setEpoch(n=>n+1);return <App><main data-testid="advanced-root" data-epoch={epoch} style={{height:'100vh',padding:20,boxSizing:'border-box',display:'flex',flexDirection:'column',background:'var(--gren-content-bg)'}}><ProvidersSettings key={epoch}/></main></App>;}
