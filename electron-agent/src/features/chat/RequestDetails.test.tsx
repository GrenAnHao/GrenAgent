import {act,cleanup,render,screen,fireEvent,waitFor}from'@testing-library/react';import{afterEach,expect,it,vi}from'vitest';
const subscriptions=vi.hoisted(()=>new Map<string,Function>());
const api=vi.hoisted(()=>({requestObservation:vi.fn(),exportRequestObservation:vi.fn(async()=>({saved:true}))}));
vi.mock('../../lib/pi',()=>({pi:api}));vi.mock('../../platform/runtime',()=>({listen:vi.fn(async(name:string,fn:Function)=>{subscriptions.set(name,fn);return()=>subscriptions.delete(name);})}));
import{RequestObservationDetails,WarmingDetails}from'./RequestDetails';import{useRequestObservations}from'../../stores/requestObservations';
afterEach(()=>{cleanup();useRequestObservations.setState({byId:{}});vi.clearAllMocks();subscriptions.clear();});
const observation:any={identity:{sessionId:'a',requestId:'r',runtimeGeneration:'g'},sequence:1,observedAt:1,phase:'response',attempt:1,provider:'p',api:'api',requestedModel:'alias',startedAt:1,availability:'supported',responses:[{attempt:1,metadata:{httpStatus:429,providerRequestId:'safe',rateLimit:{'retry-after':'2'}}}],outcome:{responseModel:'actual',costTotal:0.12,costSource:'provider'},collecting:false,events:[],previewVersion:0};
it('keeps zero/unknown distinct, uses final extension override rather than original advice',()=>{
 render(<WarmingDetails snapshot={{availability:'supported',status:{state:'inactive',reason:'stopped by extension',extensionOverride:true,decision:{warmCost:0,action:'warm'}}}}/>);
 expect(screen.getByText('$0.000000 USD')).toBeTruthy();expect(screen.getByText('停止 · 扩展覆盖')).toBeTruthy();expect(screen.getAllByText('未知').length).toBeGreaterThan(0);
});
it('shows both models, explicit collection and frozen preview export; cleanup clears scope',async()=>{
 api.requestObservation.mockImplementation(async(p:any)=>p.action==='list'?[observation]:p.action==='warming'?{availability:'unavailable'}:p.action==='preview'?{previewId:'frozen',events:[{type:'text_delta',text:'[redacted]'}]}:true);
 const view=render(<RequestObservationDetails sessionId="a" requestId="r"/>);await screen.findByText('alias');expect(screen.getByText('actual')).toBeTruthy();expect(screen.getByText(/HTTP 429/)).toBeTruthy();
 fireEvent.click(screen.getByRole('switch'));await waitFor(()=>expect(api.requestObservation).toHaveBeenCalledWith(expect.objectContaining({action:'collect',enabled:true,identity:observation.identity})));
 fireEvent.click(screen.getByText('脱敏预览'));await screen.findByTestId('request-structure-preview');fireEvent.click(screen.getByText('导出此预览'));await waitFor(()=>expect(api.exportRequestObservation).toHaveBeenCalledWith('frozen'));
 view.unmount();expect(api.requestObservation).toHaveBeenCalledWith(expect.objectContaining({action:'clear',identity:observation.identity}));
});
it('only queries warming while details are mounted, at most once per second',async()=>{
 api.requestObservation.mockImplementation(async(p:any)=>p.action==='list'?[]:{availability:'unavailable'});const view=render(<RequestObservationDetails sessionId="a"/>);
 await waitFor(()=>expect(api.requestObservation).toHaveBeenCalledWith(expect.objectContaining({action:'warming'})));await new Promise(r=>setTimeout(r,1100));
 const count=api.requestObservation.mock.calls.filter(([p]:any)=>p.action==='warming').length;expect(count).toBe(2);view.unmount();await new Promise(r=>setTimeout(r,1100));expect(api.requestObservation.mock.calls.filter(([p]:any)=>p.action==='warming')).toHaveLength(count);
});

it('host exit clears only its own scope preview and makes the request unavailable',async()=>{
 api.requestObservation.mockImplementation(async(p:any)=>p.action==='list'?[observation]:p.action==='preview'?{previewId:'exit-preview',events:[{index:1}]}:{availability:'unavailable'});
 render(<RequestObservationDetails workspace="/owned" sessionId="a" requestId="r"/>);await screen.findByText('alias');fireEvent.click(screen.getByText('脱敏预览'));await screen.findByTestId('request-structure-preview');
 await act(async()=>subscriptions.get('pi://exit')?.({payload:{workspace:'/other'}}));expect(screen.getByTestId('request-structure-preview')).toBeTruthy();
 await act(async()=>subscriptions.get('pi://exit')?.({payload:{workspace:'/owned'}}));expect(screen.queryByTestId('request-structure-preview')).toBeNull();expect(useRequestObservations.getState().byId[JSON.stringify(['a','g','r'])]).toMatchObject({availability:'unavailable',collecting:false,events:[]});
});
