import { UsagePanel } from '../../src/features/usage/UsagePanel';
import type { UsageFilters, UsageReport } from '../../src/lib/usageReport';
import { exposeActions, exposeData, installBridge, track } from '../stubs';

// These are report-shaped snapshots, not a second implementation of the SQLite aggregator.
// The rankings deliberately differ: the most expensive model/project is not the busiest one.
const projects = [
  {projectId: '/work/GrenAgent', name: 'GrenAgent'},
  {projectId: '/work/observatory', name: 'Skyline Observatory'},
  {projectId: 'global', name: '未归属会话 (全局对话)'},
  {projectId: '/work/Northwind', name: 'Northwind'},
  {projectId: '/work/notes', name: '研究笔记'},
  {projectId: '/work/archive', name: 'Archived console'},
  ...['零售看板','数据核对','组件库','资料整理','s118','仅预热'].map((name,i)=>({ projectId:'extra:'+i, name })),
];
const models = ['gpt-6.1-sol','gpt-6.2-astra','Claude Sonnet','Gemini Pro','deepseek-v4.1-flash','Qwen','Claude Opus','Llama'];
const parts = (total: number, weights: number[]) => {
  const sum = weights.reduce((a,b) => a+b, 0);
  const values = weights.map(w => Math.floor(total*w/sum));
  values[weights.findLastIndex(w => w > 0)] += total-values.reduce((a,b) => a+b,0);
  return values;
};
const series = [26,39,20,41,31,62,44,81,46,59,38,75,51,60,77,54,84,69,48,88,62,73,52,80,77,98,63,76,89,81];
const date = (n: number) => new Date(Date.UTC(2026,9,27+n)).toISOString().slice(0,10);
const dirtyTitle = '{"isNewTopic":true,"title":"登录状态颜色"}';
const sessionFixture = {id:'local-1', name: dirtyTitle, cwd: '/work/GrenAgent', path: '/fixture/session-1.jsonl', timestamp:'2026-11-25T01:02:00.000Z'};
function recentFixtures(cwd: string | null) {
  return Array.from({ length: 23 }, (_, i) => ({
    ...sessionFixture, cwd, id:'recent-' + i, path:'/fixture/recent-' + i + '.jsonl',
    name:i===0 ? dirtyTitle : i===1 ? '未发送的空对话' : i===22 ? '查找昂贵会话' : '排查日志 ' + i,
    timestamp:new Date(Date.parse(sessionFixture.timestamp) - i * 3_600_000).toISOString(),
    tokens:i===1 ? 0 : i===0 ? 180_000 : i * 10, cost:i===1 ? 0 : i===2 ? 0.0123 : i===22 ? 9.25 : .12,
  }));
}
const windows = [
  {from:-12, weights:series.slice(0,12),tokens:10_992_500_000,messages:25_875,sessions:653,cents:76_200,warm:0},
  {from:0,weights:series.slice(0,23),tokens:11_800_000_000,messages:61_220,sessions:587,cents:63_000,warm:0},
  {from:23,weights:series.slice(-7),tokens:4_200_000_000,messages:24_900,sessions:223,cents:48_997,warm:3},
];
function snapshot({range='all',projectId}: UsageFilters): UsageReport {
  const visible = windows.slice(range==='7d' ? 2 : range==='30d' ? 1 : 0);
  const selected = projects.find(p=>p.projectId===projectId);
  const byProject=(selected ? [selected] : projects).map(p=>({...p,cwd:p.projectId==='global' ? '' : p.projectId,tokens:0,sessions:0,cost:0,recordedCost:0}));
  const byDay: UsageReport['byDay'] = [];
  let messages=0,assistantCents=0,warmingCents=0;
  for (const window of visible) {
    // Older archived work has no calls during the final week.
    const share=window.warm ? [45,26,15,8,2,0,1,1,1,1,0,0] : [43,26,15,8,2,2,1,1,1,1,0,0];
    const spend=window.warm ? [16,49,21,10,0,0,1,1,1,1,0,0] : [15,49,21,10,0,1,1,1,1,1,0,0];
    let dayTokens=0,dayMessages=0,dayCents=0,dayWarm=0;
    for (const row of byProject) {
      const i=projects.findIndex(p=>p.projectId===row.projectId);
      const tokens=parts(window.tokens,share)[i], calls=parts(window.messages,share)[i], cents=parts(window.cents,spend)[i];
      const warm=window.warm && i===0 ? window.warm-1 : window.warm && i===11 ? 1 : 0;
      row.tokens+=tokens;row.sessions+=parts(window.sessions,share)[i];row.cost+=cents/100;row.recordedCost+=(cents+warm)/100;
      dayTokens+=tokens;dayMessages+=calls;dayCents+=cents;dayWarm+=warm;
    }
    if(dayTokens || range!=='all') byDay.push(...parts(dayTokens,window.weights).map((tokens,i)=>{
      const cents=parts(dayCents,window.weights)[i];
      return {date:date(window.from+i),tokens,cost:cents/100,recordedCost:(cents+(i===window.weights.length-1 ? dayWarm : 0))/100,
        messages:parts(dayMessages,window.weights)[i],cacheHitRate:dayTokens ? .9 : 0};
    }));
    messages+=dayMessages;assistantCents+=dayCents;warmingCents+=dayWarm;
  }
  const total=byProject.reduce((n,r)=>n+r.tokens,0), sessions=byProject.reduce((n,r)=>n+r.sessions,0);
  const warm=warmingCents/100, dollars=(assistantCents+warmingCents)/100, empty=!messages;
  const byModel = parts(total,[37,25,15,8,6,4,3,2]).map((tokens, i) => {
    const cost = parts(assistantCents,[8,39,7,5,3,1,33,4])[i]/100;
    return {model:models[i], provider:'', tokens, cost, recordedCost:cost+(i===3 ? warm : 0), messages:parts(messages,[37,25,15,8,6,4,3,2])[i]};
  });
  // A mixed-version report can still split one requested model by channel and whitespace.
  // Keep sum(tokens), sum(cost) and sum(messages) unchanged.
  const first = byModel[0];
  const alternate = { ...first, model: ' GPT-6.1-SOL ', provider: 'proxy', tokens: Math.floor(first.tokens / 4),
    messages: Math.floor(first.messages / 4), cost: first.cost / 4, recordedCost: first.recordedCost / 4 };
  byModel[0] = {...first, provider:'direct', tokens:first.tokens-alternate.tokens,
    messages:first.messages-alternate.messages, cost:first.cost-alternate.cost, recordedCost:first.recordedCost-alternate.recordedCost};
  byModel.push(alternate);
  const [input,output,cacheRead,cacheWrite]=parts(total,[8,18,72,2]);
  const baseCall={timestamp:sessionFixture.timestamp, provider:'Fixture', input:100, output:50,cacheRead:50,cacheWrite:0,totalTokens:200};
  return {
    projects, totals: {input,output,cacheRead,cacheWrite,totalTokens:total,cost:dollars-warm,sessions,messages,cacheHitRate:empty ? 0 : .9},
    byModel:empty ? [] : byModel, byProject, byDay,
    recentSessions:empty ? [] : recentFixtures(byProject[0].cwd||null),
    calls:empty ? [] : [
      {...baseCall, model:'gpt-6.1-sol', responseModel:'sol-service-rev3', cost:0.12,costSource:'provider'},
      {...baseCall, model:'zero-alias', cost:0, costSource:'catalog'},
      {...baseCall, model:'old-alias', responseModel:'old-alias', cost:0.1, costSource:'unknown'},
      ...Array.from({length:22},(_,i)=>({...baseCall, provider:'Relay', model:'deepseek-flash', responseModel:i ? null : 'deepseek-flash', cost:0.03,costSource:'catalog' as const})),
    ],
    warmingTotals: {cost:warm, messages:warm?1:0, totalTokens:warm?2:0}, warmingCalls:[],
    recordedCost:{assistantCost:dollars-warm,warmingCost:warm,totalCost:dollars,
      sourceBreakdown: {provider:empty ? 0 : dollars-3.1,catalog:empty ? 0 : 3,unknown:empty ? 0 : .1}},
  };
}
let fail = false;
installBridge({
  subscribe: async () => () => {},
  invoke: async (command: string, args?: {filters?:UsageFilters}) => {
    switch (command) {
      case 'usage_report': {
        const f=args?.filters ?? {};
        track(`report:${f.range ?? 'all'}:${f.projectId ?? '*'}`);
        if (fail) throw Error('fixture report failure');
        return snapshot(f);
      }
      case 'usage_reconcile': track('reconcile'); return {files:1,added:0};
      case 'get_provider_config': return {modelsJson:'{}',authJson:'{}',agentDir:'/fixture'};
      case 'get_settings': return {};
      case 'list_models_global': return {ok:true,models:[]};
      default: throw Error(`unexpected ${command}`);
    }
  },
});
exposeActions({fail:()=>{fail=true;},recover:()=>{fail=false;}});
const full = snapshot({});
exposeData({projectNames:full.byProject.filter(p=>p.tokens>0).map(p=>p.name), lastDay:full.byDay.at(-1)});
export default function Scenario() {
  return <div style={{height:'100vh',minWidth:0,display:'flex',flexDirection:'column',background:'var(--gren-content-bg)'}}><UsagePanel/></div>;
}
