import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({rows:[{key:'p/org/A',provider:'p',modelId:'org/A',matched:true,desktop:{},inherited:{reserveTokens:1000,keepRecentTokens:2000},effective:{reserveTokens:1000,keepRecentTokens:2000},sources:{reserveTokens:'ordinary',keepRecentTokens:'default'},contextWindow:4000}],sync:{sessions:[]}}));
const bridge=vi.hoisted(()=>({getModelCompactionBudgets:vi.fn(async()=>structuredClone(state)),patchModelCompactionBudget:vi.fn(async(_p:string,_m:string,patch:any)=>{const row=state.rows[0] as any;for(const [key,value]of Object.entries(patch)){if(value===null)delete row.desktop[key];else row.desktop[key]=value;}row.effective={...row.inherited,...row.desktop};return structuredClone(state);}),clearModelCompactionBudget:vi.fn(async()=>structuredClone(state)),syncModelCompactionBudgets:vi.fn(async()=>({sessions:[]}))}));
vi.mock('../../lib/pi',()=>({pi:bridge}));
import {ModelCompactionBudgetsSettings} from './ModelCompactionBudgetsSettings';
afterEach(()=>{cleanup();vi.clearAllMocks();state.rows[0].desktop={};});
it('does not save on mount, validates raw integers and sends only the touched field including explicit zero and clear',async()=>{
 render(<ModelCompactionBudgetsSettings/>);const reserve=await screen.findByTestId('budget-reserveTokens');
 expect(bridge.patchModelCompactionBudget).not.toHaveBeenCalled();expect(screen.getByTestId('budget-save')).toBeDisabled();
 fireEvent.change(reserve,{target:{value:'1.5'}});expect(screen.getByTestId('budget-save')).toBeDisabled();expect(screen.getByRole('alert').textContent).toContain('非负安全整数');
 fireEvent.change(reserve,{target:{value:'0'}});fireEvent.click(screen.getByTestId('budget-save'));
 await waitFor(()=>expect(bridge.patchModelCompactionBudget).toHaveBeenCalledWith('p','org/A',{reserveTokens:0}));
 await waitFor(()=>expect(screen.getByTestId('budget-save')).toBeDisabled());
 fireEvent.change(screen.getByTestId('budget-reserveTokens'),{target:{value:''}});fireEvent.click(screen.getByTestId('budget-save'));
 await waitFor(()=>expect(bridge.patchModelCompactionBudget).toHaveBeenLastCalledWith('p','org/A',{reserveTokens:null}));
});
it('a failed save keeps the draft; retry synchronization does not persist or clear it',async()=>{
 bridge.patchModelCompactionBudget.mockRejectedValueOnce(new Error('fixture disk denied'));
 render(<ModelCompactionBudgetsSettings/>);const input=await screen.findByTestId('budget-reserveTokens');fireEvent.change(input,{target:{value:'123'}});fireEvent.click(screen.getByTestId('budget-save'));
 await screen.findByText('fixture disk denied');expect((input as HTMLInputElement).value).toBe('123');expect(screen.getByTestId('budget-save')).not.toBeDisabled();
});
