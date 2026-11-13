import {afterEach,expect,it} from 'vitest';
import {readComposerSnapshot,registerComposerSnapshot} from './composerBridge';
afterEach(()=>registerComposerSnapshot(null));
it('reads the current editor snapshot rather than a debounced stored draft',()=>{let text='first';registerComposerSnapshot(()=>({ownerKey:'A',text,hasContent:text.length>0}));text='latest unsaved editor';expect(readComposerSnapshot()).toEqual({ownerKey:'A',text:'latest unsaved editor',hasContent:true});});
it('keeps the reader owner explicit and can report attachment-only drafts',()=>{registerComposerSnapshot(()=>({ownerKey:'B',text:'',hasContent:true}));expect(readComposerSnapshot()).toMatchObject({ownerKey:'B',text:'',hasContent:true});registerComposerSnapshot(null);expect(readComposerSnapshot()).toBeNull();});
