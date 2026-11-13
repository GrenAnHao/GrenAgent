import { registerLazyOAuthFlows } from "@earendil-works/pi-ai/lazy-oauth";
import { registerLazyBedrockProvider } from "@earendil-works/pi-ai/lazy-bedrock-provider";

// Node-only: retain literal import() boundaries in standalone desktop bundles.
// Registration installs loaders only; flows and the AWS SDK stay unloaded until used.
registerLazyOAuthFlows();
registerLazyBedrockProvider();
