import { useRef, type ChangeEvent } from 'react';
import { ActionIcon } from '@lobehub/ui';
import { ImagePlus } from 'lucide-react';
import { useChatInput } from '../ChatInputContext';
import { fileToImageAttachment } from '../editor/imageAttachment';

export default function UploadAction() {
  const { addAttachments } = useChatInput();
  const inputRef = useRef<HTMLInputElement>(null);

  const onChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) {
      addAttachments(await Promise.all(files.map(fileToImageAttachment)));
    }
    e.target.value = '';
  };

  return (
    <>
      <ActionIcon
        icon={ImagePlus}
        size="small"
        title="添加图片"
        onClick={() => inputRef.current?.click()}
      />
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={onChange}
      />
    </>
  );
}
