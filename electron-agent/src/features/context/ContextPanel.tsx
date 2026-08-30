import { useState } from 'react';
import { Flexbox, Text, List, Empty, type ListItemProps } from '@lobehub/ui';

interface ContextFile {
  path: string;
  content?: string;
}

export function ContextPanel() {
  const [files] = useState<ContextFile[]>([]);

  const items: ListItemProps[] = files.map((file) => ({
    key: file.path,
    title: file.path,
  }));

  return (
    <Flexbox height="100%" style={{ minHeight: 0 }}>
      <Flexbox padding={12} flex="0 0 auto">
        <Text strong>Context</Text>
      </Flexbox>

      <Flexbox flex={1} style={{ minHeight: 0, overflowY: 'auto' }}>
        {items.length === 0 ? (
          <Empty description="No context files" />
        ) : (
          <List items={items} />
        )}
      </Flexbox>
    </Flexbox>
  );
}
