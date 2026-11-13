import {readComposerSnapshot,setComposerValue} from './input/composerBridge';
import {useComposerFilesStore} from './input/composerFiles';
import {useChatDraftStore} from '../../stores/chatDraftStore';
/** A confirmed replacement owns exactly one composer bucket; an unrelated mounted editor is untouched. */
export function applyNavigationDraft(ownerKey:string,text:string):void{
  useComposerFilesStore.getState().clear(ownerKey);
  useChatDraftStore.getState().setDraft(ownerKey,text);
  if(readComposerSnapshot()?.ownerKey===ownerKey)setComposerValue(text);
}
