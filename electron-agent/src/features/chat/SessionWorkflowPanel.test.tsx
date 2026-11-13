import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect,it,vi } from 'vitest';
import { SessionWorkflowPanel } from './SessionWorkflowPanel';
const tree={targetSessionPath:'/A',expectedSessionId:'A',expectedLeafId:'m',expectedRevision:'r',busy:false,needsReload:false,nodes:[{id:'m',parentId:null,type:'message',role:'user',preview:'原始正文',original:'原始正文',effective:'摘要',replaced:true,inContext:true,current:true,onBranch:true,legacyExcluded:false,children:[]}]};
it('context editor distinguishes raw/effective and confirms without rewriting original',async()=>{const request=vi.fn(async()=>({status:'ok',tree}));render(<SessionWorkflowPanel tree={tree} request={request as never} onApplied={()=>{}} tab="context"/>);fireEvent.click(screen.getByRole('radio'));expect(screen.getByText('摘要',{selector:'pre'})).toBeTruthy();fireEvent.change(screen.getByLabelText('替换文本'),{target:{value:'new'}});fireEvent.click(screen.getByText('保存替换'));await waitFor(()=>expect(request).toHaveBeenCalledWith(expect.objectContaining({action:'edit',entryId:'m',text:'new',expectedRevision:'r'})));});
it('legacy exclusion blocks replacement and explains the independent layer',()=>{const excluded={...tree,nodes:[{...tree.nodes[0],legacyExcluded:true}]};render(<SessionWorkflowPanel tree={excluded} request={vi.fn() as never} onApplied={()=>{}} tab="context"/>);fireEvent.click(screen.getByRole('radio'));expect(screen.getByText(/请先从原消息/)).toBeTruthy();expect((screen.getByText('保存替换').closest('button') as HTMLButtonElement).disabled).toBe(true);});



function chooseTreeRoot(){fireEvent.click(screen.getByRole('treeitem').querySelector('.ant-tree-node-content-wrapper')!);}
it('empty live draft defaults to replacing with the SDK editorText after navigation confirmation',async()=>{
 const request=vi.fn(async(r:{action:string})=>r.action==='navigate-preview'?{status:'ok',tree,targetLeafId:null,editorText:'原始正文'}:{status:'ok',tree});
 render(<SessionWorkflowPanel tree={tree} request={request as never} onApplied={()=>{}} readDraft={()=>({hasContent:false})}/>);chooseTreeRoot();fireEvent.click(screen.getByText('预览继续位置'));await screen.findByText('确认导航');fireEvent.click(screen.getByText('确认导航'));await waitFor(()=>expect(request).toHaveBeenCalledWith(expect.objectContaining({action:'navigate',draftChoice:'replace'})));
});
it('nonempty live draft requires an explicit keep/replace choice and cancel performs no navigation',async()=>{
 const request=vi.fn(async()=>({status:'ok',tree,targetLeafId:null,editorText:'原始正文'}));render(<SessionWorkflowPanel tree={tree} request={request as never} onApplied={()=>{}} readDraft={()=>({hasContent:true})}/>);chooseTreeRoot();fireEvent.click(screen.getByText('预览继续位置'));await screen.findByText('确认导航');expect((screen.getByText('确认导航').closest('button') as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByRole('button',{name:/^取\s*消$/}));expect(request.mock.calls).toHaveLength(1);
});
it('clone must preview the retained path before confirmation; cancellation has no clone request',async()=>{
 const request=vi.fn(async(r:{action:string})=>r.action==='clone-preview'?{status:'ok',scope:'当前分支',nodeCount:1,preview:[{id:'m',type:'message',preview:'原始正文'}],tree}:{status:'ok'});
 const applied=vi.fn();render(<SessionWorkflowPanel tree={tree} request={request as never} onApplied={applied}/>);fireEvent.click(screen.getByText('复制当前分支'));await screen.findByText('确认复制');expect(applied).not.toHaveBeenCalled();expect(request.mock.calls.map(([r])=>r.action)).toEqual(['clone-preview']);fireEvent.click(screen.getByText('取消复制'));expect(applied).not.toHaveBeenCalled();expect(request.mock.calls.map(([r])=>r.action)).toEqual(['clone-preview']);
});

