import { collapseVariantId } from "./vendor/catalog/compat/taxonomy.ts";
import { clampThinkingLevelForModel, resolveWireModelId } from "./vendor/catalog/model-thinking.ts";

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORT_ORDER)[number];

export interface CursorWireModel {
	id: string;
	requestModelId?: string;
	thinking?: {
		efforts?: readonly string[];
		effortRouting?: Partial<Record<Effort | "off", string>>;
	};
}

export function resolveCursorWireModelId(
	model: CursorWireModel,
	effort: Effort | "off",
	requestedId = model.id,
): string {
	if (effort === "off") {
		return resolveWireModelId(routable(model), undefined);
	}
	const logicalId = collapseVariantId("cursor", requestedId).logicalId;
	const requestModelId =
		model.requestModelId === undefined
			? logicalId
			: collapseVariantId("cursor", model.requestModelId).logicalId;
	const routed = routable({ ...model, id: logicalId, requestModelId });
	return resolveWireModelId(routed, clampThinkingLevelForModel(routed, effort));
}

function routable(model: CursorWireModel) {
	return {
		id: model.id,
		requestModelId: model.requestModelId,
		reasoning: true,
		thinking: model.thinking,
	};
}
