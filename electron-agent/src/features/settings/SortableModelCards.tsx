import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ProviderModelCard } from './ProviderModelCard';
import type { UiModel } from './providerConfigAdapter';

type KeyedModel = UiModel & { _uid: string };

/** 模型卡片是单列，拖动只沿竖直方向。 */
const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/** 把 activeId 那一项挪到 overId 的位置；任一找不到或没动时原样返回同一个数组。 */
export function moveById<T extends { _uid: string }>(items: T[], activeId: string, overId: string | undefined): T[] {
  if (!overId || activeId === overId) return items;
  const from = items.findIndex((m) => m._uid === activeId);
  const to = items.findIndex((m) => m._uid === overId);
  if (from < 0 || to < 0) return items;
  return arrayMove(items, from, to);
}

interface SortableModelCardProps {
  model: KeyedModel;
  index: number;
  api: string | undefined;
  expanded: boolean;
  markEmptyId?: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<UiModel>) => void;
  onRemove: () => void;
}

function SortableModelCard({ model, ...rest }: SortableModelCardProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: model._uid,
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        position: 'relative',
        zIndex: isDragging ? 1 : undefined,
        opacity: isDragging ? 0.85 : undefined,
        transform: CSS.Translate.toString(transform),
        transition,
      }}
    >
      <ProviderModelCard model={model} dragHandle={{ ref: setActivatorNodeRef, attributes, listeners }} {...rest} />
    </div>
  );
}

export interface SortableModelCardsProps<M extends KeyedModel> {
  models: M[];
  api: string | undefined;
  expanded: Record<string, boolean>;
  /** 保存被空模型 ID 拦下后为 true：ID 为空的卡片标红。 */
  markEmptyIds?: boolean;
  onToggle: (uid: string) => void;
  onChange: (index: number, patch: Partial<UiModel>) => void;
  onRemove: (index: number) => void;
  onReorder: (models: M[]) => void;
}

/** 供应商的模型列表：只有卡片左侧的手柄能拖，卡片里的输入框照常可点可选。 */
export function SortableModelCards<M extends KeyedModel>({
  models,
  api,
  expanded,
  markEmptyIds = false,
  onToggle,
  onChange,
  onRemove,
  onReorder,
}: SortableModelCardsProps<M>) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const next = moveById(models, String(active.id), over ? String(over.id) : undefined);
    if (next !== models) onReorder(next);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[verticalOnly]} onDragEnd={onDragEnd}>
      <SortableContext items={models.map((m) => m._uid)} strategy={verticalListSortingStrategy}>
        {models.map((m, i) => (
          <SortableModelCard
            key={m._uid}
            model={m}
            index={i}
            api={api}
            expanded={!!expanded[m._uid]}
            markEmptyId={markEmptyIds}
            onToggle={() => onToggle(m._uid)}
            onChange={(patch) => onChange(i, patch)}
            onRemove={() => onRemove(i)}
          />
        ))}
      </SortableContext>
    </DndContext>
  );
}
